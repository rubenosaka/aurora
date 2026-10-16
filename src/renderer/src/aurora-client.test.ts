import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuroraIpcError, type AppInfo, type AuroraBridge } from '../../shared/app-info.ts';
import { createRendererAppApi } from './aurora-client.ts';

const info: AppInfo = { name: 'aurora', version: '0.0.0', platform: 'win32' };

function bridge(getInfo: AuroraBridge['app']['getInfo']): AuroraBridge {
  return { app: { getInfo } };
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
});
