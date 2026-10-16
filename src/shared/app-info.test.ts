import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AuroraIpcError,
  isAppInfo,
  parseIpcResult,
  unwrapAppInfo,
  type AppInfo
} from './app-info.ts';

const info: AppInfo = { name: 'aurora', version: '0.0.0', platform: 'win32' };

describe('isAppInfo', () => {
  it('accepts the application info', () => {
    assert.equal(isAppInfo(info), true);
  });

  it('rejects invalid application information', () => {
    assert.equal(isAppInfo({ ...info, platform: 'beos' }), false);
    assert.equal(isAppInfo({ ...info, version: '' }), false);
    assert.equal(isAppInfo({ ...info, version: 'v0.0.0' }), false);
    assert.equal(isAppInfo({ ...info, name: '' }), false);
    assert.equal(isAppInfo({ ...info, extra: 'nope' }), false);
    assert.equal(isAppInfo({ name: info.name, version: info.version }), false);
  });
});

describe('parseIpcResult', () => {
  it('accepts a complete success envelope', () => {
    assert.deepEqual(parseIpcResult({ ok: true, value: info }), { ok: true, value: info });
  });

  it('accepts a complete error envelope', () => {
    assert.deepEqual(parseIpcResult({ ok: false, error: { code: 'unauthorized' } }), {
      ok: false,
      error: { code: 'unauthorized' }
    });
  });

  it('rejects invalid IPC result envelopes', () => {
    const invalid = { ok: false, error: { code: 'invalid-response' } };
    assert.deepEqual(parseIpcResult(null), invalid);
    assert.deepEqual(parseIpcResult([]), invalid);
    assert.deepEqual(parseIpcResult({ ok: true, value: info, extra: true }), invalid);
    assert.deepEqual(parseIpcResult({ ok: true, value: { ...info, extra: true } }), invalid);
    assert.deepEqual(
      parseIpcResult({ ok: false, error: { code: 'unauthorized', stack: 'x' } }),
      invalid
    );
    assert.deepEqual(parseIpcResult({ ok: false, error: { code: 'ENOENT' } }), invalid);
    assert.deepEqual(parseIpcResult({ ok: false }), invalid);
    assert.deepEqual(parseIpcResult({ ok: 'true', value: info }), invalid);
  });
});

describe('unwrapAppInfo', () => {
  it('returns the value from a success envelope', () => {
    assert.deepEqual(unwrapAppInfo({ ok: true, value: info }), info);
  });

  it('throws AuroraIpcError using the envelope code', () => {
    assert.throws(
      () => unwrapAppInfo({ ok: false, error: { code: 'unauthorized' } }),
      (error: unknown) => {
        assert.ok(error instanceof AuroraIpcError);
        assert.equal(error.code, 'unauthorized');
        assert.equal(error.message.includes('unauthorized'), false);
        return true;
      }
    );
  });

  it('maps a broken envelope to invalid-response', () => {
    assert.throws(
      () => unwrapAppInfo({ ok: false, error: { code: 'C:\\secret\\path' } }),
      (error: unknown) => {
        assert.ok(error instanceof AuroraIpcError);
        assert.equal(error.code, 'invalid-response');
        assert.equal(JSON.stringify(error).includes('secret'), false);
        return true;
      }
    );
  });
});
