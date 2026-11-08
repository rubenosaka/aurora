import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type DatabaseSync } from 'node:sqlite';
import { readAccountRefreshToken, saveAccountRefreshToken } from '../persistence/credentials.ts';
import { openAuroraDatabase } from '../persistence/database.ts';
import { type SecretCipher } from '../persistence/safe-storage-cipher.ts';
import {
  createConnectedAccount,
  createOAuthClient,
  getConnectedAccount
} from '../persistence/accounts.ts';
import { OAuthFlowError } from '../oauth/errors.ts';
import { createGoogleAccountService } from '../oauth/google-accounts.ts';
import { PersistenceError } from '../persistence/errors.ts';
import { GmailError } from './errors.ts';
import { createGmailReader, type GmailReader } from './reader.ts';
import { parseGmailThreadList } from '../../shared/gmail.ts';

function requestUrl(url: RequestInfo | URL): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

function formField(init: RequestInit | undefined, name: string): string | null {
  const body = init?.body;
  if (typeof body === 'string' || body instanceof URLSearchParams) {
    return new URLSearchParams(body).get(name);
  }
  return null;
}

const directories: string[] = [];
const databases: DatabaseSync[] = [];
const clientId = 'desktop-client.apps.googleusercontent.com';
const labelsBody = {
  labels: [
    { id: 'INBOX', name: 'INBOX', type: 'system', messagesUnread: 1 },
    { id: 'CATEGORY_PERSONAL', name: 'CATEGORY_PERSONAL', type: 'system' },
    { id: 'Label_1', name: 'Trips', type: 'user', messagesUnread: 0 }
  ]
};

function cipher(): SecretCipher {
  return {
    encrypt(plaintext: string): Buffer {
      const bytes = Buffer.from(plaintext, 'utf8');
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = (bytes[index] ?? 0) ^ 0x5a;
      return bytes;
    },
    decrypt(ciphertext: Buffer): string {
      const bytes = Buffer.from(ciphertext);
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = (bytes[index] ?? 0) ^ 0x5a;
      return bytes.toString('utf8');
    }
  };
}

function openTemp(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), 'aurora-gmail-'));
  directories.push(directory);
  const database = openAuroraDatabase(join(directory, 'aurora.sqlite'));
  databases.push(database);
  return database;
}

after(() => {
  for (const database of databases) database.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function seed(
  database: DatabaseSync,
  secret: SecretCipher,
  subject: string,
  refresh: string,
  grantedScopes?: string
): string {
  const existing = database
    .prepare("SELECT id FROM oauth_clients WHERE provider = 'google'")
    .get() as { id: string } | undefined;
  const client =
    existing === undefined
      ? createOAuthClient(database, { provider: 'google', clientId })
      : { id: existing.id };
  const account = createConnectedAccount(database, {
    provider: 'google',
    providerAccountId: subject,
    displayName: subject,
    email: `${subject}@example.com`,
    status: 'connected',
    oauthClientId: client.id,
    ...(grantedScopes === undefined ? {} : { grantedScopes })
  });
  saveAccountRefreshToken(database, secret, account.id, refresh);
  return account.id;
}

function authorization(init: RequestInit | undefined): string {
  return new Headers(init?.headers).get('authorization') ?? '';
}

function code(error: unknown): string {
  return error instanceof GmailError ? error.code : 'other';
}

describe('gmail reader', () => {
  it('uses one refresh for overlapping reads and isolates accounts that share a thread id', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, 'ada', 'refresh-a');
    const grace = seed(database, secret, 'grace', 'refresh-b');
    let tokenCalls = 0;
    let releaseToken: (() => void) | undefined;
    const headers: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const href = requestUrl(url);
      if (href.includes('/token')) {
        tokenCalls += 1;
        const refresh = formField(init, 'refresh_token');
        return new Promise((resolve) => {
          releaseToken = () =>
            resolve(
              Response.json({
                access_token: refresh === 'refresh-a' ? 'access-a' : 'access-b',
                expires_in: 3600
              })
            );
        });
      }
      headers.push(authorization(init));
      if (href.includes('/threads/threadsame')) {
        return Response.json({
          id: 'threadsame',
          messages: [
            { id: 'messageone', internalDate: '1000', payload: { mimeType: 'text/plain' } }
          ]
        });
      }
      return Response.json(labelsBody);
    };
    const accounts = createGoogleAccountService({
      database,
      cipher: secret,
      fetchImpl,
      openExternal: async () => undefined
    });
    const reader = createGmailReader({ accounts, fetchImpl, openExternal: async () => undefined });
    const first = reader.listLabels(ada);
    await new Promise((resolve) => setImmediate(resolve));
    const second = reader.listLabels(ada);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tokenCalls, 1);
    releaseToken?.();
    await Promise.all([first, second]);
    assert.equal(tokenCalls, 1);
    const adaThread = reader.readThread(ada, 'threadsame');
    const graceThread = reader.readThread(grace, 'threadsame');
    await new Promise((resolve) => setImmediate(resolve));
    releaseToken?.();
    await new Promise((resolve) => setImmediate(resolve));
    releaseToken?.();
    await Promise.all([adaThread, graceThread]);
    assert.equal(headers.includes('Bearer access-a'), true);
    assert.equal(headers.includes('Bearer access-b'), true);
    assert.equal(
      await reader.readThread(ada, 'ab/cd').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
  });

  it('forwards a page token and keeps the account connected unless the token endpoint says invalid_grant', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, 'ada', 'refresh-a');
    const urls: string[] = [];
    let labels = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      const href = requestUrl(url);
      urls.push(href);
      if (href.includes('/token')) {
        return Response.json({ access_token: 'access-a', expires_in: 3600 });
      }
      if (href.includes('/labels')) {
        labels += 1;
        if (labels === 1) {
          return Response.json(
            { error: { code: 401, message: 'access-a', errors: [{ reason: 'authError' }] } },
            { status: 401 }
          );
        }
        return Response.json(labelsBody);
      }
      assert.equal(authorization(init), 'Bearer access-a');
      assert.equal(href.includes('pageToken=page-token-1'), true);
      assert.equal(href.includes('labelIds=INBOX'), true);
      return Response.json({ threads: [], nextPageToken: 'page-token-2' });
    };
    const accounts = createGoogleAccountService({
      database,
      cipher: secret,
      fetchImpl,
      openExternal: async () => undefined
    });
    const reader = createGmailReader({ accounts, fetchImpl, openExternal: async () => undefined });
    const page = await reader.listThreads({
      accountId: ada,
      labelId: 'INBOX',
      query: null,
      pageToken: 'page-token-1'
    });
    assert.equal(page.nextPageToken, 'page-token-2');
    assert.equal(getConnectedAccount(database, ada).status, 'connected');
    assert.equal(readAccountRefreshToken(database, secret, ada), 'refresh-a');
    assert.equal(JSON.stringify(page).includes('access-a'), false);
  });

  it('classifies permission, quota, transient, and invalid_grant failures separately', async () => {
    const sleeps: number[] = [];
    async function run(
      gmailStatus: number,
      gmailBody: unknown,
      tokenBody: unknown,
      tokenStatus = 200
    ): Promise<{ code: string; status: string; calls: number }> {
      const database = openTemp();
      const secret = cipher();
      const ada = seed(database, secret, 'ada', 'refresh-a');
      let calls = 0;
      const fetchImpl: typeof fetch = async (url) => {
        const href = requestUrl(url);
        if (href.includes('/token')) {
          return Response.json(tokenBody, { status: tokenStatus });
        }
        calls += 1;
        return Response.json(gmailBody, {
          status: gmailStatus,
          headers: { 'retry-after': gmailStatus === 429 ? '9' : '2' }
        });
      };
      const accounts = createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      });
      const reader = createGmailReader({
        accounts,
        fetchImpl,
        openExternal: async () => undefined,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        }
      });
      const result = await reader.listLabels(ada).then(
        () => 'ok',
        (error: unknown) => code(error)
      );
      return { code: result, status: getConnectedAccount(database, ada).status, calls };
    }
    const denied = await run(
      403,
      {
        error: { code: 403, errors: [{ reason: 'insufficientPermissions', message: 'access-a' }] }
      },
      { access_token: 'access-a', expires_in: 3600 }
    );
    assert.equal(denied.code, 'permission-denied');
    assert.equal(denied.status, 'connected');
    assert.equal(denied.calls, 1);
    sleeps.length = 0;
    const quota = await run(
      403,
      {
        error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] }
      },
      { access_token: 'access-a', expires_in: 3600 }
    );
    assert.equal(quota.code, 'rate-limited');
    assert.equal(quota.status, 'connected');
    assert.equal(quota.calls, 2);
    assert.equal(sleeps[0], 2000);
    const limited = await run(
      429,
      { error: { code: 429, message: 'access-a' } },
      {
        access_token: 'access-a',
        expires_in: 3600
      }
    );
    assert.equal(limited.code, 'rate-limited');
    assert.equal(limited.calls, 2);
    assert.equal(sleeps.at(-1), 1000);
    const unknown = await run(
      403,
      { error: { code: 403, message: 'access-a' } },
      {
        access_token: 'access-a',
        expires_in: 3600
      }
    );
    assert.equal(unknown.code, 'unavailable');
    assert.equal(unknown.status, 'connected');
    const invalidClient = await run(200, labelsBody, { error: 'invalid_client' }, 401);
    assert.equal(invalidClient.code, 'unavailable');
    assert.equal(invalidClient.status, 'connected');
    const unavailable = await run(
      503,
      { error: { code: 503 } },
      {
        access_token: 'access-a',
        expires_in: 3600
      }
    );
    assert.equal(unavailable.code, 'unavailable');
    assert.equal(unavailable.calls, 2);
    const revoked = await run(200, labelsBody, { error: 'invalid_grant' }, 400);
    assert.equal(revoked.code, 'needs-reauth');
    assert.equal(revoked.status, 'needs_reauth');
  });

  it('rejects a repeated 401 without retiring the refresh token', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, 'ada', 'refresh-a');
    let tokens = 0;
    const fetchImpl: typeof fetch = async (url) => {
      if (requestUrl(url).includes('/token')) {
        tokens += 1;
        return Response.json({ access_token: 'access-a', expires_in: 3600 });
      }
      return Response.json({ error: { code: 401, message: 'access-a' } }, { status: 401 });
    };
    const accounts = createGoogleAccountService({
      database,
      cipher: secret,
      fetchImpl,
      openExternal: async () => undefined
    });
    const reader = createGmailReader({ accounts, fetchImpl, openExternal: async () => undefined });
    assert.equal(
      await reader.listLabels(ada).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'gmail-rejected'
    );
    assert.equal(getConnectedAccount(database, ada).status, 'connected');
    assert.equal(readAccountRefreshToken(database, secret, ada), 'refresh-a');
    assert.equal(tokens, 2);
    assert.equal(await accounts.mailboxAccess(ada), 'access-a');
    assert.equal(tokens, 3);
  });

  it('does not read an oversized content-length and refuses an oversized conversation', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, 'ada', 'refresh-a');
    let readers = 0;
    const fetchImpl: typeof fetch = async (url) => {
      const href = requestUrl(url);
      if (href.includes('/token'))
        return Response.json({ access_token: 'access-a', expires_in: 60 });
      if (href.includes('/labels')) {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          }
        });
        const original = body.getReader.bind(body);
        body.getReader = (() => {
          readers += 1;
          return original();
        }) as typeof body.getReader;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': '8388609' }),
          body
        } as Response;
      }
      const messages = Array.from({ length: 51 }, (_value, index) => ({
        id: `message${index}`,
        payload: { mimeType: 'text/plain', body: { data: '' } }
      }));
      return Response.json({ messages });
    };
    const accounts = createGoogleAccountService({
      database,
      cipher: secret,
      fetchImpl,
      openExternal: async () => undefined
    });
    const reader: GmailReader = createGmailReader({
      accounts,
      fetchImpl,
      openExternal: async () => undefined
    });
    assert.equal(
      await reader.listLabels(ada).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'too-large'
    );
    assert.equal(readers, 0);
    assert.equal(
      await reader.readThread(ada, 'threadsame').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'too-large'
    );
    const wide = '€'.repeat(700_000);
    const wideFetch: typeof fetch = async (url) => {
      if (requestUrl(url).includes('/token')) {
        return Response.json({ access_token: 'access-wide', expires_in: 3600 });
      }
      return Response.json({
        messages: [
          {
            id: 'messageone',
            payload: {
              mimeType: 'text/plain',
              body: { data: Buffer.from(wide).toString('base64url') }
            }
          }
        ]
      });
    };
    const wideAccounts = createGoogleAccountService({
      database,
      cipher: secret,
      fetchImpl: wideFetch,
      openExternal: async () => undefined
    });
    const wideReader = createGmailReader({
      accounts: wideAccounts,
      fetchImpl: wideFetch,
      openExternal: async () => undefined
    });
    assert.equal(
      await wideReader.readThread(ada, 'threadwide').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'too-large'
    );
  });

  it('blocks disconnect during a read and logs a sanitized development failure', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, 'ada', 'refresh-a');
    let release: (() => void) | undefined;
    const fetchImpl: typeof fetch = async (url) => {
      if (requestUrl(url).includes('/token')) {
        return Response.json({ access_token: 'access-a', expires_in: 3600 });
      }
      return new Promise((resolve) => {
        release = () =>
          resolve(
            Response.json(
              { error: { code: 403, message: 'access-a secret-body' } },
              { status: 403 }
            )
          );
      });
    };
    const accounts = createGoogleAccountService({
      database,
      cipher: secret,
      fetchImpl,
      openExternal: async () => undefined
    });
    const reader = createGmailReader({ accounts, fetchImpl, openExternal: async () => undefined });
    const pending = reader.listLabels(ada);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      accounts.disconnect(ada),
      (error: unknown) => error instanceof OAuthFlowError && error.code === 'operation-in-progress'
    );
    const previous = process.env.NODE_ENV;
    const logs: string[] = [];
    const original = console.error;
    process.env.NODE_ENV = 'development';
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => (typeof value === 'string' ? value : '')).join(' '));
    };
    try {
      release?.();
      assert.equal(
        await pending.then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
        'unavailable'
      );
      assert.equal(logs[0], 'aurora gmail status=403 reason=none');
      assert.equal(logs.join('\n').includes('access-a'), false);
      assert.equal(logs.join('\n').includes('secret-body'), false);
    } finally {
      console.error = original;
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('reads rows, searches, and opens an accepted link', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, 'ada', 'refresh-a');
    const opened: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const href = requestUrl(url);
      if (href.includes('/token')) {
        return Response.json({
          access_token: 'access-a',
          expires_in: 3600,
          refresh_token: 'refresh-rotated'
        });
      }
      if (href.includes('pageToken=bad')) {
        return Response.json({ threads: [], nextPageToken: 'bad\nvalue' });
      }
      if (href.includes('/labels')) return Response.json(labelsBody);
      if (href.includes('format=metadata')) {
        return Response.json({
          id: 'threadsame',
          messages: [
            {
              id: 'mold',
              internalDate: '1000',
              payload: { headers: [{ name: 'Subject', value: 'Old subject' }] }
            },
            {
              id: 'mnew',
              internalDate: '2000',
              labelIds: ['UNREAD'],
              payload: { headers: [{ name: 'From', value: 'Ada' }] }
            }
          ]
        });
      }
      if (href.includes('q=')) {
        assert.equal(href.includes('labelIds='), false);
        assert.equal(href.includes('includeSpamTrash=true'), true);
        return Response.json({ threads: [{ id: 'bad/id' }] });
      }
      if (href.includes('/threads/missing')) {
        return Response.json({ error: { code: 404, status: 'NOT_FOUND' } }, { status: 404 });
      }
      return Response.json({
        threads: [{ id: 'threadsame', snippet: null }],
        nextPageToken: 'page-2'
      });
    };
    const accounts = createGoogleAccountService({
      database,
      cipher: secret,
      fetchImpl,
      openExternal: async (url) => {
        opened.push(url);
      }
    });
    const reader = createGmailReader({
      accounts,
      fetchImpl,
      openExternal: async (url) => {
        opened.push(url);
      }
    });
    const page = await reader.listThreads({
      accountId: ada,
      labelId: 'INBOX',
      query: null,
      pageToken: null
    });
    assert.equal(page.threads[0]?.subject, 'Old subject');
    assert.equal(page.threads[0]?.from, 'Ada');
    assert.equal(page.threads[0]?.unread, true);
    assert.equal(page.nextPageToken, 'page-2');
    assert.equal(readAccountRefreshToken(database, secret, ada), 'refresh-rotated');
    assert.equal(
      await reader
        .listThreads({ accountId: ada, labelId: 'INBOX', query: null, pageToken: 'bad' })
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'unavailable'
    );
    assert.equal(
      await reader
        .listThreads({
          accountId: ada,
          labelId: 'INBOX',
          query: 'from:ada@example.com',
          pageToken: null
        })
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'unavailable'
    );
    assert.equal(
      await reader.readThread(ada, 'missing').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'not-found'
    );
    assert.equal(
      await reader
        .listThreads({ accountId: ada, labelId: 'NOPE', query: null, pageToken: null })
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'invalid-request'
    );
    assert.deepEqual(await reader.openLink('https://example.com/a'), { opened: true });
    assert.deepEqual(opened, ['https://example.com/a']);
    assert.equal(
      await reader.openLink('javascript:alert(1)').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
    const failing = createGmailReader({
      accounts,
      fetchImpl: async () => {
        throw new Error('socket');
      },
      openExternal: async () => {
        throw new Error('blocked');
      }
    });
    assert.equal(
      await failing.listLabels(ada).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'network'
    );
    assert.equal(
      await failing.openLink('https://example.com/a').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'internal'
    );
  });

  it('decodes snippet character references once and keeps them plain text', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, 'ada', 'refresh-a');
    const malformed =
      '&#; &#x; &#44 &#x20AC &#x110000; &#xD800; &#0; &#31; &#127; &#x1F; &#x7F; &amp &unknown;';
    const snippets = new Map<string, string>([
      ['comma', 'es &#44; Euros'],
      ['euro', 'cost &#8364; and &#x20AC; and &#X2c;'],
      ['ampersand', 'a &amp; b &quot;c&quot; &apos;d&apos;&nbsp;e'],
      ['script', '&lt;script&gt;alert(1)&lt;/script&gt;'],
      ['double', '&amp;#44; &amp;amp; &amp;lt;'],
      ['malformed', malformed],
      ['recovered', '&#0;,&#44;'],
      ['limited', `${'a'.repeat(498)}&#44;${'&#44;'.repeat(501)}`],
      ['controls', 'ok\u0000&#44;\u007f']
    ]);
    const fetchImpl: typeof fetch = async (url) => {
      const href = requestUrl(url);
      if (href.includes('/token')) {
        return Response.json({ access_token: 'access-a', expires_in: 3600 });
      }
      if (href.includes('/labels')) return Response.json(labelsBody);
      if (href.includes('format=metadata')) {
        const threadId = new URL(href).pathname.split('/').at(-1) ?? '';
        return Response.json({
          id: threadId,
          snippet: snippets.get(threadId) ?? '',
          messages: [
            {
              id: `${threadId}m`,
              internalDate: '1000',
              payload: {
                headers: [
                  { name: 'Subject', value: '&#44;' },
                  { name: 'From', value: 'Ada &amp; Co' }
                ]
              }
            }
          ]
        });
      }
      return Response.json({
        threads: [...snippets.keys()].map((id) => ({ id, snippet: '&#44;' }))
      });
    };
    const accounts = createGoogleAccountService({
      database,
      cipher: secret,
      fetchImpl,
      openExternal: async () => undefined
    });
    const reader = createGmailReader({ accounts, fetchImpl, openExternal: async () => undefined });
    const page = await reader.listThreads({
      accountId: ada,
      labelId: 'INBOX',
      query: null,
      pageToken: null
    });
    const parsed = parseGmailThreadList(page);
    assert.notEqual(parsed, null);
    const byId = new Map(page.threads.map((thread) => [thread.id, thread]));
    assert.equal(byId.get('comma')?.snippet, 'es , Euros');
    assert.equal(byId.get('euro')?.snippet, 'cost € and € and ,');
    assert.equal(byId.get('ampersand')?.snippet, 'a & b "c" \'d\'\u00A0e');
    assert.equal(byId.get('script')?.snippet, '<script>alert(1)</script>');
    assert.equal(byId.get('double')?.snippet, '&#44; &amp; &lt;');
    assert.equal(byId.get('malformed')?.snippet, malformed);
    assert.equal(byId.get('recovered')?.snippet, '&#0;,,');
    assert.equal(byId.get('limited')?.snippet, `${'a'.repeat(498)},,`);
    assert.equal(byId.get('controls')?.snippet, 'ok,');
    for (const thread of page.threads) {
      assert.equal(thread.subject, '&#44;');
      assert.equal(thread.from, 'Ada &amp; Co');
      assert.equal((thread.snippet ?? '').length <= 500, true);
      for (const character of thread.snippet ?? '') {
        const code = character.charCodeAt(0);
        assert.equal(code <= 31 || code === 127, false);
      }
    }
  });

  it('maps account failures that are not gmail responses', async () => {
    const accountId = '00000000-0000-4000-8000-000000000001';
    async function failure(error: Error): Promise<string> {
      const reader = createGmailReader({
        accounts: {
          beginMailboxRead() {
            return undefined;
          },
          endMailboxRead() {
            return undefined;
          },
          async mailboxAccess() {
            throw error;
          },
          forgetMailboxAccess() {
            return undefined;
          }
        } as unknown as ReturnType<typeof createGoogleAccountService>,
        fetchImpl: async () => Response.json({}),
        openExternal: async () => undefined
      });
      return reader.listLabels(accountId).then(
        () => 'ok',
        (caught: unknown) => code(caught)
      );
    }
    assert.equal(await failure(new OAuthFlowError('needs-reauth')), 'needs-reauth');
    assert.equal(await failure(new OAuthFlowError('needs-client')), 'internal');
    assert.equal(await failure(new PersistenceError('decrypt-failed')), 'needs-reauth');
    assert.equal(
      await failure(new PersistenceError('encryption-unavailable')),
      'encryption-unavailable'
    );
    assert.equal(await failure(new PersistenceError('constraint')), 'internal');
    assert.equal(await failure(new Error('boom')), 'internal');
  });

  it('writes only the approved thread and message changes', async () => {
    const database = openTemp();
    const secret = cipher();
    const modify = 'openid email profile https://www.googleapis.com/auth/gmail.modify';
    const ada = seed(database, secret, 'ada', 'refresh-a', modify);
    const grace = seed(database, secret, 'grace', 'refresh-b');
    const calls: { href: string; method: string; body: string; auth: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const href = requestUrl(url);
      if (href.includes('/token')) {
        const refresh = formField(init, 'refresh_token');
        return Response.json({
          access_token: refresh === 'refresh-a' ? 'access-a' : 'access-b',
          expires_in: 3600
        });
      }
      calls.push({
        href,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
        auth: authorization(init)
      });
      if (href.endsWith('/labels')) return Response.json(labelsBody);
      if (href.includes('/messages/messageone/modify')) {
        return Response.json({ id: 'messageone', historyId: 'secret-history' });
      }
      if (href.includes('/threads/threadsame/')) {
        return Response.json({ id: 'threadsame', historyId: 'secret-history' });
      }
      return Response.json({ id: 'other' });
    };
    const accounts = createGoogleAccountService({
      database,
      cipher: secret,
      fetchImpl,
      openExternal: async () => undefined
    });
    const reader = createGmailReader({ accounts, fetchImpl, openExternal: async () => undefined });
    const read = await reader.markRead(ada, 'threadsame');
    assert.deepEqual(read, { threadId: 'threadsame', unread: false });
    assert.equal(JSON.stringify(read).includes('secret-history'), false);
    assert.deepEqual(calls.at(-1), {
      href: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/threadsame/modify',
      method: 'POST',
      body: '{"removeLabelIds":["UNREAD"]}',
      auth: 'Bearer access-a'
    });
    await reader.markUnread(ada, 'threadsame');
    assert.equal(calls.at(-1)?.body, '{"addLabelIds":["UNREAD"]}');
    await reader.archiveThread(ada, 'threadsame');
    assert.equal(calls.at(-1)?.body, '{"removeLabelIds":["INBOX"]}');
    await reader.trashThread(ada, 'threadsame');
    assert.equal(
      calls.at(-1)?.href,
      'https://gmail.googleapis.com/gmail/v1/users/me/threads/threadsame/trash'
    );
    assert.equal(calls.at(-1)?.body, '');
    await reader.untrashThread(ada, 'threadsame');
    assert.equal(calls.at(-1)?.href.endsWith('/threads/threadsame/untrash'), true);
    const labeled = await reader.addLabel(ada, 'threadsame', 'Label_1');
    assert.deepEqual(labeled, { threadId: 'threadsame', labelId: 'Label_1' });
    assert.equal(calls.at(-1)?.body, '{"addLabelIds":["Label_1"]}');
    await reader.removeLabel(ada, 'threadsame', 'Label_1');
    assert.equal(calls.at(-1)?.body, '{"removeLabelIds":["Label_1"]}');
    const starred = await reader.starMessage(ada, 'threadsame', 'messageone');
    assert.deepEqual(starred, { threadId: 'threadsame', messageId: 'messageone', starred: true });
    assert.equal(
      calls.at(-1)?.href,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/messageone/modify'
    );
    assert.equal(calls.at(-1)?.body, '{"addLabelIds":["STARRED"]}');
    await reader.unstarMessage(ada, 'threadsame', 'messageone');
    assert.equal(calls.at(-1)?.body, '{"removeLabelIds":["STARRED"]}');
    const beforeReadonly = calls.length;
    assert.equal(
      await reader.markRead(grace, 'threadsame').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'insufficient-scope'
    );
    assert.equal(calls.length, beforeReadonly);
    assert.equal(getConnectedAccount(database, grace).status, 'connected');
    const beforeSystem = calls.length;
    assert.equal(
      await reader.addLabel(ada, 'threadsame', 'INBOX').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
    assert.equal(calls.length, beforeSystem + 1);
    assert.equal(calls.at(-1)?.href.endsWith('/labels'), true);
    assert.equal(
      await reader.markRead(ada, 'bad/id').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
    assert.equal(
      await reader.starMessage(ada, 'threadsame', 'bad/id').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
  });

  it('rejects a second change to the same thread and a response for another resource', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(
      database,
      secret,
      'ada',
      'refresh-a',
      'openid email profile https://www.googleapis.com/auth/gmail.modify'
    );
    let release: (() => void) | undefined;
    const fetchImpl: typeof fetch = async (url) => {
      const href = requestUrl(url);
      if (href.includes('/token')) {
        return Response.json({ access_token: 'access-a', expires_in: 3600 });
      }
      if (href.endsWith('/modify')) {
        return new Promise((resolve) => {
          release = () => resolve(Response.json({ id: 'wrong' }));
        });
      }
      return Response.json(labelsBody);
    };
    const reader = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    const first = reader.archiveThread(ada, 'threadsame');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      await reader.trashThread(ada, 'threadsame').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'operation-in-progress'
    );
    release?.();
    assert.equal(
      await first.then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-response'
    );
  });

  it('keeps a read-only grant when Gmail refuses the scope and does not treat that as invalid_grant', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(
      database,
      secret,
      'ada',
      'refresh-a',
      'openid email profile https://www.googleapis.com/auth/gmail.modify'
    );
    const fetchImpl: typeof fetch = async (url) => {
      const href = requestUrl(url);
      if (href.includes('/token')) {
        return Response.json({ access_token: 'access-a', expires_in: 3600 });
      }
      return Response.json(
        { error: { errors: [{ reason: 'insufficientPermissions' }] } },
        { status: 403 }
      );
    };
    const reader = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    assert.equal(
      await reader.archiveThread(ada, 'threadsame').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'insufficient-scope'
    );
    assert.equal(getConnectedAccount(database, ada).status, 'connected');
    assert.equal(readAccountRefreshToken(database, secret, ada), 'refresh-a');
    const revoked = openTemp();
    const revokedSecret = cipher();
    const id = seed(
      revoked,
      revokedSecret,
      'ada',
      'refresh-a',
      'openid email profile https://www.googleapis.com/auth/gmail.modify'
    );
    const revokedFetch: typeof fetch = async (url) => {
      if (requestUrl(url).includes('/token')) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({});
    };
    const revokedReader = createGmailReader({
      accounts: createGoogleAccountService({
        database: revoked,
        cipher: revokedSecret,
        fetchImpl: revokedFetch,
        openExternal: async () => undefined
      }),
      fetchImpl: revokedFetch,
      openExternal: async () => undefined
    });
    assert.equal(
      await revokedReader.archiveThread(id, 'threadsame').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'needs-reauth'
    );
    assert.equal(getConnectedAccount(revoked, id).status, 'needs_reauth');
  });

  it('reports a network failure without changing the saved account', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(
      database,
      secret,
      'ada',
      'refresh-a',
      'openid email profile https://www.googleapis.com/auth/gmail.modify'
    );
    const fetchImpl: typeof fetch = async (url) => {
      if (requestUrl(url).includes('/token')) {
        return Response.json({ access_token: 'access-a', expires_in: 3600 });
      }
      throw new Error('offline');
    };
    const reader = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    assert.equal(
      await reader.trashThread(ada, 'threadsame').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'network'
    );
    assert.equal(getConnectedAccount(database, ada).status, 'connected');
  });
});
