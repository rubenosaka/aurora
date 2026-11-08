import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type DatabaseSync } from 'node:sqlite';
import { readAccountRefreshToken, saveAccountRefreshToken } from '../persistence/credentials.ts';
import { openAuroraDatabase } from '../persistence/database.ts';
import { type SecretCipher } from '../persistence/safe-storage-cipher.ts';
import { createConnectedAccount, createOAuthClient } from '../persistence/accounts.ts';
import { createGoogleAccountService } from '../oauth/google-accounts.ts';
import { GmailError } from './errors.ts';
import { createGmailReader } from './reader.ts';
import { type ComposeMessage } from '../../shared/mail-compose.ts';

const modify = 'openid email profile https://www.googleapis.com/auth/gmail.modify';
const directories: string[] = [];
const databases: DatabaseSync[] = [];

function requestUrl(url: RequestInfo | URL): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

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
  const directory = mkdtempSync(join(tmpdir(), 'aurora-compose-'));
  directories.push(directory);
  const database = openAuroraDatabase(join(directory, 'aurora.sqlite'));
  databases.push(database);
  return database;
}

after(() => {
  for (const database of databases) database.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function seed(database: DatabaseSync, secret: SecretCipher, grantedScopes?: string): string {
  const client = createOAuthClient(database, {
    provider: 'google',
    clientId: 'desktop-client.apps.googleusercontent.com'
  });
  const account = createConnectedAccount(database, {
    provider: 'google',
    providerAccountId: 'ada',
    displayName: 'Ada',
    email: 'ada@example.com',
    status: 'connected',
    oauthClientId: client.id,
    ...(grantedScopes === undefined ? {} : { grantedScopes })
  });
  saveAccountRefreshToken(database, secret, account.id, 'refresh-a');
  return account.id;
}

function code(error: unknown): string {
  return error instanceof GmailError ? error.code : 'other';
}

function source(threadId = 'threadsame') {
  return {
    id: 'messageone',
    threadId,
    payload: {
      headers: [
        { name: 'From', value: 'Bob <bob@example.com>' },
        { name: 'To', value: 'Ada <ada@example.com>, Cara <cara@example.com>' },
        { name: 'Cc', value: 'Dan <dan@example.com>' },
        { name: 'Bcc', value: 'eve@example.com' },
        { name: 'Subject', value: 'Café plans' },
        { name: 'Message-ID', value: '<parent@example.com>' },
        { name: 'References', value: '<root@example.com>' }
      ]
    }
  };
}

function readerFor(
  database: DatabaseSync,
  secret: SecretCipher,
  fetchImpl: typeof fetch
): ReturnType<typeof createGmailReader> {
  const accounts = createGoogleAccountService({
    database,
    cipher: secret,
    fetchImpl,
    openExternal: async () => undefined
  });
  return createGmailReader({ accounts, fetchImpl, openExternal: async () => undefined });
}

function tokenThen(
  handler: (href: string, init: RequestInit | undefined) => Response | Promise<Response>
): typeof fetch {
  return async (url, init) => {
    const href = requestUrl(url);
    if (href.includes('/token'))
      return Response.json({ access_token: 'access-a', expires_in: 3600 });
    return handler(href, init);
  };
}

function message(accountId: string, overrides: Partial<ComposeMessage> = {}): ComposeMessage {
  return {
    accountId,
    kind: 'new',
    threadId: null,
    messageId: null,
    to: ['bob@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hello',
    body: 'Café',
    ...overrides
  };
}

describe('gmail compose', () => {
  it('sends a new plain-text message without a thread and does not call drafts', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    const urls: string[] = [];
    let body = '';
    const fetchImpl = tokenThen(async (href, init) => {
      urls.push(href);
      body = typeof init?.body === 'string' ? init.body : '';
      return Response.json({ id: 'sentone', threadId: 'threadnew' });
    });
    const sent = await readerFor(database, secret, fetchImpl).sendMessage(message(ada));
    assert.deepEqual(sent, { id: 'sentone', threadId: 'threadnew' });
    assert.equal(
      urls.some((url) => url.endsWith('/messages/send')),
      true
    );
    assert.equal(
      urls.some((url) => url.includes('/drafts')),
      false
    );
    const payload = JSON.parse(body) as { raw?: string; threadId?: string };
    assert.equal(payload.threadId, undefined);
    const mime = Buffer.from(payload.raw ?? '', 'base64url').toString('utf8');
    assert.equal(mime.includes('Content-Type: text/plain; charset=UTF-8'), true);
    assert.equal(mime.includes('From: Ada <ada@example.com>'), true);
    assert.equal(
      Buffer.from(mime.split('\r\n\r\n')[1]?.replace(/\r\n/g, '') ?? '', 'base64').toString('utf8'),
      'Café'
    );
  });

  it('replies in the source thread and forwards as a new conversation', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    const sentBodies: string[] = [];
    const fetchImpl = tokenThen(async (href, init) => {
      if (href.includes('/messages/messageone')) return Response.json(source());
      sentBodies.push(typeof init?.body === 'string' ? init.body : '');
      return Response.json({ id: 'sentone', threadId: 'threadsame' });
    });
    const gmail = readerFor(database, secret, fetchImpl);
    const seedValue = await gmail.composeSeed({
      accountId: ada,
      threadId: 'threadsame',
      messageId: 'messageone',
      kind: 'reply-all'
    });
    assert.deepEqual(seedValue.to, ['bob@example.com']);
    assert.deepEqual(seedValue.cc, ['cara@example.com', 'dan@example.com']);
    assert.equal(seedValue.subject, 'Re: Café plans');
    const reply = await gmail.sendMessage(
      message(ada, {
        kind: 'reply-all',
        threadId: 'threadsame',
        messageId: 'messageone',
        to: seedValue.to,
        cc: seedValue.cc,
        subject: seedValue.subject
      })
    );
    assert.equal(reply.threadId, 'threadsame');
    const replyPayload = JSON.parse(sentBodies[0] ?? '{}') as { threadId?: string; raw?: string };
    assert.equal(replyPayload.threadId, 'threadsame');
    const replyMime = Buffer.from(replyPayload.raw ?? '', 'base64url').toString('utf8');
    assert.equal(replyMime.includes('In-Reply-To: <parent@example.com>'), true);
    assert.equal(replyMime.includes('<root@example.com>'), true);
    const forwarded = await gmail.sendMessage(
      message(ada, { kind: 'forward', subject: 'Fwd: Café plans' })
    );
    const forwardPayload = JSON.parse(sentBodies[1] ?? '{}') as { threadId?: string; raw?: string };
    assert.equal(forwardPayload.threadId, undefined);
    const forwardMime = Buffer.from(forwardPayload.raw ?? '', 'base64url').toString('utf8');
    assert.equal(forwardMime.includes('In-Reply-To:'), false);
    assert.equal(forwarded.id, 'sentone');
  });

  it('does not send a reply when the source message has no usable Message-ID or the wrong thread', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    let sends = 0;
    const fetchImpl = tokenThen(async (href) => {
      if (href.includes('/messages/send')) {
        sends += 1;
        return Response.json({ id: 'sentone', threadId: 'threadsame' });
      }
      if (href.endsWith('/messages/missingid')) {
        return Response.json({
          ...source(),
          id: 'missingid',
          payload: {
            headers: [
              { name: 'Subject', value: 'Hello' },
              { name: 'From', value: 'bob@example.com' }
            ]
          }
        });
      }
      return Response.json(source('threadother'));
    });
    const gmail = readerFor(database, secret, fetchImpl);
    assert.equal(
      await gmail
        .sendMessage(
          message(ada, {
            kind: 'reply',
            threadId: 'threadsame',
            messageId: 'missingid',
            subject: 'Re: Hello'
          })
        )
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'invalid-request'
    );
    assert.equal(
      await gmail
        .sendMessage(
          message(ada, {
            kind: 'reply',
            threadId: 'threadsame',
            messageId: 'messageone',
            subject: 'Re: Café plans'
          })
        )
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'invalid-request'
    );
    assert.equal(sends, 0);
  });

  it('refuses a read-only account before Gmail is called', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret);
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return Response.json({});
    };
    const result = await readerFor(database, secret, fetchImpl)
      .sendMessage(message(ada))
      .then(
        () => 'ok',
        (error: unknown) => code(error)
      );
    assert.equal(result, 'insufficient-scope');
    assert.equal(called, false);
    assert.equal(readAccountRefreshToken(database, secret, ada), 'refresh-a');
  });

  it('keeps the refresh token when Gmail refuses the send for scope', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    const fetchImpl = tokenThen(async () =>
      Response.json(
        { error: { errors: [{ reason: 'insufficientPermissions' }], status: 'PERMISSION_DENIED' } },
        { status: 403 }
      )
    );
    const result = await readerFor(database, secret, fetchImpl)
      .sendMessage(message(ada))
      .then(
        () => 'ok',
        (error: unknown) => code(error)
      );
    assert.equal(result, 'insufficient-scope');
    assert.equal(readAccountRefreshToken(database, secret, ada), 'refresh-a');
  });

  it('allows one send at a time and does not retry an unconfirmed or rejected send', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    let release: (() => void) | undefined;
    let sends = 0;
    const fetchImpl = tokenThen(
      () =>
        new Promise((resolve) => {
          sends += 1;
          release = () => resolve(Response.json({ id: 'sentone', threadId: null }));
        })
    );
    const gmail = readerFor(database, secret, fetchImpl);
    const first = gmail.sendMessage(message(ada));
    await new Promise((resolve) => setImmediate(resolve));
    const second = await gmail.sendMessage(message(ada)).then(
      () => 'ok',
      (error: unknown) => code(error)
    );
    assert.equal(second, 'operation-in-progress');
    assert.equal(sends, 1);
    release?.();
    await first;

    let failures = 0;
    const failing = tokenThen(async () => {
      failures += 1;
      return Response.json({ error: { errors: [{ reason: 'backendError' }] } }, { status: 500 });
    });
    assert.equal(
      await readerFor(database, secret, failing)
        .sendMessage(message(ada))
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'send-unconfirmed'
    );
    assert.equal(failures, 1);

    let limited = 0;
    const quota = tokenThen(async () => {
      limited += 1;
      return Response.json(
        { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
        { status: 429 }
      );
    });
    assert.equal(
      await readerFor(database, secret, quota)
        .sendMessage(message(ada))
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'send-unconfirmed'
    );
    assert.equal(limited, 1);

    let rejected = 0;
    const badRequest = tokenThen(async () => {
      rejected += 1;
      return Response.json({ error: { errors: [{ reason: 'invalidArgument' }] } }, { status: 400 });
    });
    assert.equal(
      await readerFor(database, secret, badRequest)
        .sendMessage(message(ada))
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'gmail-rejected'
    );
    assert.equal(rejected, 1);

    const dropped = tokenThen(async () => {
      throw new Error('timeout');
    });
    assert.equal(
      await readerFor(database, secret, dropped)
        .sendMessage(message(ada))
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'send-unconfirmed'
    );
    assert.equal(
      await readerFor(
        database,
        secret,
        tokenThen(async () => Response.json({}))
      )
        .sendMessage(message(ada))
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'send-unconfirmed'
    );
  });

  it('retries a confirmed unauthorized send once after refreshing the access token', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    let sends = 0;
    const fetchImpl = tokenThen(async () => {
      sends += 1;
      if (sends === 1) {
        return Response.json({ error: { errors: [{ reason: 'authError' }] } }, { status: 401 });
      }
      return Response.json({ id: 'sentone', threadId: 'threadnew' });
    });
    const sent = await readerFor(database, secret, fetchImpl).sendMessage(message(ada));
    assert.equal(sent.id, 'sentone');
    assert.equal(sends, 2);
  });
});
