import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type IpcMainInvokeEvent } from 'electron';
import { GmailError } from './gmail/errors.ts';
import { type GmailReader } from './gmail/reader.ts';
import { attachGmailIpc, handleGmailChannel } from './gmail-ipc.ts';
import { type SenderSnapshot } from './trusted-sender.ts';
import {
  gmailLabelsChannel,
  gmailOpenLinkChannel,
  gmailSendMessageChannel,
  gmailThreadChannel,
  gmailThreadsChannel
} from '../shared/gmail.ts';

const accountId = '00000000-0000-4000-8000-000000000001';

function sender(overrides: Partial<SenderSnapshot> = {}): SenderSnapshot {
  return {
    senderId: 7,
    authorizedSenderId: 7,
    frameUrl: 'http://localhost:5173/',
    isMainFrame: true,
    authorizedUrl: 'http://localhost:5173/',
    ...overrides
  };
}

const leakedThread = {
  id: 'threadsame',
  messages: [],
  access_token: 'access-a'
};

function reader(overrides: Partial<GmailReader> = {}): GmailReader {
  return {
    listLabels: async () => ({ labels: [] }),
    listThreads: async () => ({ threads: [], nextPageToken: null }),
    readThread: async () => leakedThread,
    openLink: async () => ({ opened: true }),
    markRead: async () => ({ threadId: 'threadsame', unread: false }),
    markUnread: async () => ({ threadId: 'threadsame', unread: true }),
    archiveThread: async () => ({ threadId: 'threadsame' }),
    trashThread: async () => ({ threadId: 'threadsame' }),
    untrashThread: async () => ({ threadId: 'threadsame' }),
    addLabel: async () => ({ threadId: 'threadsame', labelId: 'Label_1' }),
    removeLabel: async () => ({ threadId: 'threadsame', labelId: 'Label_1' }),
    starMessage: async () => ({
      threadId: 'threadsame',
      messageId: 'messageone',
      starred: true
    }),
    unstarMessage: async () => ({
      threadId: 'threadsame',
      messageId: 'messageone',
      starred: false
    }),
    composeSeed: async () => ({ to: [], cc: [], subject: '' }),
    sendMessage: async () => ({ id: 'messagesent', threadId: null }),
    ...overrides
  };
}

describe('gmail ipc', () => {
  it('rejects an unauthorized sender before the reader runs', async () => {
    let called = false;
    const result = await handleGmailChannel(
      gmailThreadChannel,
      sender({ senderId: 4 }),
      [{ accountId, threadId: 'threadsame' }],
      reader({
        readThread: async () => {
          called = true;
          return { id: 'threadsame', messages: [] };
        }
      })
    );
    assert.equal(called, false);
    assert.deepEqual(result, { ok: false, error: { code: 'unauthorized' } });
  });

  it('rejects a thread response that contains an access token', async () => {
    const result = await handleGmailChannel(
      gmailThreadChannel,
      sender(),
      [{ accountId, threadId: 'threadsame' }],
      reader()
    );
    assert.deepEqual(result, { ok: false, error: { code: 'invalid-response' } });
    assert.equal(JSON.stringify(result).includes('access-a'), false);
  });

  it('returns labels, thread lists, and opened links', async () => {
    const labels = await handleGmailChannel(
      gmailLabelsChannel,
      sender(),
      [{ accountId }],
      reader({
        listLabels: async () => ({
          labels: [{ id: 'INBOX', name: 'INBOX', type: 'system', unreadCount: null }]
        })
      })
    );
    assert.equal(labels.ok, true);
    const threads = await handleGmailChannel(
      gmailThreadsChannel,
      sender(),
      [{ accountId, labelId: 'INBOX', query: null, pageToken: null }],
      reader()
    );
    assert.equal(threads.ok, true);
    const opened = await handleGmailChannel(
      gmailOpenLinkChannel,
      sender(),
      [{ url: 'https://example.com' }],
      reader()
    );
    assert.deepEqual(opened, { ok: true, value: { opened: true } });
    assert.deepEqual(await handleGmailChannel('gmail:nope', sender(), [], reader()), {
      ok: false,
      error: { code: 'invalid-request' }
    });
    assert.deepEqual(await handleGmailChannel(gmailLabelsChannel, sender(), [{}], reader()), {
      ok: false,
      error: { code: 'invalid-request' }
    });
    assert.deepEqual(
      await handleGmailChannel(
        gmailLabelsChannel,
        sender(),
        [{ accountId }],
        reader({
          listLabels: async () => {
            throw new GmailError('not-found');
          }
        })
      ),
      { ok: false, error: { code: 'not-found' } }
    );
    const listeners = new Map<
      string,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
    >();
    attachGmailIpc(
      (channel, listener) => {
        listeners.set(channel, listener);
      },
      () => sender(),
      reader()
    );
    const listed = await listeners.get(gmailLabelsChannel)?.({} as IpcMainInvokeEvent, {
      accountId
    });
    assert.equal(isRecord(listed) && listed.ok, true);
    assert.deepEqual(
      await handleGmailChannel(gmailThreadChannel, sender(), [{ accountId }], reader()),
      { ok: false, error: { code: 'invalid-request' } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailOpenLinkChannel,
        sender(),
        [{ url: 'https://example.com' }],
        reader({
          openLink: async () => {
            throw new Error('boom');
          }
        })
      ),
      { ok: false, error: { code: 'internal' } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailOpenLinkChannel,
        sender(),
        [{ url: 'https://example.com' }],
        reader({
          openLink: async () =>
            ({ opened: false }) as unknown as Awaited<ReturnType<GmailReader['openLink']>>
        })
      ),
      { ok: false, error: { code: 'invalid-response' } }
    );
    const sent = {
      accountId,
      kind: 'new',
      threadId: null,
      messageId: null,
      to: ['bob@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      body: 'Hi'
    };
    assert.deepEqual(
      await handleGmailChannel(
        gmailSendMessageChannel,
        sender(),
        [{ ...sent, raw: 'nope' }],
        reader()
      ),
      { ok: false, error: { code: 'invalid-request' } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailSendMessageChannel,
        sender(),
        [sent],
        reader({
          sendMessage: async () =>
            ({ id: 'sentone', threadId: null, access_token: 'access-a' }) as unknown as Awaited<
              ReturnType<GmailReader['sendMessage']>
            >
        })
      ),
      { ok: false, error: { code: 'invalid-response' } }
    );
  });
});

function isRecord(value: unknown): value is { ok: boolean } {
  return typeof value === 'object' && value !== null && 'ok' in value;
}
