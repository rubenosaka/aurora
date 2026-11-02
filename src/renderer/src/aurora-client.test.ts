import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuroraIpcError, type AppInfo, type AuroraBridge } from '../../shared/app-info.ts';
import { GoogleIpcError, type GoogleBridge } from '../../shared/google-accounts.ts';
import { createRendererAppApi } from './aurora-client.ts';

const info: AppInfo = { name: 'aurora', version: '0.0.0', platform: 'win32' };

function google(): GoogleBridge {
  return {
    getClientId: async () => ({ ok: false, error: { code: 'internal' } }),
    saveClientId: async () => ({ ok: false, error: { code: 'internal' } }),
    listAccounts: async () => ({ ok: false, error: { code: 'internal' } }),
    connect: async () => ({ ok: false, error: { code: 'internal' } }),
    reconnect: async () => ({ ok: false, error: { code: 'internal' } }),
    cancel: async () => ({ ok: false, error: { code: 'internal' } }),
    disconnect: async () => ({ ok: false, error: { code: 'internal' } })
  };
}

function bridge(getInfo: AuroraBridge['app']['getInfo']): AuroraBridge {
  return { app: { getInfo }, google: google() };
}

describe('createRendererAppApi', () => {
  it('returns AppInfo', async () => {
    const api = createRendererAppApi(bridge(async () => ({ ok: true, value: info })));
    assert.deepEqual(await api.app.getInfo(), info);
  });

  it('rejects with AuroraIpcError for an unauthorized result', async () => {
    const api = createRendererAppApi(
      bridge(async () => ({ ok: false, error: { code: 'unauthorized' } }))
    );
    await assert.rejects(api.app.getInfo(), (error: unknown) => {
      assert.ok(error instanceof AuroraIpcError);
      assert.equal(error.code, 'unauthorized');
      return true;
    });
  });

  it('rejects an invalid envelope without copying its contents', async () => {
    const api = createRendererAppApi(
      bridge(async () => ({ ok: false, error: { code: 'C:\\secret\\path' } }) as never)
    );
    await assert.rejects(api.app.getInfo(), (error: unknown) => {
      assert.ok(error instanceof AuroraIpcError);
      assert.equal(error.code, 'invalid-response');
      assert.equal(
        JSON.stringify({ message: error.message, code: error.code }).includes('secret'),
        false
      );
      return true;
    });
  });

  it('converts an IPC transport failure into AuroraIpcError internal', async () => {
    const api = createRendererAppApi(
      bridge(async () => {
        throw new Error('C:\\secret\\aurora\\user.dat');
      })
    );
    await assert.rejects(api.app.getInfo(), (error: unknown) => {
      assert.ok(error instanceof AuroraIpcError);
      assert.equal(error.code, 'internal');
      assert.equal(error.message.includes('secret'), false);
      assert.equal(error.stack?.includes('secret') ?? false, false);
      return true;
    });
  });

  it('unwraps every Google method', async () => {
    const account = {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'ada@example.com',
      displayName: 'Ada',
      status: 'connected' as const
    };
    const api = createRendererAppApi({
      ...bridge(async () => ({ ok: true, value: info })),
      google: {
        getClientId: async () => ({
          ok: true,
          value: { clientId: null, secretConfigured: false }
        }),
        saveClientId: async () => ({
          ok: true,
          value: {
            clientId: 'desktop-client.apps.googleusercontent.com',
            secretConfigured: true
          }
        }),
        listAccounts: async () => ({ ok: true, value: { accounts: [account] } }),
        connect: async () => ({ ok: true, value: account }),
        reconnect: async () => ({ ok: true, value: account }),
        cancel: async () => ({ ok: true, value: { cancelled: true } }),
        disconnect: async () => {
          throw new Error('C:\\secret\\refresh-token-one');
        }
      }
    });
    assert.deepEqual(await api.google.getClientId(), {
      clientId: null,
      secretConfigured: false
    });
    assert.equal(
      (
        await api.google.saveClientId(
          'desktop-client.apps.googleusercontent.com',
          'client-secret-value'
        )
      ).clientId,
      'desktop-client.apps.googleusercontent.com'
    );
    assert.equal((await api.google.listAccounts()).accounts.length, 1);
    assert.equal((await api.google.connect()).id, account.id);
    assert.equal((await api.google.reconnect(account.id)).status, 'connected');
    assert.deepEqual(await api.google.cancel(), { cancelled: true });
    await assert.rejects(api.google.disconnect(account.id), (error: unknown) => {
      assert.ok(error instanceof GoogleIpcError);
      assert.equal(error.code, 'internal');
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  });

  it('unwraps a Google account result and hides a leaked token', async () => {
    const api = createRendererAppApi({
      ...bridge(async () => ({ ok: true, value: info })),
      google: {
        ...google(),
        disconnect: async () =>
          ({
            ok: true,
            value: { outcome: 'revoked', refreshToken: 'refresh-token-one' }
          }) as Awaited<ReturnType<GoogleBridge['disconnect']>>
      }
    });
    await assert.rejects(
      api.google.disconnect('00000000-0000-4000-8000-000000000001'),
      (error: unknown) => {
        assert.ok(error instanceof GoogleIpcError);
        assert.equal(error.code, 'invalid-response');
        assert.equal(error.message.includes('refresh-token-one'), false);
        return true;
      }
    );
  });
});
