import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OAuthFlowError } from './errors.ts';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  googleScopes,
  refreshAccessToken,
  revokeRefreshToken
} from './google-flow.ts';
import { pkceChallengeS256 } from './pkce.ts';

const clientId = 'desktop-client.apps.googleusercontent.com';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('Google OAuth requests', () => {
  it('requests the approved scopes in one authorization', () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId,
        redirectUri: 'http://127.0.0.1:4312/callback',
        state: 'state-value',
        nonce: 'nonce-value',
        verifier: 'verifier-value'
      })
    );
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), pkceChallengeS256('verifier-value'));
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent select_account');
    assert.deepEqual(url.searchParams.get('scope')?.split(' '), [...googleScopes]);
    assert.equal(url.searchParams.get('include_granted_scopes'), null);
    assert.equal(url.href.includes('gmail.modify'), true);
    assert.equal(url.href.includes('gmail.readonly'), false);
    assert.equal(url.href.includes('mail.google.com'), false);
  });

  it('reads a refresh token and treats a missing one as absent', async () => {
    const bodies: string[] = [];
    const present = await exchangeAuthorizationCode({
      fetchImpl: async (_url, init) => {
        const body = init?.body;
        bodies.push(body instanceof URLSearchParams ? body.toString() : '');
        return json({
          id_token: 'header.payload.signature',
          refresh_token: 'refresh-token-one',
          access_token: 'access-token-value',
          scope: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
        });
      },
      clientId,
      code: 'auth-code',
      verifier: 'verifier-value',
      redirectUri: 'http://127.0.0.1:4312/callback'
    });
    assert.deepEqual(present, {
      idToken: 'header.payload.signature',
      refreshToken: 'refresh-token-one',
      grantedScopes: 'email https://www.googleapis.com/auth/gmail.modify openid profile'
    });
    assert.equal(bodies[0]?.includes('code_verifier=verifier-value'), true);
    assert.equal(bodies[0]?.includes('client_secret='), false);
    const absent = await exchangeAuthorizationCode({
      fetchImpl: async () =>
        json({
          id_token: 'header.payload.signature',
          access_token: 'access-token-value',
          scope: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
        }),
      clientId,
      code: 'auth-code',
      verifier: 'verifier-value',
      redirectUri: 'http://127.0.0.1:4312/callback'
    });
    assert.equal(absent.refreshToken, null);
  });

  it('classifies refresh and revocation results without copying the provider body', async () => {
    await assert.rejects(
      refreshAccessToken({
        fetchImpl: async () =>
          json({ error: 'invalid_grant', error_description: 'refresh-token-one' }, 400),
        clientId,
        refreshToken: 'refresh-token-one'
      }),
      (error: unknown) => {
        assert.ok(error instanceof OAuthFlowError);
        assert.equal(error.code, 'needs-reauth');
        assert.equal(error.message.includes('refresh-token-one'), false);
        return true;
      }
    );
    const rotated = await refreshAccessToken({
      fetchImpl: async () =>
        json({ access_token: 'access-token-value', refresh_token: 'refresh-token-two' }),
      clientId,
      refreshToken: 'refresh-token-one'
    });
    assert.deepEqual(rotated, {
      accessToken: 'access-token-value',
      expiresIn: null,
      refreshToken: 'refresh-token-two',
      grantedScopes: null
    });
    const kept = await refreshAccessToken({
      fetchImpl: async () => json({ access_token: 'access-token-value', expires_in: 3600 }),
      clientId,
      refreshToken: 'refresh-token-one'
    });
    assert.equal(kept.accessToken, 'access-token-value');
    assert.equal(kept.expiresIn, 3600);
    assert.equal(kept.refreshToken, null);
    await assert.rejects(
      refreshAccessToken({
        fetchImpl: async () => json({ access_token: 'bad\ntoken', expires_in: 3600 }),
        clientId,
        refreshToken: 'refresh-token-one'
      }),
      (error: unknown) => error instanceof OAuthFlowError && error.code === 'provider-rejected'
    );
    assert.equal(
      await revokeRefreshToken({
        fetchImpl: async () => new Response(null, { status: 200 }),
        refreshToken: 'refresh-token-one'
      }),
      'revoked'
    );
    assert.equal(
      await revokeRefreshToken({
        fetchImpl: async () => {
          throw new Error('offline refresh-token-one');
        },
        refreshToken: 'refresh-token-one'
      }),
      'local'
    );
    let aborted = false;
    assert.equal(
      await revokeRefreshToken({
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            const keepAlive = setTimeout(() => {
              reject(new Error('not aborted'));
            }, 200);
            init?.signal?.addEventListener('abort', () => {
              aborted = true;
              clearTimeout(keepAlive);
              reject(new Error('aborted'));
            });
          }),
        refreshToken: 'refresh-token-one',
        timeoutMs: 20
      }),
      'local'
    );
    assert.equal(aborted, true);
    await assert.rejects(
      exchangeAuthorizationCode({
        fetchImpl: async () => {
          throw new Error('offline');
        },
        clientId,
        code: 'auth-code-value',
        verifier: 'verifier-value',
        redirectUri: 'http://127.0.0.1:4312/callback'
      }),
      (error: unknown) => error instanceof OAuthFlowError && error.code === 'network'
    );
    await assert.rejects(
      exchangeAuthorizationCode({
        fetchImpl: async () => new Response('not-json', { status: 200 }),
        clientId,
        code: 'auth-code-value',
        verifier: 'verifier-value',
        redirectUri: 'http://127.0.0.1:4312/callback'
      }),
      (error: unknown) => error instanceof OAuthFlowError && error.code === 'provider-rejected'
    );
    await assert.rejects(
      refreshAccessToken({
        fetchImpl: async () => json({ refresh_token: 'x'.repeat(8193) }),
        clientId,
        refreshToken: 'refresh-token-one'
      }),
      (error: unknown) => error instanceof OAuthFlowError && error.code === 'provider-rejected'
    );
  });

  it('records a sanitized token-exchange diagnostic in development', async () => {
    const previous = process.env.NODE_ENV;
    const logs: string[] = [];
    const original = console.error.bind(console);
    process.env.NODE_ENV = 'development';
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => (typeof value === 'string' ? value : '')).join(' '));
    };
    const secretDescription = 'do-not-log-auth-code-value-or-verifier-value';
    try {
      await assert.rejects(
        exchangeAuthorizationCode({
          fetchImpl: async () =>
            json({ error: 'invalid_request', error_description: secretDescription }, 400),
          clientId,
          code: 'auth-code-value',
          verifier: 'verifier-value',
          redirectUri: 'http://127.0.0.1:4312/callback'
        }),
        (error: unknown) => {
          assert.ok(error instanceof OAuthFlowError);
          assert.equal(error.code, 'provider-rejected');
          assert.equal(error.message, 'Google rejected the sign-in.');
          assert.equal(error.message.includes('invalid_request'), false);
          assert.equal(error.message.includes(secretDescription), false);
          return true;
        }
      );
      await assert.rejects(
        exchangeAuthorizationCode({
          fetchImpl: async () =>
            json({ error: 'invalid_client', error_description: secretDescription }, 401),
          clientId,
          code: 'auth-code-value',
          verifier: 'verifier-value',
          redirectUri: 'http://127.0.0.1:4312/callback'
        }),
        (error: unknown) => error instanceof OAuthFlowError && error.code === 'provider-rejected'
      );
      await assert.rejects(
        exchangeAuthorizationCode({
          fetchImpl: async () =>
            json({ error: 'invalid_grant', error_description: secretDescription }, 400),
          clientId,
          code: 'auth-code-value',
          verifier: 'verifier-value',
          redirectUri: 'http://127.0.0.1:4312/callback'
        }),
        (error: unknown) => {
          assert.ok(error instanceof OAuthFlowError);
          assert.equal(error.code, 'needs-reauth');
          assert.equal(error.message, 'The saved Google credential can no longer be used.');
          assert.equal(error.message.includes(secretDescription), false);
          return true;
        }
      );
      await assert.rejects(
        exchangeAuthorizationCode({
          fetchImpl: async () =>
            json({ error: 'client_secret is missing', error_description: secretDescription }, 400),
          clientId,
          code: 'auth-code-value',
          verifier: 'verifier-value',
          redirectUri: 'http://127.0.0.1:4312/callback'
        }),
        (error: unknown) => error instanceof OAuthFlowError && error.code === 'provider-rejected'
      );
      await assert.rejects(
        exchangeAuthorizationCode({
          fetchImpl: async () => json(['not-an-object'], 400),
          clientId,
          code: 'auth-code-value',
          verifier: 'verifier-value',
          redirectUri: 'http://127.0.0.1:4312/callback'
        }),
        (error: unknown) => error instanceof OAuthFlowError && error.code === 'provider-rejected'
      );
      await assert.rejects(
        exchangeAuthorizationCode({
          fetchImpl: async () => new Response('not-json', { status: 502 }),
          clientId,
          code: 'auth-code-value',
          verifier: 'verifier-value',
          redirectUri: 'http://127.0.0.1:4312/callback'
        }),
        (error: unknown) => error instanceof OAuthFlowError && error.code === 'provider-rejected'
      );
      const exchanged = await exchangeAuthorizationCode({
        fetchImpl: async (_url, init) => {
          const body = init?.body;
          const encoded = body instanceof URLSearchParams ? body.toString() : '';
          assert.equal(encoded.includes('client_secret'), false);
          return json({
            id_token: 'header.payload.signature',
            refresh_token: 'refresh-token-one',
            access_token: 'access-token-value',
            scope: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
          });
        },
        clientId,
        code: 'auth-code-value',
        verifier: 'verifier-value',
        redirectUri: 'http://127.0.0.1:4312/callback'
      });
      assert.deepEqual(exchanged, {
        idToken: 'header.payload.signature',
        refreshToken: 'refresh-token-one',
        grantedScopes: 'email https://www.googleapis.com/auth/gmail.modify openid profile'
      });
      assert.deepEqual(logs, [
        'aurora oauth stage=token-exchange status=400 error=invalid_request',
        'aurora oauth stage=token-exchange status=401 error=invalid_client',
        'aurora oauth stage=token-exchange status=400 error=invalid_grant',
        'aurora oauth stage=token-exchange status=400 error=none',
        'aurora oauth stage=token-exchange status=400 error=none',
        'aurora oauth stage=token-exchange status=502 error=none'
      ]);
      const text = logs.join('\n');
      assert.equal(text.includes(secretDescription), false);
      assert.equal(text.includes('auth-code-value'), false);
      assert.equal(text.includes('verifier-value'), false);
      assert.equal(text.includes('refresh-token-one'), false);
      assert.equal(text.includes('access-token-value'), false);
    } finally {
      console.error = original;
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('adds a configured client secret to exchange and refresh requests', async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = init?.body;
      bodies.push(body instanceof URLSearchParams ? body.toString() : '');
      return json({
        id_token: 'header.payload.signature',
        refresh_token: 'refresh-token-two',
        access_token: 'access-token-value',
        scope: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
      });
    };
    const exchanged = await exchangeAuthorizationCode({
      fetchImpl,
      clientId,
      code: 'auth-code-value',
      verifier: 'verifier-value',
      redirectUri: 'http://127.0.0.1:4312/callback',
      clientSecret: 'client-secret-value'
    });
    assert.equal(exchanged.refreshToken, 'refresh-token-two');
    assert.equal(bodies[0]?.includes('client_secret=client-secret-value'), true);
    assert.equal(bodies[0]?.includes('code_verifier=verifier-value'), true);
    const refreshed = await refreshAccessToken({
      fetchImpl,
      clientId,
      refreshToken: 'refresh-token-one',
      clientSecret: 'client-secret-value'
    });
    assert.equal(refreshed.refreshToken, 'refresh-token-two');
    assert.equal(bodies[1]?.includes('grant_type=refresh_token'), true);
    assert.equal(bodies[1]?.includes('client_secret=client-secret-value'), true);
    const previous = process.env.NODE_ENV;
    const logs: string[] = [];
    const original = console.error.bind(console);
    process.env.NODE_ENV = 'development';
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => (typeof value === 'string' ? value : '')).join(' '));
    };
    try {
      await assert.rejects(
        exchangeAuthorizationCode({
          fetchImpl: async () =>
            json({ error: 'invalid_request', error_description: 'client-secret-value' }, 400),
          clientId,
          code: 'auth-code-value',
          verifier: 'verifier-value',
          redirectUri: 'http://127.0.0.1:4312/callback',
          clientSecret: 'client-secret-value'
        }),
        (error: unknown) => {
          assert.ok(error instanceof OAuthFlowError);
          assert.equal(error.code, 'provider-rejected');
          assert.equal(error.message.includes('client-secret-value'), false);
          return true;
        }
      );
      assert.equal(logs.join('\n').includes('client-secret-value'), false);
      assert.equal(logs[0], 'aurora oauth stage=token-exchange status=400 error=invalid_request');
    } finally {
      console.error = original;
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('omits the token-exchange diagnostic outside development', async () => {
    const previous = process.env.NODE_ENV;
    let calls = 0;
    const original = console.error.bind(console);
    process.env.NODE_ENV = 'production';
    console.error = () => {
      calls += 1;
    };
    try {
      await assert.rejects(
        exchangeAuthorizationCode({
          fetchImpl: async () => json({ error: 'invalid_request' }, 400),
          clientId,
          code: 'auth-code-value',
          verifier: 'verifier-value',
          redirectUri: 'http://127.0.0.1:4312/callback'
        }),
        (error: unknown) => error instanceof OAuthFlowError && error.code === 'provider-rejected'
      );
      assert.equal(calls, 0);
    } finally {
      console.error = original;
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
