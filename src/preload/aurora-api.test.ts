import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appInfoChannel, type AppInfo } from '../shared/app-info.ts';
import {
  gmailAttachmentDownloadChannel,
  gmailAttachmentDropChannel,
  gmailAttachmentPickChannel,
  gmailBulkLabelChannel,
  gmailBulkThreadsChannel,
  gmailLabelCreateChannel,
  gmailLabelDeleteChannel,
  gmailLabelRenameChannel,
  gmailDraftDeleteChannel,
  gmailDraftOpenChannel,
  gmailDraftSaveChannel,
  gmailDraftSendChannel,
  gmailOpenLinkChannel,
  gmailThreadChannel,
  gmailThreadsChannel
} from '../shared/gmail.ts';
import {
  googleAccountsCancelChannel,
  googleAccountsConnectChannel,
  googleAccountsDisconnectChannel,
  googleAccountsListChannel,
  googleAccountsReconnectChannel,
  googleClientGetChannel,
  googleClientSaveChannel
} from '../shared/google-accounts.ts';
import { createAuroraApi } from './aurora-api.ts';

const info: AppInfo = { name: 'aurora', version: '0.0.0', platform: 'win32' };

describe('createAuroraApi', () => {
  it('exposes only app.getInfo and the Google account methods', () => {
    const api = createAuroraApi(async () => ({ ok: true, value: info }));
    assert.deepEqual(Object.keys(api), ['app', 'google', 'gmail']);
    assert.deepEqual(Object.getOwnPropertyNames(api.app), ['getInfo']);
    assert.deepEqual(Object.getOwnPropertyNames(api.google), [
      'getClientId',
      'saveClientId',
      'listAccounts',
      'connect',
      'reconnect',
      'cancel',
      'disconnect'
    ]);
    assert.deepEqual(Object.getOwnPropertyNames(api.gmail), [
      'listLabels',
      'listThreads',
      'readThread',
      'openLink',
      'markRead',
      'markUnread',
      'archiveThread',
      'trashThread',
      'untrashThread',
      'addLabel',
      'removeLabel',
      'starMessage',
      'unstarMessage',
      'composeSeed',
      'sendMessage',
      'saveDraft',
      'openDraft',
      'deleteDraft',
      'sendDraft',
      'pickAttachments',
      'dropAttachment',
      'downloadAttachment',
      'bulkThreads',
      'bulkLabel',
      'createLabel',
      'renameLabel',
      'deleteLabel',
      'syncStatus',
      'setNotifications',
      'reportSyncView',
      'syncFocus',
      'listenSync',
      'listenOpen'
    ]);
    assert.equal(Object.isFrozen(api), true);
    assert.equal(Object.isFrozen(api.app), true);
    assert.equal(Object.isFrozen(api.google), true);
    assert.equal(Object.isFrozen(api.gmail), true);
    assert.equal('ipcRenderer' in api, false);
    assert.equal('invoke' in api, false);
  });

  it('invokes only the app info channel and passes no arguments', async () => {
    const calls: unknown[][] = [];
    const api = createAuroraApi(async (...received: unknown[]) => {
      calls.push(received);
      return { ok: true, value: info };
    });
    assert.deepEqual(await api.app.getInfo(), { ok: true, value: info });
    assert.deepEqual(calls, [[appInfoChannel]]);
  });

  it('converts an IPC transport failure into a safe internal result', async () => {
    const api = createAuroraApi(async () => {
      throw new Error('C:\\secret\\aurora\\user.dat');
    });
    const result = await api.app.getInfo();
    assert.deepEqual(result, { ok: false, error: { code: 'internal' } });
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });

  it('asks for the Google client id on its own channel and hides extra fields', async () => {
    const calls: unknown[][] = [];
    const api = createAuroraApi(async (...received: unknown[]) => {
      calls.push(received);
      return {
        ok: true,
        value: {
          clientId: 'desktop-client.apps.googleusercontent.com',
          refreshToken: 'refresh-token-one'
        }
      };
    });
    const result = await api.google.getClientId();
    assert.deepEqual(result, { ok: false, error: { code: 'invalid-response' } });
    assert.deepEqual(calls, [[googleClientGetChannel]]);
    assert.equal(JSON.stringify(result).includes('refresh-token-one'), false);
  });

  it('forwards each Google call and hides transport failures', async () => {
    const account = {
      id: '00000000-0000-4000-8000-000000000001',
      email: null,
      displayName: null,
      status: 'needs_reauth' as const,
      canModifyMail: false
    };
    const responses = new Map<string, unknown>([
      [
        googleClientSaveChannel,
        {
          ok: true,
          value: {
            clientId: 'desktop-client.apps.googleusercontent.com',
            secretConfigured: false
          }
        }
      ],
      [googleAccountsListChannel, { ok: true, value: { accounts: [account] } }],
      [googleAccountsConnectChannel, { ok: true, value: account }],
      [googleAccountsReconnectChannel, { ok: true, value: account }],
      [googleAccountsCancelChannel, { ok: true, value: { cancelled: true } }],
      [googleAccountsDisconnectChannel, { ok: true, value: { outcome: 'disconnected-local' } }]
    ]);
    const api = createAuroraApi(async (channel) => {
      const response = responses.get(channel);
      if (response === undefined) throw new Error('C:\\secret\\refresh-token-one');
      return response;
    });
    assert.equal(
      (await api.google.saveClientId('desktop-client.apps.googleusercontent.com', null)).ok,
      true
    );
    assert.equal((await api.google.listAccounts()).ok, true);
    assert.equal((await api.google.connect()).ok, true);
    assert.equal((await api.google.reconnect(account.id)).ok, true);
    assert.equal((await api.google.cancel()).ok, true);
    assert.equal((await api.google.disconnect(account.id)).ok, true);
    const failed = await api.google.getClientId();
    assert.deepEqual(failed, { ok: false, error: { code: 'internal' } });
    assert.equal(JSON.stringify(failed).includes('secret'), false);
  });

  it('submits a client secret and rejects a response that contains it', async () => {
    const calls: unknown[][] = [];
    const api = createAuroraApi(async (...received: unknown[]) => {
      calls.push(received);
      return {
        ok: true,
        value: {
          clientId: 'desktop-client.apps.googleusercontent.com',
          secretConfigured: true,
          clientSecret: 'client-secret-value'
        }
      };
    });
    const result = await api.google.saveClientId(
      'desktop-client.apps.googleusercontent.com',
      'client-secret-value'
    );
    assert.deepEqual(calls, [
      [
        googleClientSaveChannel,
        {
          clientId: 'desktop-client.apps.googleusercontent.com',
          clientSecret: 'client-secret-value'
        }
      ]
    ]);
    assert.deepEqual(result, { ok: false, error: { code: 'invalid-response' } });
    assert.equal(JSON.stringify(result).includes('client-secret-value'), false);
  });

  it('rejects a gmail response that contains an access token', async () => {
    const api = createAuroraApi(async () => ({
      ok: true,
      value: { labels: [], access_token: 'access-a' }
    }));
    const result = await api.gmail.listLabels('00000000-0000-4000-8000-000000000001');
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes('access-a'), false);
    const calls: unknown[] = [];
    const opened = createAuroraApi(async (...received: unknown[]) => {
      calls.push(received[0]);
      return { ok: true, value: { opened: true } };
    });
    assert.deepEqual(await opened.gmail.openLink('https://example.com'), {
      ok: true,
      value: { opened: true }
    });
    assert.deepEqual(calls, [gmailOpenLinkChannel]);
    const accountId = '00000000-0000-4000-8000-000000000001';
    const reading = createAuroraApi(async (channel: unknown) => {
      if (channel === gmailThreadsChannel) {
        return { ok: true, value: { threads: [], nextPageToken: null } };
      }
      if (channel === gmailThreadChannel) {
        return { ok: true, value: { id: 'threadsame', messages: [] } };
      }
      throw new Error('down');
    });
    assert.equal(
      (
        await reading.gmail.listThreads({
          accountId,
          labelId: 'INBOX',
          query: null,
          pageToken: null
        })
      ).ok,
      true
    );
    assert.equal((await reading.gmail.readThread(accountId, 'threadsame')).ok, true);
    assert.equal((await reading.gmail.listLabels(accountId)).ok, false);
    const drafts = createAuroraApi(async (channel: unknown) => {
      if (channel === gmailDraftSaveChannel) {
        return {
          ok: true,
          value: { draftId: 'draftone', messageId: 'messageone', threadId: null }
        };
      }
      if (channel === gmailDraftOpenChannel) {
        return {
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
        };
      }
      if (channel === gmailDraftDeleteChannel) return { ok: true, value: { deleted: true } };
      if (channel === gmailDraftSendChannel) {
        return { ok: true, value: { id: 'messagesent', threadId: null } };
      }
      if (channel === gmailAttachmentPickChannel) return { ok: true, value: { attachments: [] } };
      if (channel === gmailAttachmentDropChannel) return { ok: true, value: { dropped: true } };
      if (channel === gmailAttachmentDownloadChannel) return { ok: true, value: { saved: false } };
      if (channel === gmailBulkThreadsChannel || channel === gmailBulkLabelChannel) {
        return {
          ok: true,
          value: {
            succeeded: ['threadsame'],
            failed: [],
            unconfirmed: [],
            notAttempted: []
          }
        };
      }
      if (channel === gmailLabelCreateChannel || channel === gmailLabelRenameChannel) {
        return { ok: true, value: { id: 'Label_1', name: 'Trips' } };
      }
      if (channel === gmailLabelDeleteChannel) return { ok: true, value: { id: 'Label_1' } };
      return { ok: false, error: { code: 'internal' } };
    });
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
    assert.equal((await drafts.gmail.saveDraft(save)).ok, true);
    assert.equal(
      (
        await drafts.gmail.openDraft({
          accountId,
          threadId: 'threadsame',
          messageId: 'messageone',
          composerGeneration: 1
        })
      ).ok,
      true
    );
    assert.equal(
      (
        await drafts.gmail.deleteDraft({
          accountId,
          draftId: 'draftone',
          expectedMessageId: 'messageone'
        })
      ).ok,
      true
    );
    assert.equal(
      (
        await drafts.gmail.sendDraft({
          ...save,
          draftId: 'draftone',
          expectedMessageId: 'messageone'
        })
      ).ok,
      true
    );
    assert.equal(
      (await drafts.gmail.pickAttachments({ accountId, composerGeneration: 1 })).ok,
      true
    );
    assert.equal(
      (
        await drafts.gmail.dropAttachment({
          accountId,
          composerGeneration: 1,
          token: 'A'.repeat(32)
        })
      ).ok,
      true
    );
    assert.equal(
      (
        await drafts.gmail.downloadAttachment({
          accountId,
          messageId: 'messageone',
          partId: '1',
          attachmentId: null
        })
      ).ok,
      true
    );
    const bulk = {
      accountId,
      threadIds: ['threadsame'],
      action: 'read' as const
    };
    assert.equal((await drafts.gmail.bulkThreads(bulk)).ok, true);
    assert.equal(
      (
        await drafts.gmail.bulkLabel({
          accountId,
          threadIds: ['threadsame'],
          labelId: 'Label_1',
          mode: 'add' as const
        })
      ).ok,
      true
    );
    assert.equal((await drafts.gmail.createLabel({ accountId, name: 'Trips' })).ok, true);
    assert.equal(
      (await drafts.gmail.renameLabel({ accountId, labelId: 'Label_1', name: 'Travel' })).ok,
      true
    );
    assert.equal((await drafts.gmail.deleteLabel({ accountId, labelId: 'Label_1' })).ok, true);
  });

  it('rejects an invalid IPC result envelope', async () => {
    const api = createAuroraApi(async () => ({ ok: true, value: info, leaked: 'C:\\secret' }));
    const result = await api.app.getInfo();
    assert.deepEqual(result, { ok: false, error: { code: 'invalid-response' } });
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });
});
