import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appInfoChannel, type AppInfo } from '../shared/app-info.ts';
import { gmailOpenLinkChannel, gmailThreadChannel, gmailThreadsChannel } from '../shared/gmail.ts';
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
      'openLink'
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
      status: 'needs_reauth' as const
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
  });

  it('rejects an invalid IPC result envelope', async () => {
    const api = createAuroraApi(async () => ({ ok: true, value: info, leaked: 'C:\\secret' }));
    const result = await api.app.getInfo();
    assert.deepEqual(result, { ok: false, error: { code: 'invalid-response' } });
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });
});
