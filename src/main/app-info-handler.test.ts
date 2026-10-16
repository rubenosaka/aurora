import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleGetAppInfo } from './app-info-handler.ts';
import { type SenderSnapshot } from './trusted-sender.ts';

const info = { name: 'aurora', version: '0.0.0', platform: 'win32' };

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

describe('handleGetAppInfo', () => {
  it('returns info for the authorized WebContents and zero arguments', () => {
    let reads = 0;
    const result = handleGetAppInfo(sender(), [], () => {
      reads += 1;
      return info;
    });
    assert.deepEqual(result, { ok: true, value: info });
    assert.equal(reads, 1);
  });

  it('rejects an unauthorized WebContents before reading info', () => {
    let reads = 0;
    const result = handleGetAppInfo(sender({ senderId: 9 }), [], () => {
      reads += 1;
      return info;
    });
    assert.deepEqual(result, { ok: false, error: { code: 'unauthorized' } });
    assert.equal(reads, 0);
  });

  it('rejects unexpected IPC arguments before the use case', () => {
    let reads = 0;
    const result = handleGetAppInfo(sender(), ['extra'], () => {
      reads += 1;
      return info;
    });
    assert.deepEqual(result, { ok: false, error: { code: 'invalid-request' } });
    assert.equal(reads, 0);
  });

  it('rejects invalid application information', () => {
    const result = handleGetAppInfo(sender(), [], () => ({ ...info, extra: true }));
    assert.deepEqual(result, { ok: false, error: { code: 'invalid-response' } });
  });

  it('hides internal exceptions', () => {
    const result = handleGetAppInfo(sender(), [], () => {
      throw new Error('C:\\secret\\aurora\\user.dat');
    });
    assert.deepEqual(result, { ok: false, error: { code: 'internal' } });
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });
});
