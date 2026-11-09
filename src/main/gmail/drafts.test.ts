import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type DatabaseSync } from 'node:sqlite';
import { saveAccountRefreshToken } from '../persistence/credentials.ts';
import { openAuroraDatabase, schemaVersion } from '../persistence/database.ts';
import { type SecretCipher } from '../persistence/safe-storage-cipher.ts';
import { createConnectedAccount, createOAuthClient } from '../persistence/accounts.ts';
import { createGoogleAccountService } from '../oauth/google-accounts.ts';
import { googleScopes } from '../oauth/google-flow.ts';
import { attachmentByteLimit, type DraftSaveRequest } from '../../shared/mail-draft.ts';
import { GmailError } from './errors.ts';
import { createGmailReader } from './reader.ts';

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
  const directory = mkdtempSync(join(tmpdir(), 'aurora-draft-'));
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

function seedGrace(database: DatabaseSync, secret: SecretCipher): string {
  const client = createOAuthClient(database, {
    provider: 'google',
    clientId: 'other-client.apps.googleusercontent.com'
  });
  const account = createConnectedAccount(database, {
    provider: 'google',
    providerAccountId: 'grace',
    displayName: 'Grace',
    email: 'grace@example.com',
    status: 'connected',
    oauthClientId: client.id,
    grantedScopes: modify
  });
  saveAccountRefreshToken(database, secret, account.id, 'refresh-g');
  return account.id;
}

function code(error: unknown): string {
  return error instanceof GmailError ? error.code : 'other';
}

function tokenThen(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response
): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    if (url.includes('oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'access-a', expires_in: 3600, token_type: 'Bearer' });
    }
    return handler(url, init);
  };
}

function saveBody(accountId: string, extra: Partial<DraftSaveRequest> = {}): DraftSaveRequest {
  return {
    accountId,
    draftId: null,
    expectedMessageId: null,
    kind: 'new',
    threadId: null,
    messageId: null,
    to: ['bob@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hello',
    body: 'Plain',
    attachmentTokens: [],
    replaceConfirmed: false,
    composerGeneration: 1,
    ...extra
  };
}

describe('gmail drafts', () => {
  it('creates a draft, updates the same draft id, and refuses a changed remote message', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    const calls: string[] = [];
    let messageId = 'messageone';
    const fetchImpl = tokenThen(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/drafts') && init?.method === 'POST') {
        return Response.json({
          id: 'draftone',
          message: { id: messageId, threadId: 'threadnew', historyId: '10' }
        });
      }
      if (url.includes('/drafts/draftone') && init?.method === 'GET') {
        return Response.json({
          id: 'draftone',
          message: { id: messageId, threadId: 'threadnew', historyId: '10' }
        });
      }
      if (url.includes('/drafts/draftone') && init?.method === 'PUT') {
        messageId = 'messagetwo';
        return Response.json({
          id: 'draftone',
          message: { id: messageId, threadId: 'threadnew', historyId: '11' }
        });
      }
      return Response.json({ error: { errors: [{ reason: 'backendError' }] } }, { status: 500 });
    });
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    const created = await gmail.saveDraft(saveBody(ada));
    assert.equal(created.draftId, 'draftone');
    assert.equal(created.messageId, 'messageone');
    const updated = await gmail.saveDraft(
      saveBody(ada, { draftId: 'draftone', expectedMessageId: 'messageone', body: 'Edited' })
    );
    assert.equal(updated.draftId, 'draftone');
    assert.equal(updated.messageId, 'messagetwo');
    messageId = 'messageother';
    const conflict = await gmail
      .saveDraft(
        saveBody(ada, { draftId: 'draftone', expectedMessageId: 'messagetwo', body: 'Again' })
      )
      .then(
        () => 'ok',
        (error: unknown) => code(error)
      );
    assert.equal(conflict, 'draft-conflict');
    assert.equal(calls.filter((call) => call.startsWith('PUT')).length, 1);
  });

  it('does not update an HTML draft and keeps the original request to a read', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    const calls: string[] = [];
    const fetchImpl = tokenThen(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/drafts?')) {
        return Response.json({
          drafts: [{ id: 'draftone', message: { id: 'messageone', threadId: 'threadsame' } }]
        });
      }
      if (url.includes('/drafts/draftone')) {
        return Response.json({
          id: 'draftone',
          message: {
            id: 'messageone',
            threadId: 'threadsame',
            payload: {
              mimeType: 'text/html',
              headers: [
                { name: 'Subject', value: 'Rich' },
                { name: 'To', value: 'bob@example.com' }
              ],
              body: { data: Buffer.from('<p>Hi</p>').toString('base64url') }
            }
          }
        });
      }
      return Response.json({}, { status: 500 });
    });
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    const opened = await gmail.openDraft({
      accountId: ada,
      threadId: 'threadsame',
      messageId: 'messageone',
      composerGeneration: 2
    });
    assert.equal(opened.locked, true);
    assert.equal(opened.attachments.length, 0);
    assert.equal(
      calls.some((call) => call.startsWith('PUT') || call.startsWith('POST')),
      false
    );
  });

  it('does not edit a draft that contains an inline image', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    const fetchImpl = tokenThen(async (url) => {
      if (url.includes('/drafts?')) {
        return Response.json({
          drafts: [{ id: 'draftone', message: { id: 'messageone', threadId: 'threadsame' } }]
        });
      }
      return Response.json({
        id: 'draftone',
        message: {
          id: 'messageone',
          threadId: 'threadsame',
          payload: {
            mimeType: 'multipart/related',
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: Buffer.from('Hi').toString('base64url'), size: 2 }
              },
              {
                mimeType: 'image/png',
                headers: [{ name: 'Content-ID', value: '<pic>' }],
                body: { data: Buffer.from('png').toString('base64url'), size: 3 }
              }
            ]
          }
        }
      });
    });
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    const opened = await gmail.openDraft({
      accountId: ada,
      threadId: 'threadsame',
      messageId: 'messageone',
      composerGeneration: 3
    });
    assert.equal(opened.locked, true);
    assert.equal(opened.attachments.length, 0);
    assert.equal(opened.body, 'Hi');
  });

  it('sends a saved draft once and does not retry an unconfirmed send', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    let sends = 0;
    const fetchImpl = tokenThen(async (url, init) => {
      if (url.endsWith('/drafts/send')) {
        sends += 1;
        return Response.json({ error: { errors: [{ reason: 'backendError' }] } }, { status: 500 });
      }
      if (url.includes('/drafts/draftone') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          id: 'draftone',
          message: { id: 'messageone', threadId: null, historyId: '3' }
        });
      }
      return Response.json({}, { status: 500 });
    });
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    const result = await gmail
      .sendDraft(saveBody(ada, { draftId: 'draftone', expectedMessageId: 'messageone' }))
      .then(
        () => 'ok',
        (error: unknown) => code(error)
      );
    assert.equal(result, 'send-unconfirmed');
    assert.equal(sends, 1);
  });

  it('refuses a read-only account before saving and still downloads an attachment', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret);
    let downloads = 0;
    const fetchImpl = tokenThen(async (url) => {
      if (url.includes('/attachments/')) {
        downloads += 1;
        return Response.json({ data: Buffer.from('hello').toString('base64url'), size: 5 });
      }
      if (url.includes('/messages/messageone')) {
        return Response.json({
          id: 'messageone',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '1',
                mimeType: 'text/plain',
                filename: 'notes.txt',
                body: { attachmentId: 'attachone', size: 5 }
              }
            ]
          }
        });
      }
      return Response.json({}, { status: 500 });
    });
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined,
      chooseSavePath: async () => null
    });
    assert.equal(
      await gmail.saveDraft(saveBody(ada)).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'insufficient-scope'
    );
    const saved = await gmail.downloadAttachment({
      accountId: ada,
      messageId: 'messageone',
      partId: '1',
      attachmentId: 'attachone'
    });
    assert.equal(saved.saved, false);
    assert.equal(downloads, 1);
  });

  it('rejects an attachment id that the message does not contain', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    const fetchImpl = tokenThen(async () =>
      Response.json({
        id: 'messageone',
        payload: { mimeType: 'text/plain', body: { data: Buffer.from('Hi').toString('base64url') } }
      })
    );
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined,
      chooseSavePath: async () => 'C:\\temp\\notes.txt'
    });
    assert.equal(
      await gmail
        .downloadAttachment({
          accountId: ada,
          messageId: 'messageone',
          partId: null,
          attachmentId: 'missingattach'
        })
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'not-found'
    );
  });

  it('builds a session reply from the source message headers', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    let raw = '';
    let posts = 0;
    const fetchImpl = tokenThen(async (url, init) => {
      if (url.includes('/messages/messageone')) {
        return Response.json({
          id: 'messageone',
          threadId: 'threadsame',
          payload: {
            headers: [
              { name: 'Subject', value: 'Hello' },
              { name: 'Message-ID', value: '<parent@example.com>' },
              { name: 'References', value: '<root@example.com>' }
            ]
          }
        });
      }
      if (url.endsWith('/drafts') && init?.method === 'POST') {
        posts += 1;
        raw = typeof init.body === 'string' ? init.body : '';
        return Response.json({
          id: 'draftone',
          message: { id: 'messagedraft', threadId: 'threadsame', historyId: '1' }
        });
      }
      return Response.json({}, { status: 500 });
    });
    const gmail = createGmailReader({
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
      await gmail
        .saveDraft(
          saveBody(ada, {
            kind: 'reply',
            threadId: 'threadsame',
            messageId: 'messageone',
            subject: 'Wrong'
          })
        )
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'invalid-request'
    );
    assert.equal(posts, 0);
    await gmail.saveDraft(
      saveBody(ada, {
        kind: 'reply',
        threadId: 'threadsame',
        messageId: 'messageone',
        subject: 'Re: Hello'
      })
    );
    const message = Buffer.from(
      (JSON.parse(raw) as { message: { raw: string; threadId?: string } }).message.raw,
      'base64url'
    ).toString('utf8');
    assert.equal(
      (JSON.parse(raw) as { message: { threadId?: string } }).message.threadId,
      'threadsame'
    );
    assert.equal(message.includes('In-Reply-To: <parent@example.com>'), true);
    assert.equal(posts, 1);
  });

  it('opens a draft created in this session without listing every draft', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    let lists = 0;
    const fetchImpl = tokenThen(async (url, init) => {
      if (url.includes('/drafts?')) {
        lists += 1;
        return Response.json({ drafts: [] });
      }
      if (url.endsWith('/drafts') && init?.method === 'POST') {
        return Response.json({
          id: 'draftone',
          message: { id: 'messageone', threadId: 'threadnew', historyId: '1' }
        });
      }
      if (url.includes('/drafts/draftone')) {
        return Response.json({
          id: 'draftone',
          message: {
            id: 'messageone',
            threadId: 'threadnew',
            historyId: '1',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'Subject', value: 'Hello' },
                { name: 'To', value: 'bob@example.com' }
              ],
              body: { data: Buffer.from('Hello').toString('base64url'), size: 5 }
            }
          }
        });
      }
      return Response.json({}, { status: 500 });
    });
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    await gmail.saveDraft(saveBody(ada));
    const opened = await gmail.openDraft({
      accountId: ada,
      threadId: 'threadnew',
      messageId: 'messageone',
      composerGeneration: 3
    });
    assert.equal(opened.draftId, 'draftone');
    assert.equal(opened.body, 'Hello');
    assert.equal(lists, 0);
  });

  it('keeps the modify scope and schema version 3', () => {
    const scopes: readonly string[] = googleScopes;
    assert.equal(schemaVersion, 3);
    assert.equal(scopes.includes('https://www.googleapis.com/auth/gmail.modify'), true);
    assert.equal(scopes.includes('https://www.googleapis.com/auth/gmail.compose'), false);
    assert.equal(scopes.includes('https://www.googleapis.com/auth/gmail.send'), false);
  });

  it('overwrites only after confirmation and treats a history change as a conflict', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    let history = '10';
    let puts = 0;
    const fetchImpl = tokenThen(async (url, init) => {
      if (url.endsWith('/drafts') && init?.method === 'POST') {
        return Response.json({
          id: 'draftone',
          message: { id: 'messageone', threadId: 'threadnew', historyId: '10' }
        });
      }
      if (url.includes('/drafts/draftone') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          id: 'draftone',
          message: { id: 'messageone', threadId: 'threadnew', historyId: history }
        });
      }
      if (init?.method === 'PUT') {
        puts += 1;
        return Response.json({
          id: 'draftone',
          message: { id: 'messagetwo', threadId: 'threadnew', historyId: '12' }
        });
      }
      return Response.json({}, { status: 500 });
    });
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    await gmail.saveDraft(saveBody(ada));
    history = '99';
    assert.equal(
      await gmail
        .saveDraft(
          saveBody(ada, { draftId: 'draftone', expectedMessageId: 'messageone', body: 'Local' })
        )
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'draft-conflict'
    );
    assert.equal(puts, 0);
    const replaced = await gmail.saveDraft(
      saveBody(ada, {
        draftId: 'draftone',
        expectedMessageId: 'messageone',
        body: 'Local',
        replaceConfirmed: true
      })
    );
    assert.equal(replaced.messageId, 'messagetwo');
    assert.equal(puts, 1);
  });

  it('deletes only through the draft endpoint and treats 404 as already gone', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    let deletes = 0;
    const fetchImpl = tokenThen(async (url, init) => {
      if (url.endsWith('/drafts') && init?.method === 'POST') {
        return Response.json({
          id: 'draftone',
          message: { id: 'messageone', threadId: 'threadnew', historyId: '1' }
        });
      }
      if (url.includes('/drafts/draftone') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          id: 'draftone',
          message: { id: 'messageone', threadId: 'threadnew', historyId: '1' }
        });
      }
      if (init?.method === 'DELETE') {
        deletes += 1;
        return Response.json({ error: { errors: [{ reason: 'notFound' }] } }, { status: 404 });
      }
      return Response.json({}, { status: 500 });
    });
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    await gmail.saveDraft(saveBody(ada));
    const deleted = await gmail.deleteDraft({
      accountId: ada,
      draftId: 'draftone',
      expectedMessageId: 'messageone'
    });
    assert.equal(deleted.deleted, true);
    assert.equal(deletes, 1);
  });

  it('does not retry an ambiguous create or an interrupted update', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    let posts = 0;
    let puts = 0;
    let created = false;
    const fetchImpl = tokenThen(async (url, init) => {
      if (url.endsWith('/drafts') && init?.method === 'POST') {
        posts += 1;
        if (!created)
          return Response.json(
            { error: { errors: [{ reason: 'backendError' }] } },
            { status: 500 }
          );
        return Response.json({
          id: 'draftone',
          message: { id: 'messageone', threadId: 'threadnew', historyId: '1' }
        });
      }
      if ((init?.method ?? 'GET') === 'GET') {
        return Response.json({
          id: 'draftone',
          message: { id: 'messageone', threadId: 'threadnew', historyId: '1' }
        });
      }
      if (init?.method === 'PUT') {
        puts += 1;
        return Response.json({ error: { errors: [{ reason: 'backendError' }] } }, { status: 500 });
      }
      return Response.json({}, { status: 500 });
    });
    const gmail = createGmailReader({
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
      await gmail.saveDraft(saveBody(ada)).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'save-unconfirmed'
    );
    assert.equal(posts, 1);
    created = true;
    await gmail.saveDraft(saveBody(ada, { composerGeneration: 2 }));
    assert.equal(posts, 2);
    assert.equal(
      await gmail
        .saveDraft(
          saveBody(ada, { draftId: 'draftone', expectedMessageId: 'messageone', body: 'Again' })
        )
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'save-unconfirmed'
    );
    assert.equal(puts, 1);
  });

  it('holds one send and does not start a second while the first is unresolved', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    let sends = 0;
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = tokenThen((url) => {
      if (url.endsWith('/drafts/send')) {
        sends += 1;
        return pending;
      }
      if (url.includes('/drafts/draftone')) {
        return Response.json({
          id: 'draftone',
          message: { id: 'messageone', threadId: null, historyId: '3' }
        });
      }
      return Response.json({}, { status: 500 });
    });
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    const first = gmail.sendDraft(
      saveBody(ada, { draftId: 'draftone', expectedMessageId: 'messageone' })
    );
    const second = await gmail
      .sendDraft(saveBody(ada, { draftId: 'draftone', expectedMessageId: 'messageone' }))
      .then(
        () => 'ok',
        (error: unknown) => code(error)
      );
    assert.equal(second, 'operation-in-progress');
    release(Response.json({ id: 'sentone', threadId: 'threadsent' }));
    const sent = await first;
    assert.equal(sent.id, 'sentone');
    assert.equal(sends, 1);
  });

  it('sends a recovered reply with its thread and a forward without one', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    const bodies: string[] = [];
    const fetchImpl = tokenThen(async (url, init) => {
      if (url.includes('/drafts?')) {
        return Response.json({
          drafts: [{ id: 'draftone', message: { id: 'messageone', threadId: 'threadsame' } }]
        });
      }
      if (
        url.includes('/drafts/draftone') &&
        (init?.method ?? 'GET') === 'GET' &&
        !url.endsWith('/send')
      ) {
        return Response.json({
          id: 'draftone',
          message: {
            id: 'messageone',
            threadId: 'threadsame',
            historyId: '4',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'Subject', value: 'Hello' },
                { name: 'To', value: 'bob@example.com' },
                { name: 'In-Reply-To', value: '<parent@example.com>' },
                { name: 'References', value: '<parent@example.com>' }
              ],
              body: { data: Buffer.from('Hi').toString('base64url'), size: 2 }
            }
          }
        });
      }
      if (url.endsWith('/drafts/send') && init?.method === 'POST') {
        bodies.push(typeof init.body === 'string' ? init.body : '');
        return Response.json({ id: 'sentone', threadId: 'threadsame' });
      }
      if (url.includes('/messages/send')) return Response.json({}, { status: 500 });
      return Response.json({}, { status: 500 });
    });
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined
    });
    const opened = await gmail.openDraft({
      accountId: ada,
      threadId: 'threadsame',
      messageId: 'messageone',
      composerGeneration: 4
    });
    assert.equal(opened.kind, 'reply');
    assert.equal(opened.subject, 'Re: Hello');
    await gmail.sendDraft(
      saveBody(ada, {
        draftId: opened.draftId,
        expectedMessageId: opened.messageId,
        kind: 'reply',
        threadId: 'threadsame',
        messageId: 'messageone',
        subject: 'Re: Hello',
        composerGeneration: 4
      })
    );
    const reply = JSON.parse(bodies[0] ?? '{}') as {
      id?: string;
      message?: { threadId?: string; raw?: string };
    };
    assert.equal(reply.id, 'draftone');
    assert.equal(reply.message?.threadId, 'threadsame');
    assert.equal(typeof reply.message?.raw, 'string');
    await gmail.sendDraft(
      saveBody(ada, {
        draftId: 'draftone',
        expectedMessageId: 'messageone',
        kind: 'forward',
        subject: 'Fwd: Hello',
        composerGeneration: 5
      })
    );
    const forward = JSON.parse(bodies[1] ?? '{}') as { message?: { threadId?: string } };
    assert.equal(forward.message?.threadId, undefined);
  });

  it('restores attachment bytes from Gmail and refuses another account token', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    const grace = seedGrace(database, secret);
    const file = Buffer.from('file-bytes');
    let raw = '';
    const fetchImpl = tokenThen(async (url, init) => {
      if (url.includes('/drafts?')) {
        return Response.json({
          drafts: [{ id: 'draftone', message: { id: 'messageone', threadId: 'threadnew' } }]
        });
      }
      if (url.includes('/drafts/draftone') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          id: 'draftone',
          message: {
            id: 'messageone',
            threadId: 'threadnew',
            historyId: '2',
            payload: {
              mimeType: 'multipart/mixed',
              headers: [
                { name: 'Subject', value: 'Files' },
                { name: 'To', value: 'bob@example.com' }
              ],
              parts: [
                {
                  mimeType: 'text/plain',
                  body: { data: Buffer.from('Hello').toString('base64url'), size: 5 }
                },
                {
                  partId: '1',
                  mimeType: 'text/plain',
                  filename: 'notes.txt',
                  body: { data: file.toString('base64url'), size: file.byteLength }
                }
              ]
            }
          }
        });
      }
      if (init?.method === 'PUT') {
        raw = typeof init.body === 'string' ? init.body : '';
        return Response.json({
          id: 'draftone',
          message: { id: 'messagetwo', threadId: 'threadnew', historyId: '3' }
        });
      }
      return Response.json({}, { status: 500 });
    });
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined,
      pickFiles: async () => [{ name: 'extra.txt', bytes: Uint8Array.from([1]) }]
    });
    const opened = await gmail.openDraft({
      accountId: ada,
      threadId: 'threadnew',
      messageId: 'messageone',
      composerGeneration: 6
    });
    assert.equal(opened.locked, false);
    assert.equal(opened.attachments.length, 1);
    assert.equal(opened.body, 'Hello');
    await gmail.saveDraft(
      saveBody(ada, {
        draftId: opened.draftId,
        expectedMessageId: opened.messageId,
        subject: 'Files',
        body: 'Hello',
        attachmentTokens: opened.attachments.map((item) => item.token),
        composerGeneration: 6
      })
    );
    const message = Buffer.from(
      (JSON.parse(raw) as { message: { raw: string } }).message.raw,
      'base64url'
    ).toString('utf8');
    assert.equal(message.includes('file-bytes'), false);
    assert.equal(message.includes(file.toString('base64')), true);
    const picked = await gmail.pickAttachments({ accountId: ada, composerGeneration: 7 });
    const token = picked.attachments[0]?.token ?? '';
    assert.equal(
      await gmail
        .saveDraft(saveBody(grace, { attachmentTokens: [token], composerGeneration: 7 }))
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'invalid-request'
    );
  });

  it('refuses too many files, a file over 5 MiB, and a name that would add a header', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    let posts = 0;
    const fetchImpl = tokenThen(async (url, init) => {
      if (init?.method === 'POST') {
        posts += 1;
        return Response.json({
          id: 'draftone',
          message: { id: 'messageone', threadId: 'threadnew' }
        });
      }
      return Response.json({}, { status: 500 });
    });
    const many = Array.from({ length: 11 }, () => ({
      name: 'a.txt',
      bytes: Uint8Array.from([1])
    }));
    let chosen = many;
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined,
      pickFiles: async () => chosen
    });
    assert.equal(
      await gmail.pickAttachments({ accountId: ada, composerGeneration: 8 }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'too-large'
    );
    chosen = [{ name: 'big.bin', bytes: new Uint8Array(attachmentByteLimit + 1) }];
    assert.equal(
      await gmail.pickAttachments({ accountId: ada, composerGeneration: 8 }).then(
        () => 'ok',
        (error: unknown) => code(error)
      ),
      'too-large'
    );
    chosen = [{ name: 'bad\r\nBcc: eve@example.com.txt', bytes: Uint8Array.from([9]) }];
    const picked = await gmail.pickAttachments({ accountId: ada, composerGeneration: 8 });
    assert.equal(picked.attachments[0]?.fileName.includes('\r'), false);
    await gmail.saveDraft(
      saveBody(ada, {
        attachmentTokens: picked.attachments.map((item) => item.token),
        composerGeneration: 8
      })
    );
    assert.equal(posts, 1);
  });

  it('does not download an oversized part and writes only the chosen path', async () => {
    const database = openTemp();
    const secret = cipher();
    const ada = seed(database, secret, modify);
    const directory = mkdtempSync(join(tmpdir(), 'aurora-save-'));
    directories.push(directory);
    let attachmentGets = 0;
    let writes = 0;
    const fetchImpl = tokenThen(async (url) => {
      if (url.includes('/attachments/')) {
        attachmentGets += 1;
        return Response.json({ data: Buffer.from('hello').toString('base64url'), size: 5 });
      }
      if (url.includes('messagebig')) {
        return Response.json({
          id: 'messagebig',
          payload: {
            mimeType: 'text/plain',
            filename: 'big.bin',
            body: { attachmentId: 'attachbig', size: attachmentByteLimit + 1 }
          }
        });
      }
      return Response.json({
        id: 'messageone',
        payload: {
          mimeType: 'text/plain',
          filename: '..\\notes.txt\r\nBcc: eve@example.com',
          body: { attachmentId: 'attachone', size: 5 }
        }
      });
    });
    const target = join(directory, 'chosen.txt');
    let suggested = '';
    const gmail = createGmailReader({
      accounts: createGoogleAccountService({
        database,
        cipher: secret,
        fetchImpl,
        openExternal: async () => undefined
      }),
      fetchImpl,
      openExternal: async () => undefined,
      chooseSavePath: async (fileName) => {
        suggested = fileName;
        return target;
      },
      writeSave: async (path) => {
        writes += 1;
        assert.equal(path, target);
      }
    });
    assert.equal(
      await gmail
        .downloadAttachment({
          accountId: ada,
          messageId: 'messagebig',
          partId: null,
          attachmentId: 'attachbig'
        })
        .then(
          () => 'ok',
          (error: unknown) => code(error)
        ),
      'too-large'
    );
    assert.equal(attachmentGets, 0);
    const saved = await gmail.downloadAttachment({
      accountId: ada,
      messageId: 'messageone',
      partId: null,
      attachmentId: 'attachone'
    });
    assert.equal(saved.saved, true);
    assert.equal(writes, 1);
    assert.equal(suggested.includes('\\'), false);
    assert.equal(suggested.includes('\r'), false);
    assert.equal(attachmentGets, 1);
  });
});
