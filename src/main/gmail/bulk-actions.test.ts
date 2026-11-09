import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type DatabaseSync } from 'node:sqlite';
import { saveAccountRefreshToken } from '../persistence/credentials.ts';
import { openAuroraDatabase } from '../persistence/database.ts';
import { type SecretCipher } from '../persistence/safe-storage-cipher.ts';
import { createConnectedAccount, createOAuthClient } from '../persistence/accounts.ts';
import { createGoogleAccountService } from '../oauth/google-accounts.ts';
import { GmailError } from './errors.ts';
import { createGmailReader, type GmailReader } from './reader.ts';

const directories: string[] = [];
const databases: DatabaseSync[] = [];
const clientId = 'desktop-client.apps.googleusercontent.com';
const modify = 'openid email profile https://www.googleapis.com/auth/gmail.modify';

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

function cipher(): SecretCipher {
  return {
    encrypt(plaintext: string): Buffer {
      const bytes = Buffer.from(plaintext, 'utf8');
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (bytes[index] ?? 0) ^ 0x5a;
      }
      return bytes;
    },
    decrypt(ciphertext: Buffer): string {
      const bytes = Buffer.from(ciphertext);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (bytes[index] ?? 0) ^ 0x5a;
      }
      return bytes.toString('utf8');
    }
  };
}

function openTemp(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), 'aurora-bulk-'));
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

function code(error: unknown): string {
  return error instanceof GmailError ? error.code : 'other';
}

function authorization(init: RequestInit | undefined): string {
  return new Headers(init?.headers).get('authorization') ?? '';
}

interface Call {
  href: string;
  method: string;
  body: string;
  auth: string;
}

function mailbox(
  fetchImpl: typeof fetch,
  grantedScopes: string | undefined = modify
): { reader: GmailReader; accountId: string; graceId: string } {
  const database = openTemp();
  const secret = cipher();
  const accountId = seed(database, secret, 'ada', 'refresh-a', grantedScopes);
  const graceId = seed(database, secret, 'grace', 'refresh-b', modify);
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
    sleep: async () => undefined
  });
  return { reader, accountId, graceId };
}

function jsonFetch(
  onCall: (href: string, init: RequestInit | undefined) => Response | Promise<Response>
): typeof fetch {
  return async (url, init) => {
    const href = requestUrl(url);
    if (href.includes('/token')) {
      const refresh = formField(init, 'refresh_token');
      return Response.json({
        access_token: refresh === 'refresh-b' ? 'access-b' : 'access-a',
        expires_in: 3600
      });
    }
    return onCall(href, init);
  };
}

const baseLabels = [
  { id: 'INBOX', name: 'INBOX', type: 'system', messagesUnread: 0 },
  { id: 'Label_1', name: 'Trips', type: 'user', messagesUnread: 0 }
];

describe('gmail bulk actions', () => {
  it('updates each selected conversation with the existing thread operations', async () => {
    const calls: Call[] = [];
    const { reader, accountId, graceId } = mailbox(
      jsonFetch(async (href, init) => {
        calls.push({
          href,
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? init.body : '',
          auth: authorization(init)
        });
        if (href.endsWith('/labels')) return Response.json({ labels: baseLabels });
        const thread = href.match(/\/threads\/([^/?]+)/)?.[1];
        if (thread === 'missing') {
          return Response.json({ error: { errors: [{ reason: 'notFound' }] } }, { status: 404 });
        }
        if (thread === 'dropped') throw new Error('socket');
        return Response.json({ id: thread ?? 'thread' });
      })
    );
    const read = await reader.bulkThreads({
      accountId,
      threadIds: ['threadone', 'missing', 'dropped', 'threadtwo'],
      action: 'read'
    });
    assert.deepEqual(read.succeeded, ['threadone', 'threadtwo']);
    assert.deepEqual(read.failed, [{ threadId: 'missing', code: 'not-found' }]);
    assert.deepEqual(read.unconfirmed, ['dropped']);
    assert.deepEqual(read.notAttempted, []);
    assert.equal(
      calls.some((call) => call.href.includes('batchModify')),
      false
    );
    assert.equal(
      calls.filter(
        (call) =>
          call.href.endsWith('/threads/threadone/modify') &&
          call.body === '{"removeLabelIds":["UNREAD"]}'
      ).length,
      1
    );
    assert.equal(calls.filter((call) => call.href.includes('/threads/dropped/modify')).length, 1);
    await reader.bulkThreads({ accountId, threadIds: ['threadone'], action: 'unread' });
    assert.equal(calls.at(-1)?.body, '{"addLabelIds":["UNREAD"]}');
    await reader.bulkThreads({ accountId, threadIds: ['threadone'], action: 'archive' });
    assert.equal(calls.at(-1)?.body, '{"removeLabelIds":["INBOX"]}');
    await reader.bulkThreads({ accountId, threadIds: ['threadone'], action: 'trash' });
    assert.equal(calls.at(-1)?.href.endsWith('/threads/threadone/trash'), true);
    await reader.bulkThreads({ accountId, threadIds: ['threadone'], action: 'untrash' });
    assert.equal(calls.at(-1)?.href.endsWith('/threads/threadone/untrash'), true);
    const added = await reader.bulkLabel({
      accountId,
      threadIds: ['threadone'],
      labelId: 'Label_1',
      mode: 'add'
    });
    assert.deepEqual(added.succeeded, ['threadone']);
    assert.equal(calls.at(-1)?.body, '{"addLabelIds":["Label_1"]}');
    await reader.bulkLabel({
      accountId,
      threadIds: ['threadone'],
      labelId: 'Label_1',
      mode: 'remove'
    });
    assert.equal(calls.at(-1)?.body, '{"removeLabelIds":["Label_1"]}');
    const beforeSystem = calls.length;
    assert.equal(
      await reader
        .bulkLabel({ accountId, threadIds: ['threadone'], labelId: 'INBOX', mode: 'add' })
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'invalid-request'
    );
    assert.equal(
      calls.slice(beforeSystem).some((call) => call.href.includes('/modify')),
      false
    );
    assert.equal(
      await reader
        .bulkLabel({ accountId, threadIds: ['threadone'], labelId: 'Label_9', mode: 'add' })
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'not-found'
    );
    const grace = await reader.bulkThreads({
      accountId: graceId,
      threadIds: ['threadone'],
      action: 'read'
    });
    assert.deepEqual(grace.succeeded, ['threadone']);
    assert.equal(calls.at(-1)?.auth, 'Bearer access-b');
    assert.equal(
      await reader
        .bulkThreads({
          accountId,
          threadIds: ['threadone', 'threadone'],
          action: 'read'
        })
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'invalid-request'
    );
    assert.equal(
      await reader
        .bulkThreads({
          accountId,
          threadIds: Array.from({ length: 21 }, (_, index) => `thread${index}`),
          action: 'read'
        })
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'invalid-request'
    );
  });

  it('refuses a second bulk and a busy conversation before any further call', async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    const { reader, accountId } = mailbox(
      jsonFetch(
        (href) =>
          new Promise((resolve) => {
            calls.push(href);
            const thread = href.match(/\/threads\/([^/?]+)/)?.[1] ?? 'thread';
            releases.push(() => resolve(Response.json({ id: thread })));
          })
      )
    );
    const first = reader.bulkThreads({
      accountId,
      threadIds: ['threadone'],
      action: 'archive'
    });
    for (let attempt = 0; attempt < 20 && releases.length < 1; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(
      await reader.bulkThreads({ accountId, threadIds: ['threadtwo'], action: 'read' }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'operation-in-progress'
    );
    assert.equal(
      await reader.markRead(accountId, 'threadone').then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'operation-in-progress'
    );
    const other = reader.markRead(accountId, 'threadother');
    for (let attempt = 0; attempt < 20 && releases.length < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const release of releases) release();
    await first;
    await other;
    assert.equal(calls.filter((href) => href.includes('/threads/threadtwo/')).length, 0);
  });

  it('stops unstarted work after a rate limit or an authorization failure', async () => {
    const waiting: Array<() => void> = [];
    let limited = 0;
    const started: string[] = [];
    const { reader, accountId } = mailbox(
      jsonFetch((href) => {
        if (href.includes('/threads/t0/modify')) {
          limited += 1;
          return Response.json(
            { error: { errors: [{ reason: 'userRateLimitExceeded' }] } },
            { status: 429 }
          );
        }
        const thread = href.match(/\/threads\/(t[1-5])\/modify/)?.[1];
        if (thread === undefined) return Response.json({ id: 'other' });
        started.push(thread);
        return new Promise((resolve) => {
          waiting.push(() => resolve(Response.json({ id: thread })));
        });
      })
    );
    const pending = reader.bulkThreads({
      accountId,
      threadIds: ['t0', 't1', 't2', 't3', 't4', 't5'],
      action: 'read'
    });
    for (let attempt = 0; attempt < 20 && !(limited >= 2 && waiting.length === 3); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(limited, 2);
    assert.deepEqual(started, ['t1', 't2', 't3']);
    for (const resume of waiting) resume();
    const result = await pending;
    assert.deepEqual(result.failed, [{ threadId: 't0', code: 'rate-limited' }]);
    assert.deepEqual(result.succeeded, ['t1', 't2', 't3']);
    assert.deepEqual(result.notAttempted, ['t4', 't5']);

    const blocked: string[] = [];
    const { reader: scoped, accountId: scopedAccount } = mailbox(
      jsonFetch((href) => {
        blocked.push(href);
        if (href.includes('/threads/b0/modify')) {
          return Response.json(
            { error: { errors: [{ reason: 'insufficientPermissions' }] } },
            { status: 403 }
          );
        }
        const thread = href.match(/\/threads\/(b[1-5])\/modify/)?.[1];
        if (thread === undefined) return Response.json({ id: 'other' });
        return new Promise((resolve) => {
          waiting.push(() => resolve(Response.json({ id: thread })));
        });
      })
    );
    waiting.length = 0;
    const denied = scoped.bulkThreads({
      accountId: scopedAccount,
      threadIds: ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'],
      action: 'archive'
    });
    for (let attempt = 0; attempt < 20 && waiting.length < 3; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const resume of [...waiting]) resume();
    const denial = await denied;
    assert.equal(denial.failed[0]?.threadId, 'b0');
    assert.equal(denial.failed[0]?.code, 'insufficient-scope');
    assert.equal(denial.notAttempted.includes('b4'), true);
    assert.equal(denial.notAttempted.includes('b5'), true);
    assert.equal(denial.succeeded.includes('b0'), false);
  });

  it('stars only the newest message and unstars at most 50 starred messages', async () => {
    const calls: Call[] = [];
    const starred = Array.from({ length: 51 }, (_, index) => ({
      id: `m${String(index).padStart(2, '0')}`,
      internalDate: String(1000 + index),
      labelIds: ['STARRED']
    }));
    const { reader, accountId } = mailbox(
      jsonFetch(async (href, init) => {
        calls.push({
          href,
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? init.body : '',
          auth: authorization(init)
        });
        if (href.includes('/threads/plain?')) {
          return Response.json({
            id: 'plain',
            messages: [
              { id: 'older', internalDate: '10', labelIds: [] },
              { id: 'newer', internalDate: '20', labelIds: ['INBOX'] },
              { id: 'same', internalDate: '20' }
            ]
          });
        }
        if (href.includes('/threads/tied?')) {
          return Response.json({
            id: 'tied',
            messages: [
              { id: 'm1', internalDate: '20', labelIds: [] },
              { id: 'm2', internalDate: '20', labelIds: [] }
            ]
          });
        }
        if (href.includes('/threads/quiet?')) {
          return Response.json({
            id: 'quiet',
            messages: [{ id: 'quietmsg', internalDate: '5', labelIds: ['INBOX'] }]
          });
        }
        if (href.includes('/threads/both?')) {
          return Response.json({
            id: 'both',
            messages: [
              { id: 'keep', internalDate: '1', labelIds: ['INBOX'] },
              { id: 'starredone', internalDate: '2', labelIds: ['STARRED'] },
              { id: 'starredtwo', internalDate: '3', labelIds: ['STARRED', 'INBOX'] }
            ]
          });
        }
        if (href.includes('/threads/crowd?')) {
          return Response.json({ id: 'crowd', messages: starred });
        }
        const message = href.match(/\/messages\/([^/]+)\/modify/)?.[1];
        return Response.json({ id: message ?? 'missing' });
      })
    );
    const starredResult = await reader.bulkThreads({
      accountId,
      threadIds: ['plain'],
      action: 'star'
    });
    assert.deepEqual(starredResult.succeeded, ['plain']);
    const starCalls = calls.filter((call) => call.href.includes('/modify'));
    assert.deepEqual(
      starCalls.map((call) => call.href),
      ['https://gmail.googleapis.com/gmail/v1/users/me/messages/same/modify']
    );
    assert.equal(starCalls[0]?.body, '{"addLabelIds":["STARRED"]}');
    assert.equal(
      calls.some((call) => call.href.includes('/threads/plain/modify')),
      false
    );
    calls.length = 0;
    await reader.bulkThreads({ accountId, threadIds: ['tied'], action: 'star' });
    assert.equal(
      calls.some((call) => call.href.endsWith('/messages/m2/modify')),
      true
    );
    assert.equal(
      calls.some((call) => call.href.endsWith('/messages/m1/modify')),
      false
    );
    calls.length = 0;
    const quiet = await reader.bulkThreads({
      accountId,
      threadIds: ['quiet'],
      action: 'unstar'
    });
    assert.deepEqual(quiet.succeeded, ['quiet']);
    assert.equal(
      calls.some((call) => call.method === 'POST'),
      false
    );
    calls.length = 0;
    const both = await reader.bulkThreads({ accountId, threadIds: ['both'], action: 'unstar' });
    assert.deepEqual(both.succeeded, ['both']);
    assert.deepEqual(
      calls.filter((call) => call.method === 'POST').map((call) => call.href),
      [
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/starredone/modify',
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/starredtwo/modify'
      ]
    );
    assert.equal(
      calls.every((call) => call.body === '' || call.body === '{"removeLabelIds":["STARRED"]}'),
      true
    );
    calls.length = 0;
    const crowd = await reader.bulkThreads({
      accountId,
      threadIds: ['crowd'],
      action: 'unstar'
    });
    assert.deepEqual(crowd.succeeded, []);
    assert.deepEqual(crowd.failed, [{ threadId: 'crowd', code: 'too-large' }]);
    const modified = calls.filter((call) => call.method === 'POST').map((call) => call.href);
    assert.equal(modified.length, 50);
    assert.equal(
      modified.some((href) => href.includes('/messages/m50/')),
      false
    );
  });

  it('creates, renames, and deletes only user labels', async () => {
    const labels = [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'Label_1', name: 'Trips', type: 'user' }
    ];
    const calls: Call[] = [];
    let conflict = false;
    const { reader, accountId } = mailbox(
      jsonFetch(async (href, init) => {
        calls.push({
          href,
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? init.body : '',
          auth: authorization(init)
        });
        if (href.endsWith('/labels') && (init?.method ?? 'GET') === 'GET') {
          return Response.json({ labels });
        }
        if (href.endsWith('/labels') && init?.method === 'POST') {
          if (conflict) {
            return Response.json({ error: { errors: [{ reason: 'conflict' }] } }, { status: 409 });
          }
          if (typeof init.body !== 'string') throw new Error('missing body');
          const body = JSON.parse(init.body) as {
            name: string;
            labelListVisibility: string;
            messageListVisibility: string;
          };
          assert.equal(body.labelListVisibility, 'labelShow');
          assert.equal(body.messageListVisibility, 'show');
          labels.push({ id: 'Label_2', name: body.name, type: 'user' });
          return Response.json({ id: 'Label_2', name: body.name, type: 'user' });
        }
        if (init?.method === 'PUT') {
          if (typeof init.body !== 'string') throw new Error('missing body');
          const body = JSON.parse(init.body) as { name: string };
          const label = labels.find((item) => href.endsWith(`/labels/${item.id}`));
          if (label !== undefined) label.name = body.name;
          return Response.json({ id: 'Label_1', name: body.name, type: 'user' });
        }
        if (init?.method === 'DELETE') {
          return Response.json({});
        }
        return Response.json({ id: 'other' });
      })
    );
    const before = calls.length;
    assert.equal(
      await reader.createLabel({ accountId, name: 'Parent/Child' }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
    assert.equal(
      await reader.createLabel({ accountId, name: '   ' }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
    assert.equal(
      await reader.createLabel({ accountId, name: 'Bad\nName' }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
    assert.equal(calls.length, before);
    assert.equal(
      await reader.createLabel({ accountId, name: 'INBOX' }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
    assert.equal(
      calls.some((call) => call.method === 'POST'),
      false
    );
    assert.equal(
      await reader.createLabel({ accountId, name: 'Trips' }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'label-exists'
    );
    const created = await reader.createLabel({ accountId, name: ' Travel ' });
    assert.deepEqual(created, { id: 'Label_2', name: 'Travel' });
    conflict = true;
    labels.splice(0, labels.length, ...baseLabelCopies());
    assert.equal(
      await reader.createLabel({ accountId, name: 'Elsewhere' }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'label-exists'
    );
    conflict = false;
    assert.equal(
      await reader.renameLabel({ accountId, labelId: 'Label_1', name: 'Trips' }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
    assert.equal(
      await reader.renameLabel({ accountId, labelId: 'INBOX', name: 'Other' }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
    assert.equal(
      calls.some((call) => call.method === 'PUT'),
      false
    );
    const renamed = await reader.renameLabel({ accountId, labelId: 'Label_1', name: 'Travel' });
    assert.deepEqual(renamed, { id: 'Label_1', name: 'Travel' });
    const beforeDelete = calls.filter((call) => call.method === 'DELETE').length;
    assert.equal(
      await reader.deleteLabel({ accountId, labelId: 'INBOX' }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'invalid-request'
    );
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, beforeDelete);
    const deleted = await reader.deleteLabel({ accountId, labelId: 'Label_1' });
    assert.deepEqual(deleted, { id: 'Label_1' });
    assert.equal(
      calls.some((call) => call.href.includes('/messages/') && call.method === 'DELETE'),
      false
    );
    const { reader: readonly, accountId: readonlyId } = mailbox(
      jsonFetch(() => {
        throw new Error('fetched');
      }),
      'openid email profile https://www.googleapis.com/auth/gmail.readonly'
    );
    assert.equal(
      await readonly
        .bulkThreads({ accountId: readonlyId, threadIds: ['threadone'], action: 'read' })
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'insufficient-scope'
    );
  });
});

function baseLabelCopies(): { id: string; name: string; type: string }[] {
  return [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'Label_1', name: 'Trips', type: 'user' }
  ];
}
