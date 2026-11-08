import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OAuthFlowError } from './oauth/errors.ts';
import { type GoogleAccountService } from './oauth/google-accounts.ts';
import {
  googleAccountsCancelChannel,
  googleAccountsConnectChannel,
  googleAccountsDisconnectChannel,
  googleAccountsListChannel,
  googleAccountsReconnectChannel,
  googleChannels,
  googleClientGetChannel,
  googleClientSaveChannel
} from '../shared/google-accounts.ts';
import { attachGoogleIpc, handleGoogleChannel } from './google-ipc.ts';
import { type SenderSnapshot } from './trusted-sender.ts';

const account = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'ada@example.com',
  displayName: 'Ada',
  status: 'connected' as const,
  canModifyMail: true
};

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

function service(overrides: Partial<GoogleAccountService> = {}): GoogleAccountService {
  return {
    getClientId: () => ({ clientId: null, secretConfigured: false }),
    saveClientId: (clientId, clientSecret) => ({
      clientId,
      secretConfigured: clientSecret !== null && clientSecret !== undefined
    }),
    listAccounts: () => [],
    connect: async () => account,
    reconnect: async () => account,
    cancel: () => ({ cancelled: true }),
    disconnect: async () => ({ outcome: 'revoked' }),
    refreshAccount: async () => undefined,
    beginMailboxRead: () => undefined,
    endMailboxRead: () => undefined,
    mailboxAccess: async () => 'access-token-value',
    modificationGrant: () => 'ready',
    forgetMailboxAccess: () => undefined,
    shutdown: () => undefined,
    ...overrides
  };
}

type GoogleListener = Parameters<Parameters<typeof attachGoogleIpc>[0]>[1];

describe('Google IPC', () => {
  it('registers the channels and returns summaries without credentials', async () => {
    const listeners = new Map<string, GoogleListener>();
    attachGoogleIpc(
      (channel, listener) => {
        listeners.set(channel, listener);
      },
      () => sender(),
      service()
    );
    assert.deepEqual([...listeners.keys()], [...googleChannels]);
    const clientId = 'desktop-client.apps.googleusercontent.com';
    const event = {} as Parameters<GoogleListener>[0];
    assert.deepEqual(await listeners.get(googleClientGetChannel)?.(event), {
      ok: true,
      value: { clientId: null, secretConfigured: false }
    });
    assert.deepEqual(
      await listeners.get(googleClientSaveChannel)?.(event, { clientId, clientSecret: null }),
      {
        ok: true,
        value: { clientId, secretConfigured: false }
      }
    );
    assert.deepEqual(await listeners.get(googleAccountsListChannel)?.(event), {
      ok: true,
      value: { accounts: [] }
    });
    assert.deepEqual(await listeners.get(googleAccountsConnectChannel)?.(event), {
      ok: true,
      value: account
    });
    assert.deepEqual(
      await listeners.get(googleAccountsReconnectChannel)?.(event, { accountId: account.id }),
      { ok: true, value: account }
    );
    assert.deepEqual(await listeners.get(googleAccountsCancelChannel)?.(event), {
      ok: true,
      value: { cancelled: true }
    });
  });

  it('rejects an unauthorized sender before any account operation', async () => {
    let calls = 0;
    const result = await handleGoogleChannel(
      googleAccountsDisconnectChannel,
      sender({ senderId: 4 }),
      [{ accountId: account.id }],
      service({
        disconnect: async () => {
          calls += 1;
          return { outcome: 'revoked' };
        }
      })
    );
    assert.deepEqual(result, { ok: false, error: { code: 'unauthorized' } });
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(result).includes('refresh'), false);
  });

  it('rejects a malformed client id and hides a response that carries a token', async () => {
    const invalid = await handleGoogleChannel(
      googleClientSaveChannel,
      sender(),
      [{ clientId: 'not-a-client', refreshToken: 'refresh-token-one' }],
      service()
    );
    assert.deepEqual(invalid, { ok: false, error: { code: 'invalid-request' } });
    assert.equal(JSON.stringify(invalid).includes('refresh-token-one'), false);
    const secretInResponse = await handleGoogleChannel(
      googleClientGetChannel,
      sender(),
      [],
      service({
        getClientId: () =>
          ({
            clientId: null,
            secretConfigured: true,
            clientSecret: 'client-secret-value'
          }) as { clientId: null; secretConfigured: boolean }
      })
    );
    assert.deepEqual(secretInResponse, { ok: false, error: { code: 'invalid-response' } });
    assert.equal(JSON.stringify(secretInResponse).includes('client-secret-value'), false);
    const leaked = await handleGoogleChannel(
      googleAccountsDisconnectChannel,
      sender(),
      [{ accountId: account.id }],
      service({
        disconnect: async () =>
          ({ outcome: 'revoked', refreshToken: 'refresh-token-one' }) as { outcome: 'revoked' }
      })
    );
    assert.deepEqual(leaked, { ok: false, error: { code: 'invalid-response' } });
    assert.equal(JSON.stringify(leaked).includes('refresh-token-one'), false);
  });

  it('returns only the disconnect outcome and a fixed error code', async () => {
    const result = await handleGoogleChannel(
      googleAccountsDisconnectChannel,
      sender(),
      [{ accountId: account.id }],
      service()
    );
    assert.deepEqual(result, { ok: true, value: { outcome: 'revoked' } });
    const failed = await handleGoogleChannel(
      googleAccountsDisconnectChannel,
      sender(),
      [{ accountId: account.id }],
      service({
        disconnect: async () => {
          throw new OAuthFlowError('operation-in-progress');
        }
      })
    );
    assert.deepEqual(failed, { ok: false, error: { code: 'operation-in-progress' } });
    const internal = await handleGoogleChannel(
      googleAccountsDisconnectChannel,
      sender(),
      [{ accountId: account.id }],
      service({
        disconnect: async () => {
          throw new Error('C:\\secret\\refresh-token-one');
        }
      })
    );
    assert.deepEqual(internal, { ok: false, error: { code: 'internal' } });
    assert.equal(JSON.stringify(internal).includes('secret'), false);
  });
});
