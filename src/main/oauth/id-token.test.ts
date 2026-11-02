import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { describe, it } from 'node:test';
import { OAuthFlowError } from './errors.ts';
import { createGoogleJwksClient, verifyGoogleIdToken, type JwksClient } from './id-token.ts';

const clientId = 'desktop-client.apps.googleusercontent.com';
const nonce = 'nonce-value';
const now = new Date('2026-11-02T12:00:00.000Z');

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk: JsonWebKey = publicKey.export({ format: 'jwk' });
publicJwk.kid = 'test-key';
publicJwk.alg = 'RS256';

function token(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'test-key' },
  key: KeyObject = privateKey
): string {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = sign('RSA-SHA256', Buffer.from(data), key).toString('base64url');
  return `${data}.${signature}`;
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: clientId,
    exp: Math.floor(now.getTime() / 1000) + 600,
    iat: Math.floor(now.getTime() / 1000),
    nonce,
    sub: 'google-user-1',
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada',
    ...overrides
  };
}

function keys(jwk: JsonWebKey | null = publicJwk): JwksClient {
  return {
    async getKey(kid: string) {
      return kid === 'test-key' ? jwk : null;
    }
  };
}

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof OAuthFlowError);
    return error.code;
  }
  assert.fail('expected rejection');
}

describe('Google ID token verification', () => {
  it('verifies a signed token and ignores an unverified email', async () => {
    const identity = await verifyGoogleIdToken({
      idToken: token(payload()),
      clientId,
      nonce,
      jwks: keys(),
      now: () => now
    });
    assert.deepEqual(identity, {
      subject: 'google-user-1',
      email: 'ada@example.com',
      displayName: 'Ada'
    });
    const unverified = await verifyGoogleIdToken({
      idToken: token(payload({ email_verified: false })),
      clientId,
      nonce,
      jwks: keys(),
      now: () => now
    });
    assert.equal(unverified.email, null);
  });

  it('rejects an unsigned token, a bad signature, and the wrong claims without another path', async () => {
    let lookups = 0;
    const jwks: JwksClient = {
      async getKey() {
        lookups += 1;
        return publicJwk;
      }
    };
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-key' })).toString(
      'base64url'
    );
    const body = Buffer.from(JSON.stringify(payload())).toString('base64url');
    assert.equal(
      await codeOf(() =>
        verifyGoogleIdToken({
          idToken: `${header}.${body}.`,
          clientId,
          nonce,
          jwks,
          now: () => now
        })
      ),
      'provider-rejected'
    );
    assert.equal(lookups, 0);
    const signed = token(payload());
    const tampered = `${signed.slice(0, -2)}aa`;
    assert.equal(
      await codeOf(() =>
        verifyGoogleIdToken({ idToken: tampered, clientId, nonce, jwks: keys(), now: () => now })
      ),
      'provider-rejected'
    );
    for (const claims of [
      { iss: 'https://evil.example' },
      { aud: 'other-client.apps.googleusercontent.com' },
      { exp: Math.floor(now.getTime() / 1000) - 120 },
      { iat: Math.floor(now.getTime() / 1000) + 120 },
      { nonce: 'other-nonce' }
    ]) {
      assert.equal(
        await codeOf(() =>
          verifyGoogleIdToken({
            idToken: token(payload(claims)),
            clientId,
            nonce,
            jwks: keys(),
            now: () => now
          })
        ),
        'provider-rejected'
      );
    }
    assert.equal(
      await codeOf(() =>
        verifyGoogleIdToken({
          idToken: token(payload()),
          clientId,
          nonce,
          jwks: keys(null),
          now: () => now
        })
      ),
      'provider-rejected'
    );
  });

  it('refetches an unknown key once and fails closed when the directory is unavailable', async () => {
    const calls: string[] = [];
    const documents = [
      { keys: [{ kty: 'RSA', kid: 'old', n: 'old', e: 'AQAB' }] },
      { keys: [publicJwk] }
    ];
    let clock = 1_000;
    const client = createGoogleJwksClient(
      async () => {
        calls.push('fetch');
        const body = documents.shift();
        if (body === undefined) throw new Error('offline');
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'cache-control': 'max-age=7200' }
        });
      },
      () => clock
    );
    assert.equal((await client.getKey('test-key'))?.kid, 'test-key');
    assert.deepEqual(calls, ['fetch', 'fetch']);
    clock += 1_000;
    assert.equal((await client.getKey('test-key'))?.kid, 'test-key');
    assert.deepEqual(calls, ['fetch', 'fetch']);
    const offline = createGoogleJwksClient(async () => {
      throw new Error('offline');
    });
    const rejected = createGoogleJwksClient(async () => new Response('nope', { status: 500 }));
    await assert.rejects(rejected.getKey('test-key'), (error: unknown) => {
      assert.ok(error instanceof OAuthFlowError);
      assert.equal(error.code, 'provider-rejected');
      return true;
    });
    const broken = createGoogleJwksClient(async () => new Response('not-json', { status: 200 }));
    await assert.rejects(broken.getKey('test-key'), (error: unknown) => {
      assert.ok(error instanceof OAuthFlowError);
      assert.equal(error.code, 'provider-rejected');
      return true;
    });
    await assert.rejects(
      verifyGoogleIdToken({
        idToken: 'not-a-jwt',
        clientId,
        nonce,
        jwks: keys(publicJwk),
        now: () => now
      }),
      (error: unknown) => error instanceof OAuthFlowError && error.code === 'provider-rejected'
    );
    await assert.rejects(offline.getKey('test-key'), (error: unknown) => {
      assert.ok(error instanceof OAuthFlowError);
      assert.equal(error.code, 'network');
      assert.equal(error.message.includes('offline'), false);
      return true;
    });
  });
});
