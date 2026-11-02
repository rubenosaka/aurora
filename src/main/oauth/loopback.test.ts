import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { describe, it } from 'node:test';
import {
  callbackPage,
  evaluateAuthorizationRequest,
  listenForAuthorizationCallback,
  type AuthorizationRequest
} from './loopback.ts';

const state = 'expected-state-value';

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    method: 'GET',
    url: `/callback?code=auth-code&state=${state}`,
    host: '127.0.0.1:4312',
    remoteAddress: '127.0.0.1',
    contentLength: undefined,
    hasBody: false,
    expectedState: state,
    port: 4312,
    ...overrides
  };
}

function ask(url: string, method = 'GET', body = ''): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: body.length > 0 ? { 'content-length': Buffer.byteLength(body) } : undefined
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('authorization callback validation', () => {
  it('accepts one matching code and a Google issuer', () => {
    const decision = evaluateAuthorizationRequest(
      request({ url: `/callback?code=auth-code&state=${state}&iss=https://accounts.google.com` })
    );
    assert.deepEqual(decision, {
      consume: true,
      status: 200,
      result: { kind: 'code', code: 'auth-code' }
    });
    const alternate = evaluateAuthorizationRequest(
      request({ url: `/callback?code=auth-code&state=${state}&iss=accounts.google.com` })
    );
    assert.equal(alternate.consume, true);
  });

  it('rejects a supplied issuer that is not Google after the state matches', () => {
    const decision = evaluateAuthorizationRequest(
      request({ url: `/callback?code=auth-code&state=${state}&iss=https://evil.example` })
    );
    assert.deepEqual(decision, { consume: true, status: 400, result: { kind: 'rejected' } });
  });

  it('keeps the attempt open for the wrong method, path, state, body, or repeated parameter', () => {
    assert.equal(evaluateAuthorizationRequest(request({ method: 'POST' })).consume, false);
    assert.equal(evaluateAuthorizationRequest(request({ url: '/other' })).consume, false);
    assert.equal(
      evaluateAuthorizationRequest(request({ url: '/callback?code=auth-code&state=other' }))
        .consume,
      false
    );
    assert.equal(evaluateAuthorizationRequest(request({ hasBody: true })).consume, false);
    assert.equal(
      evaluateAuthorizationRequest(
        request({ url: `/callback?state=${state}&state=${state}&code=auth-code` })
      ).consume,
      false
    );
    assert.equal(
      evaluateAuthorizationRequest(request({ remoteAddress: '10.0.0.8' })).consume,
      false
    );
    assert.equal(
      evaluateAuthorizationRequest(request({ remoteAddress: '::ffff:127.0.0.1' })).consume,
      true
    );
    assert.equal(evaluateAuthorizationRequest(request({ contentLength: '4' })).consume, false);
    assert.equal(evaluateAuthorizationRequest(request({ host: 'localhost:4312' })).consume, false);
    assert.equal(evaluateAuthorizationRequest(request({ url: '' })).consume, false);
    assert.equal(
      evaluateAuthorizationRequest(request({ url: `/callback?code=auth-code&state=${state}#x` }))
        .consume,
      false
    );
    assert.equal(
      evaluateAuthorizationRequest(
        request({ url: `/callback?code=auth-code&state=${state}&extra=1` })
      ).consume,
      false
    );
    const denied = evaluateAuthorizationRequest(
      request({ url: `/callback?error=access_denied&state=${state}` })
    );
    assert.equal(denied.consume && denied.result.kind === 'denied', true);
    const both = evaluateAuthorizationRequest(
      request({ url: `/callback?code=auth-code&error=access_denied&state=${state}` })
    );
    assert.equal(both.consume && both.result.kind === 'rejected', true);
    const otherError = evaluateAuthorizationRequest(
      request({ url: `/callback?error=server_error&state=${state}` })
    );
    assert.equal(otherError.consume && otherError.result.kind === 'rejected', true);
    const emptyCode = evaluateAuthorizationRequest(
      request({ url: `/callback?code=&state=${state}` })
    );
    assert.equal(emptyCode.consume, true);
    if (emptyCode.consume) assert.equal(emptyCode.result.kind, 'rejected');
  });

  it('accepts one HTTP callback, ignores an earlier miss, and returns fixed HTML', async () => {
    const session = await listenForAuthorizationCallback(state);
    const missed = await ask(`${session.redirectUri.replace('/callback', '/nope')}`);
    assert.equal(missed.status, 404);
    assert.equal(missed.body, callbackPage);
    const origin = new URL(session.redirectUri).origin;
    const response = await ask(
      `${origin}/callback?code=auth-code-value&state=${state}&iss=https://accounts.google.com`
    );
    assert.equal(response.body, callbackPage);
    assert.equal(response.body.includes('auth-code-value'), false);
    assert.equal(response.body.includes(state), false);
    assert.deepEqual(await session.done, { kind: 'code', code: 'auth-code-value' });
  });

  it('does not let an invalid request consume the legitimate callback', async () => {
    const session = await listenForAuthorizationCallback(state);
    const origin = new URL(session.redirectUri).origin;
    const wrong = await ask(`${origin}/callback?code=stolen&state=wrong-state`);
    assert.equal(wrong.status, 400);
    const right = await ask(`${origin}/callback?code=real-code&state=${state}`);
    assert.equal(right.body.includes('real-code'), false);
    assert.deepEqual(await session.done, { kind: 'code', code: 'real-code' });
  });

  it('closes after the unmatched request limit and on cancellation', async () => {
    const limited = await listenForAuthorizationCallback(state);
    const origin = new URL(limited.redirectUri).origin;
    for (let index = 0; index < 16; index += 1) {
      await ask(`${origin}/callback?code=nope&state=wrong`);
    }
    assert.deepEqual(await limited.done, { kind: 'limit' });
    await assert.rejects(ask(`${origin}/callback?code=late&state=${state}`));

    const cancelled = await listenForAuthorizationCallback(state);
    const cancelOrigin = new URL(cancelled.redirectUri).origin;
    cancelled.cancel('cancelled');
    assert.deepEqual(await cancelled.done, { kind: 'cancelled' });
    await assert.rejects(ask(`${cancelOrigin}/callback?code=late&state=${state}`));
    cancelled.cancel('timeout');
    assert.deepEqual(await cancelled.done, { kind: 'cancelled' });
  });
});
