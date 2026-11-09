import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type IpcMainInvokeEvent } from 'electron';
import { GmailError } from './gmail/errors.ts';
import { type GmailReader } from './gmail/reader.ts';
import { attachGmailIpc, handleGmailChannel } from './gmail-ipc.ts';
import { type SenderSnapshot } from './trusted-sender.ts';
import {
  gmailAttachmentDownloadChannel,
  gmailAttachmentDropChannel,
  gmailAttachmentPickChannel,
  gmailBulkLabelChannel,
  gmailBulkThreadsChannel,
  gmailDraftDeleteChannel,
  gmailLabelCreateChannel,
  gmailLabelDeleteChannel,
  gmailLabelRenameChannel,
  gmailDraftOpenChannel,
  gmailDraftSaveChannel,
  gmailDraftSendChannel,
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
    saveDraft: async () => ({ draftId: 'draftone', messageId: 'messageone', threadId: null }),
    openDraft: async () => ({
      locked: false,
      draftId: 'draftone',
      messageId: 'messageone',
      threadId: null,
      kind: 'new' as const,
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      body: '',
      subjectLocked: false,
      attachments: []
    }),
    deleteDraft: async () => ({ deleted: true as const }),
    sendDraft: async () => ({ id: 'messagesent', threadId: null }),
    pickAttachments: async () => ({ attachments: [] }),
    dropAttachment: async () => ({ dropped: true as const }),
    downloadAttachment: async () => ({ saved: true }),
    bulkThreads: async () => ({
      succeeded: ['threadsame'],
      failed: [],
      unconfirmed: [],
      notAttempted: []
    }),
    bulkLabel: async () => ({
      succeeded: ['threadsame'],
      failed: [],
      unconfirmed: [],
      notAttempted: []
    }),
    createLabel: async () => ({ id: 'Label_1', name: 'Trips' }),
    renameLabel: async () => ({ id: 'Label_1', name: 'Travel' }),
    deleteLabel: async () => ({ id: 'Label_1' }),
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

  it('saves, opens, deletes, sends, and transfers attachments on their own channels', async () => {
    const save = {
      accountId,
      draftId: null,
      expectedMessageId: null,
      kind: 'new' as const,
      threadId: null,
      messageId: null,
      to: ['bob@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      body: 'Hi',
      attachmentTokens: [],
      replaceConfirmed: false,
      composerGeneration: 1
    };
    assert.deepEqual(await handleGmailChannel(gmailDraftSaveChannel, sender(), [save], reader()), {
      ok: true,
      value: { draftId: 'draftone', messageId: 'messageone', threadId: null }
    });
    assert.deepEqual(
      await handleGmailChannel(
        gmailDraftSaveChannel,
        sender(),
        [{ ...save, raw: 'nope' }],
        reader()
      ),
      { ok: false, error: { code: 'invalid-request' } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailDraftOpenChannel,
        sender(),
        [
          {
            accountId,
            threadId: 'threadsame',
            messageId: 'messageone',
            composerGeneration: 1
          }
        ],
        reader()
      ),
      {
        ok: true,
        value: {
          locked: false,
          draftId: 'draftone',
          messageId: 'messageone',
          threadId: null,
          kind: 'new',
          to: [],
          cc: [],
          bcc: [],
          subject: '',
          body: '',
          subjectLocked: false,
          attachments: []
        }
      }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailDraftDeleteChannel,
        sender(),
        [{ accountId, draftId: 'draftone', expectedMessageId: 'messageone' }],
        reader()
      ),
      { ok: true, value: { deleted: true } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailDraftSendChannel,
        sender(),
        [{ ...save, draftId: 'draftone', expectedMessageId: 'messageone', raw: 'nope' }],
        reader()
      ),
      { ok: false, error: { code: 'invalid-request' } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailDraftSendChannel,
        sender(),
        [{ ...save, draftId: 'draftone', expectedMessageId: 'messageone' }],
        reader()
      ),
      { ok: true, value: { id: 'messagesent', threadId: null } }
    );
    const token = 'A'.repeat(32);
    assert.deepEqual(
      await handleGmailChannel(
        gmailAttachmentPickChannel,
        sender(),
        [{ accountId, composerGeneration: 1 }],
        reader()
      ),
      { ok: true, value: { attachments: [] } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailAttachmentDropChannel,
        sender(),
        [{ accountId, composerGeneration: 1, token }],
        reader()
      ),
      { ok: true, value: { dropped: true } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailAttachmentDownloadChannel,
        sender(),
        [{ accountId, messageId: 'messageone', partId: '1', attachmentId: null }],
        reader()
      ),
      { ok: true, value: { saved: true } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailAttachmentDownloadChannel,
        sender(),
        [{ accountId, messageId: 'messageone', partId: '../1', attachmentId: null }],
        reader()
      ),
      { ok: false, error: { code: 'invalid-request' } }
    );
    let bulkCalls = 0;
    const bulkReader = reader({
      bulkThreads: async () => {
        bulkCalls += 1;
        return {
          succeeded: ['threadsame'],
          failed: [],
          unconfirmed: [],
          notAttempted: [],
          access_token: 'access-a'
        } as unknown as Awaited<ReturnType<GmailReader['bulkThreads']>>;
      }
    });
    assert.deepEqual(
      await handleGmailChannel(
        gmailBulkThreadsChannel,
        sender(),
        [{ accountId, threadIds: ['threadsame'], action: 'read', extra: true }],
        bulkReader
      ),
      { ok: false, error: { code: 'invalid-request' } }
    );
    assert.equal(bulkCalls, 0);
    assert.deepEqual(
      await handleGmailChannel(
        gmailBulkThreadsChannel,
        sender(),
        [
          {
            accountId,
            threadIds: Array.from({ length: 21 }, (_, index) => `thread${index}`),
            action: 'read'
          }
        ],
        bulkReader
      ),
      { ok: false, error: { code: 'invalid-request' } }
    );
    const leaked = await handleGmailChannel(
      gmailBulkThreadsChannel,
      sender(),
      [{ accountId, threadIds: ['threadsame'], action: 'read' }],
      bulkReader
    );
    assert.deepEqual(leaked, { ok: false, error: { code: 'invalid-response' } });
    assert.equal(JSON.stringify(leaked).includes('access-a'), false);
    const empty = {
      succeeded: ['threadsame'],
      failed: [],
      unconfirmed: [],
      notAttempted: []
    };
    assert.deepEqual(
      await handleGmailChannel(
        gmailBulkThreadsChannel,
        sender(),
        [{ accountId, threadIds: ['threadsame'], action: 'read' }],
        reader()
      ),
      { ok: true, value: empty }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailBulkLabelChannel,
        sender(),
        [{ accountId, threadIds: ['threadsame'], labelId: 'Label_1', mode: 'remove' }],
        reader()
      ),
      { ok: true, value: empty }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailLabelCreateChannel,
        sender(),
        [{ accountId, name: 'Trips' }],
        reader()
      ),
      { ok: true, value: { id: 'Label_1', name: 'Trips' } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailLabelRenameChannel,
        sender(),
        [{ accountId, labelId: 'Label_1', name: 'Travel' }],
        reader()
      ),
      { ok: true, value: { id: 'Label_1', name: 'Travel' } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailLabelDeleteChannel,
        sender(),
        [{ accountId, labelId: 'Label_1' }],
        reader()
      ),
      { ok: true, value: { id: 'Label_1' } }
    );
    assert.deepEqual(
      await handleGmailChannel(
        gmailLabelCreateChannel,
        sender(),
        [{ accountId, name: 'Trips' }],
        reader({
          createLabel: async () => {
            throw new GmailError('label-exists');
          }
        })
      ),
      { ok: false, error: { code: 'label-exists' } }
    );
  });
});

function isRecord(value: unknown): value is { ok: boolean } {
  return typeof value === 'object' && value !== null && 'ok' in value;
}
