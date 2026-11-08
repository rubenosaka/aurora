import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GoogleIpcError,
  isGoogleClientId,
  parseGoogleAccountList,
  parseGoogleCancelResult,
  parseGoogleClientSaved,
  parseGoogleClientState,
  parseGoogleDisconnectResult,
  parseGoogleResult,
  unwrapGoogleResult
} from './google-accounts.ts';

const account = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'ada@example.com',
  displayName: 'Ada',
  status: 'connected' as const,
  canModifyMail: true
};

describe('Google IPC parsing', () => {
  it('accepts empty client state, cancellation, and disconnection', () => {
    assert.deepEqual(parseGoogleClientState({ clientId: null, secretConfigured: false }), {
      clientId: null,
      secretConfigured: false
    });
    assert.equal(
      parseGoogleClientState({
        clientId: null,
        secretConfigured: false,
        clientSecret: 'client-secret-value'
      }),
      null
    );
    assert.equal(
      parseGoogleClientSaved({ clientId: 'not-a-client', secretConfigured: false }),
      null
    );
    assert.equal(parseGoogleAccountList({ accounts: new Array(101).fill(account) }), null);
    assert.deepEqual(parseGoogleCancelResult({ cancelled: true }), { cancelled: true });
    assert.equal(parseGoogleCancelResult({ cancelled: false }), null);
    assert.deepEqual(parseGoogleDisconnectResult({ outcome: 'disconnected-local' }), {
      outcome: 'disconnected-local'
    });
    assert.equal(parseGoogleDisconnectResult({ outcome: 'other' }), null);
    assert.deepEqual(
      parseGoogleResult({ ok: false, error: { code: 'network' } }, () => null),
      {
        ok: false,
        error: { code: 'network' }
      }
    );
    const value = unwrapGoogleResult(
      { ok: true, value: { clientId: null, secretConfigured: true } },
      parseGoogleClientState
    );
    assert.deepEqual(value, { clientId: null, secretConfigured: true });
  });

  it('accepts a desktop client id and an exact account list', () => {
    assert.equal(isGoogleClientId('desktop-client.apps.googleusercontent.com'), true);
    assert.equal(isGoogleClientId('https://evil.example/.apps.googleusercontent.com'), false);
    const parsed = parseGoogleResult(
      { ok: true, value: { accounts: [account] } },
      parseGoogleAccountList
    );
    assert.deepEqual(parsed, { ok: true, value: { accounts: [account] } });
  });

  it('drops envelopes that include a credential', () => {
    const parsed = parseGoogleResult(
      { ok: true, value: { ...account, refreshToken: 'refresh-token-one' } },
      (value) => (value === account ? account : null)
    );
    assert.deepEqual(parsed, { ok: false, error: { code: 'invalid-response' } });
    assert.equal(JSON.stringify(parsed).includes('refresh-token-one'), false);
    assert.throws(
      () =>
        unwrapGoogleResult(
          { ok: false, error: { code: 'nope', detail: 'refresh-token-one' } },
          () => null
        ),
      (error: unknown) => {
        assert.ok(error instanceof GoogleIpcError);
        assert.equal(error.code, 'invalid-response');
        assert.equal(error.message.includes('refresh-token-one'), false);
        return true;
      }
    );
  });
});
