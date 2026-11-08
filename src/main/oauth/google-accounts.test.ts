import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type DatabaseSync } from 'node:sqlite';
import { readAccountRefreshToken } from '../persistence/credentials.ts';
import { openAuroraDatabase } from '../persistence/database.ts';
import { type SecretCipher } from '../persistence/safe-storage-cipher.ts';
import {
  createConnectedAccount,
  createOAuthClient,
  getConnectedAccount
} from '../persistence/accounts.ts';
import { OAuthFlowError } from './errors.ts';
import { createGoogleAccountService } from './google-accounts.ts';
import { googleScopes } from './google-flow.ts';

const directories: string[] = [];
const databases: DatabaseSync[] = [];
const clientId = 'desktop-client.apps.googleusercontent.com';
const now = new Date('2026-11-02T12:00:00.000Z');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk: JsonWebKey = publicKey.export({ format: 'jwk' });
publicJwk.kid = 'test-key';

function openTemp(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), 'aurora-google-flow-'));
  directories.push(directory);
  const database = openAuroraDatabase(join(directory, 'aurora.sqlite'));
  databases.push(database);
  return database;
}

after(() => {
  for (const database of databases) database.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function xorCipher(shouldFail: () => boolean): SecretCipher {
  return {
    encrypt(plaintext: string): Buffer {
      const bytes = Buffer.from(plaintext, 'utf8');
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = (bytes[index] ?? 0) ^ 0x5a;
      return bytes;
    },
    decrypt(ciphertext: Buffer): string {
      if (shouldFail()) throw new Error('decrypt');
      const bytes = Buffer.from(ciphertext);
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = (bytes[index] ?? 0) ^ 0x5a;
      return bytes.toString('utf8');
    }
  };
}

function idToken(nonce: string, sub: string, name: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString(
    'base64url'
  );
  const body = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: clientId,
      exp: Math.floor(now.getTime() / 1000) + 600,
      iat: Math.floor(now.getTime() / 1000),
      nonce,
      sub,
      email: `${sub}@example.com`,
      email_verified: true,
      name
    })
  ).toString('base64url');
  const data = `${header}.${body}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

function ask(url: string): Promise<void> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET'
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve());
      }
    );
    req.on('error', reject);
    req.end();
  });
}

interface Mode {
  refreshToken: string | null;
  sub: string;
  name: string;
  tokenError: string | null;
  hangToken: boolean;
  revoke: 'ok' | 'hang' | 'throw' | 'denied';
  iss: string | null;
  grantedScope: string;
  expiresIn: number | null;
}

function harness(input: { flowTimeoutMs?: number; revokeTimeoutMs?: number } = {}) {
  const database = openTemp();
  let failDecrypt = false;
  const cipher = xorCipher(() => failDecrypt);
  let resolveOpened: (url: string) => void = () => undefined;
  let opened = Promise.resolve('');
  const fetchCalls: string[] = [];
  const revokeBodies: string[] = [];
  const tokenBodies: string[] = [];
  const mode: Mode = {
    refreshToken: 'refresh-token-one',
    sub: 'google-user-1',
    name: 'Ada',
    tokenError: null,
    hangToken: false,
    revoke: 'ok',
    iss: null,
    grantedScope: 'openid email profile https://www.googleapis.com/auth/gmail.modify',
    expiresIn: null
  };
  const fetchImpl: typeof fetch = async (inputUrl, init) => {
    const url =
      typeof inputUrl === 'string'
        ? inputUrl
        : inputUrl instanceof URL
          ? inputUrl.href
          : inputUrl.url;
    fetchCalls.push(url);
    if (url.endsWith('/token')) {
      const body = init?.body;
      tokenBodies.push(body instanceof URLSearchParams ? body.toString() : '');
    }
    if (url.endsWith('/revoke')) {
      const body = init?.body;
      revokeBodies.push(body instanceof URLSearchParams ? body.toString() : '');
      if (mode.revoke === 'throw') throw new Error('offline refresh-token-one');
      if (mode.revoke === 'hang') {
        return new Promise((_resolve, reject) => {
          const keepAlive = setTimeout(() => {
            reject(new Error('not aborted'));
          }, 1_000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            reject(new Error('aborted'));
          });
        });
      }
      return new Response(null, { status: mode.revoke === 'denied' ? 400 : 200 });
    }
    if (mode.hangToken) {
      return new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => {
          reject(new Error('not aborted'));
        }, 1_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(new Error('aborted'));
        });
      });
    }
    if (mode.tokenError === 'network') throw new Error('offline refresh-token-one');
    if (mode.tokenError !== null) {
      return Response.json(
        { error: mode.tokenError, error_description: 'refresh-token-one' },
        { status: 400 }
      );
    }
    const auth = new URL(openedUrl);
    const nonce = auth.searchParams.get('nonce') ?? '';
    const body: Record<string, string | number> = {
      id_token: idToken(nonce, mode.sub, mode.name),
      access_token: 'access-token-value',
      scope: mode.grantedScope
    };
    if (mode.expiresIn !== null) body.expires_in = mode.expiresIn;
    if (mode.refreshToken !== null) body.refresh_token = mode.refreshToken;
    return Response.json(body);
  };
  let openedUrl = '';
  const service = createGoogleAccountService({
    database,
    cipher,
    fetchImpl,
    openExternal: async (url) => {
      openedUrl = url;
      resolveOpened(url);
    },
    jwks: {
      async getKey(kid: string) {
        return kid === 'test-key' ? publicJwk : null;
      }
    },
    now: () => now,
    flowTimeoutMs: input.flowTimeoutMs,
    revokeTimeoutMs: input.revokeTimeoutMs
  });
  function arm(): void {
    opened = new Promise((resolve) => {
      resolveOpened = resolve;
    });
  }
  return {
    database,
    cipher,
    service,
    fetchCalls,
    revokeBodies,
    tokenBodies,
    mode,
    arm,
    failDecrypt(value: boolean) {
      failDecrypt = value;
    },
    untilOpened(): Promise<string> {
      return opened;
    },
    async callback(): Promise<string> {
      const url = await opened;
      const auth = new URL(url);
      const redirect = auth.searchParams.get('redirect_uri') ?? '';
      const state = auth.searchParams.get('state') ?? '';
      const issuer = mode.iss === null ? '' : `&iss=${encodeURIComponent(mode.iss)}`;
      await ask(`${redirect}?code=auth-code-value&state=${state}${issuer}`);
      return url;
    }
  };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof OAuthFlowError);
    return error.code;
  }
  assert.fail('expected rejection');
}

function savedToken(database: DatabaseSync, cipher: SecretCipher, accountId: string): string {
  return readAccountRefreshToken(database, cipher, accountId);
}

describe('Google account service', () => {
  it('connects a new account and preserves the token when Google omits a replacement', async () => {
    const flow = harness();
    flow.service.saveClientId(clientId);
    const logs: string[] = [];
    const printable = (value: unknown): string => {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return `${value}`;
      }
      return '';
    };
    const original = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      debug: console.debug.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    };
    console.log = (...args: unknown[]) => {
      logs.push(args.map(printable).join(' '));
    };
    console.info = (...args: unknown[]) => {
      logs.push(args.map(printable).join(' '));
    };
    console.debug = (...args: unknown[]) => {
      logs.push(args.map(printable).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      logs.push(args.map(printable).join(' '));
    };
    console.error = (...args: unknown[]) => {
      logs.push(args.map(printable).join(' '));
    };
    try {
      flow.arm();
      const pending = flow.service.connect();
      const url = await flow.callback();
      const account = await pending;
      const auth = new URL(url);
      assert.deepEqual(auth.searchParams.get('scope')?.split(' '), [...googleScopes]);
      assert.equal(auth.searchParams.get('include_granted_scopes'), null);
      assert.equal(account.email, 'google-user-1@example.com');
      assert.equal(account.status, 'connected');
      assert.equal(savedToken(flow.database, flow.cipher, account.id), 'refresh-token-one');
      assert.throws(
        () => flow.service.saveClientId('other-client.apps.googleusercontent.com'),
        (error: unknown) => error instanceof OAuthFlowError && error.code === 'client-in-use'
      );
      const text = logs.join('\n');
      for (const secret of [
        'refresh-token-one',
        'auth-code-value',
        'access-token-value',
        auth.searchParams.get('state') ?? ''
      ]) {
        assert.equal(text.includes(secret), false);
      }
      flow.mode.refreshToken = null;
      flow.mode.name = 'Ada Lovelace';
      flow.fetchCalls.length = 0;
      flow.arm();
      const again = flow.service.connect();
      await flow.callback();
      const updated = await again;
      assert.equal(updated.id, account.id);
      assert.equal(updated.displayName, 'Ada Lovelace');
      assert.equal(savedToken(flow.database, flow.cipher, account.id), 'refresh-token-one');
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.debug = original.debug;
      console.warn = original.warn;
      console.error = original.error;
    }
  });

  it('rejects a new account without a refresh token and a bad authorization issuer', async () => {
    const flow = harness();
    flow.service.saveClientId(clientId);
    flow.mode.refreshToken = null;
    flow.arm();
    const missing = codeOf(flow.service.connect());
    await flow.callback();
    assert.equal(await missing, 'provider-rejected');
    assert.equal(flow.service.listAccounts().length, 0);
    flow.mode.refreshToken = 'refresh-token-one';
    flow.mode.iss = 'https://evil.example';
    flow.fetchCalls.length = 0;
    flow.arm();
    const rejected = codeOf(flow.service.connect());
    await flow.callback();
    assert.equal(await rejected, 'provider-rejected');
    assert.equal(
      flow.fetchCalls.some((url) => url.includes('/token')),
      false
    );
    assert.equal(flow.service.listAccounts().length, 0);
  });

  it('keeps the original account when reconnect selects a different subject or cannot read the token', async () => {
    const flow = harness();
    flow.service.saveClientId(clientId);
    flow.arm();
    const created = await (async () => {
      const pending = flow.service.connect();
      await flow.callback();
      return pending;
    })();
    flow.mode.sub = 'google-user-2';
    flow.mode.refreshToken = 'refresh-token-two';
    flow.arm();
    const mismatch = codeOf(flow.service.reconnect(created.id));
    await flow.callback();
    assert.equal(await mismatch, 'account-mismatch');
    assert.equal(savedToken(flow.database, flow.cipher, created.id), 'refresh-token-one');
    assert.equal(flow.service.listAccounts().length, 1);
    flow.mode.sub = 'google-user-1';
    flow.mode.refreshToken = null;
    flow.failDecrypt(true);
    flow.arm();
    const unusable = codeOf(flow.service.reconnect(created.id));
    await flow.callback();
    assert.equal(await unusable, 'needs-reauth');
    assert.equal(getConnectedAccount(flow.database, created.id).status, 'connected');
    flow.failDecrypt(false);
    assert.equal(savedToken(flow.database, flow.cipher, created.id), 'refresh-token-one');
  });

  it('blocks disconnect and reconnect while another account operation is in progress', async () => {
    const flow = harness({ revokeTimeoutMs: 300 });
    flow.service.saveClientId(clientId);
    flow.arm();
    const connected = flow.service.connect();
    await flow.callback();
    const account = await connected;
    flow.mode.revoke = 'hang';
    const disconnecting = flow.service.disconnect(account.id);
    assert.equal(await codeOf(flow.service.reconnect(account.id)), 'operation-in-progress');
    assert.equal(await codeOf(flow.service.connect()), 'operation-in-progress');
    assert.equal(flow.revokeBodies[0]?.includes('refresh-token-one'), true);
    assert.equal(getConnectedAccount(flow.database, account.id).id, account.id);
    assert.deepEqual(await disconnecting, { outcome: 'disconnected-local' });
    assert.throws(() => getConnectedAccount(flow.database, account.id));
  });

  it('cancels an authorization on timeout, shutdown, and a second connect', async () => {
    const flow = harness({ flowTimeoutMs: 200 });
    flow.service.saveClientId(clientId);
    flow.arm();
    const timedOut = codeOf(flow.service.connect());
    assert.equal(await timedOut, 'oauth-timeout');
    const steady = harness();
    steady.service.saveClientId(clientId);
    steady.arm();
    const first = codeOf(steady.service.connect());
    await steady.untilOpened();
    steady.service.shutdown();
    assert.equal(await first, 'oauth-cancelled');
    const replaced = harness();
    replaced.service.saveClientId(clientId);
    replaced.arm();
    const older = codeOf(replaced.service.connect());
    await replaced.untilOpened();
    replaced.arm();
    const newer = replaced.service.connect();
    assert.equal(await older, 'oauth-cancelled');
    await replaced.callback();
    assert.equal((await newer).status, 'connected');
  });

  it('refreshes, rotates, and retires a revoked credential', async () => {
    const flow = harness();
    flow.service.saveClientId(clientId);
    flow.arm();
    const pending = flow.service.connect();
    await flow.callback();
    const account = await pending;
    flow.mode.refreshToken = null;
    await flow.service.refreshAccount(account.id);
    assert.equal(savedToken(flow.database, flow.cipher, account.id), 'refresh-token-one');
    flow.mode.refreshToken = 'refresh-token-rotated';
    await flow.service.refreshAccount(account.id);
    assert.equal(savedToken(flow.database, flow.cipher, account.id), 'refresh-token-rotated');
    flow.mode.tokenError = 'network';
    assert.equal(await codeOf(flow.service.refreshAccount(account.id)), 'network');
    assert.equal(savedToken(flow.database, flow.cipher, account.id), 'refresh-token-rotated');
    flow.mode.tokenError = 'invalid_grant';
    assert.equal(await codeOf(flow.service.refreshAccount(account.id)), 'needs-reauth');
    assert.equal(getConnectedAccount(flow.database, account.id).status, 'needs_reauth');
    assert.throws(() => savedToken(flow.database, flow.cipher, account.id));
  });

  it('disconnects locally when revocation fails and when the token cannot be read', async () => {
    const flow = harness();
    flow.service.saveClientId(clientId);
    flow.arm();
    const firstPending = flow.service.connect();
    await flow.callback();
    const first = await firstPending;
    flow.mode.revoke = 'throw';
    assert.deepEqual(await flow.service.disconnect(first.id), { outcome: 'disconnected-local' });
    flow.mode.sub = 'google-user-2';
    flow.mode.refreshToken = 'refresh-token-two';
    flow.mode.revoke = 'ok';
    flow.arm();
    const secondPending = flow.service.connect();
    await flow.callback();
    const second = await secondPending;
    flow.failDecrypt(true);
    flow.revokeBodies.length = 0;
    assert.deepEqual(await flow.service.disconnect(second.id), { outcome: 'disconnected-local' });
    assert.equal(flow.revokeBodies.length, 0);
    assert.equal(flow.service.listAccounts().length, 0);
  });

  it('covers denied consent, cancellation during exchange, and accounts from another provider', async () => {
    const bare = harness();
    assert.deepEqual(bare.service.getClientId(), { clientId: null, secretConfigured: false });
    assert.deepEqual(bare.service.cancel(), { cancelled: true });
    assert.equal(await codeOf(bare.service.connect()), 'needs-client');
    bare.service.saveClientId(clientId);
    const spotify = createOAuthClient(bare.database, {
      provider: 'spotify',
      clientId: 'spotify-client'
    });
    const foreign = createConnectedAccount(bare.database, {
      provider: 'spotify',
      providerAccountId: 'spotify-user',
      displayName: null,
      email: null,
      status: 'connected',
      oauthClientId: spotify.id
    });
    assert.equal(await codeOf(bare.service.reconnect(foreign.id)), 'invalid-request');
    assert.equal(await codeOf(bare.service.disconnect(foreign.id)), 'invalid-request');
    assert.equal(
      await codeOf(bare.service.reconnect('00000000-0000-4000-8000-000000000099')),
      'invalid-request'
    );

    const denied = harness();
    denied.service.saveClientId(clientId);
    denied.arm();
    const deniedResult = codeOf(denied.service.connect());
    const deniedUrl = new URL(await denied.untilOpened());
    const redirect = deniedUrl.searchParams.get('redirect_uri') ?? '';
    const state = deniedUrl.searchParams.get('state') ?? '';
    await ask(`${redirect}?error=access_denied&state=${state}`);
    assert.equal(await deniedResult, 'oauth-denied');

    const exchanging = harness();
    exchanging.service.saveClientId(clientId);
    exchanging.mode.hangToken = true;
    exchanging.arm();
    const exchangingResult = codeOf(exchanging.service.connect());
    await exchanging.callback();
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    assert.deepEqual(exchanging.service.cancel(), { cancelled: true });
    assert.equal(await exchangingResult, 'oauth-cancelled');

    const revoked = harness();
    revoked.service.saveClientId(clientId);
    revoked.arm();
    const connected = revoked.service.connect();
    await revoked.callback();
    const account = await connected;
    assert.deepEqual(await revoked.service.disconnect(account.id), { outcome: 'revoked' });
    revoked.service.shutdown();
  });

  it('sends a stored client secret on exchange and refresh without returning it', async () => {
    const flow = harness();
    const saved = flow.service.saveClientId(clientId, 'client-secret-value');
    assert.deepEqual(saved, { clientId, secretConfigured: true });
    assert.equal(JSON.stringify(flow.service.getClientId()).includes('client-secret-value'), false);
    const kept = flow.service.saveClientId(clientId, null);
    assert.equal(kept.secretConfigured, true);
    flow.arm();
    const pending = flow.service.connect();
    await flow.callback();
    const account = await pending;
    assert.equal(
      flow.tokenBodies.some((body) => body.includes('client_secret=client-secret-value')),
      true
    );
    assert.equal(
      flow.tokenBodies.some((body) => body.includes('code_verifier=')),
      true
    );
    await flow.service.refreshAccount(account.id);
    assert.equal(
      flow.tokenBodies
        .filter((body) => body.includes('grant_type=refresh_token'))
        .some((body) => body.includes('client_secret=client-secret-value')),
      true
    );
    const plain = harness();
    plain.service.saveClientId(clientId, null);
    plain.arm();
    const plainPending = plain.service.connect();
    await plain.callback();
    await plainPending;
    assert.equal(
      plain.tokenBodies.some((body) => body.includes('client_secret=')),
      false
    );
  });

  it('keeps a saved account when the new grant cannot change mail and drops the cached token after success', async () => {
    const flow = harness();
    flow.service.saveClientId(clientId);
    flow.mode.grantedScope = 'openid email profile https://www.googleapis.com/auth/gmail.readonly';
    flow.arm();
    const denied = codeOf(flow.service.connect());
    await flow.callback();
    assert.equal(await denied, 'scope-denied');
    assert.equal(flow.service.listAccounts().length, 0);
    flow.mode.grantedScope = 'openid email profile https://www.googleapis.com/auth/gmail.modify';
    flow.arm();
    const pending = flow.service.connect();
    await flow.callback();
    const account = await pending;
    assert.equal(account.canModifyMail, true);
    flow.mode.expiresIn = 3600;
    const tokenCalls = () => flow.fetchCalls.filter((url) => url.endsWith('/token')).length;
    const before = tokenCalls();
    assert.equal(await flow.service.mailboxAccess(account.id), 'access-token-value');
    assert.equal(tokenCalls(), before + 1);
    assert.equal(await flow.service.mailboxAccess(account.id), 'access-token-value');
    assert.equal(tokenCalls(), before + 1);
    flow.mode.refreshToken = 'refresh-token-two';
    flow.arm();
    const reconnected = flow.service.reconnect(account.id);
    await flow.callback();
    assert.equal((await reconnected).canModifyMail, true);
    assert.equal(savedToken(flow.database, flow.cipher, account.id), 'refresh-token-two');
    assert.equal(await flow.service.mailboxAccess(account.id), 'access-token-value');
    assert.equal(tokenCalls(), before + 3);
    flow.mode.grantedScope = 'openid email profile';
    flow.mode.refreshToken = 'refresh-token-three';
    flow.arm();
    const narrowed = codeOf(flow.service.reconnect(account.id));
    await flow.callback();
    assert.equal(await narrowed, 'scope-denied');
    assert.equal(savedToken(flow.database, flow.cipher, account.id), 'refresh-token-two');
    assert.equal(flow.service.listAccounts()[0]?.canModifyMail, true);
    flow.arm();
    const cancelled = codeOf(flow.service.reconnect(account.id));
    await flow.untilOpened();
    assert.deepEqual(flow.service.cancel(), { cancelled: true });
    assert.equal(await cancelled, 'oauth-cancelled');
    assert.equal(savedToken(flow.database, flow.cipher, account.id), 'refresh-token-two');
  });
});
