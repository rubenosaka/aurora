import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appInfoChannel, type AppInfo } from '../shared/app-info.ts';
import { createAuroraApi } from './aurora-api.ts';

const info: AppInfo = { name: 'aurora', version: '0.0.0', platform: 'win32' };

describe('createAuroraApi', () => {
  it('exposes only app.getInfo', () => {
    const api = createAuroraApi(async () => ({ ok: true, value: info }));
    assert.deepEqual(Object.keys(api), ['app']);
    assert.deepEqual(Object.getOwnPropertyNames(api.app), ['getInfo']);
    assert.equal(typeof api.app.getInfo, 'function');
    assert.equal(Object.isFrozen(api), true);
    assert.equal(Object.isFrozen(api.app), true);
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

  it('rejects an invalid IPC result envelope', async () => {
    const api = createAuroraApi(async () => ({ ok: true, value: info, leaked: 'C:\\secret' }));
    const result = await api.app.getInfo();
    assert.deepEqual(result, { ok: false, error: { code: 'invalid-response' } });
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });
});
