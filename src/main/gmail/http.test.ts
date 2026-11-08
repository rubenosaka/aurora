import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyGmailFailure, gmailBodyLimit, readLimitedBody, retryDelay } from './http.ts';

describe('gmail response limits', () => {
  it('does not read a body whose content-length is over the cap', async () => {
    let readers = 0;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      }
    });
    const original = body.getReader.bind(body);
    body.getReader = () => {
      readers += 1;
      return original();
    };
    await assert.rejects(
      readLimitedBody({
        status: 200,
        headers: { get: () => String(gmailBodyLimit + 1) },
        body
      }),
      (error: unknown) => error instanceof Error && error.message.includes('too large')
    );
    assert.equal(readers, 0);
  });

  it('cancels a stream that passes the cap and does not return the partial bytes', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    await assert.rejects(
      readLimitedBody({
        status: 200,
        headers: { get: () => null },
        body: new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          }
        })
      }),
      (error: unknown) => error instanceof Error && error.message.includes('too large')
    );
    assert.equal(cancelled, true);
  });

  it('classifies quota ahead of permission and ignores free-form messages', () => {
    assert.deepEqual(
      classifyGmailFailure(403, {
        error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'rateLimitExceeded' }] }
      }),
      { code: 'rate-limited', reason: 'rateLimitExceeded' }
    );
    assert.equal(
      classifyGmailFailure(403, { error: { status: 'PERMISSION_DENIED' } }).code,
      'permission-denied'
    );
    assert.equal(classifyGmailFailure(404, { error: { status: 'NOT_FOUND' } }).code, 'not-found');
    assert.equal(
      classifyGmailFailure(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'secret' } })
        .code,
      'rate-limited'
    );
    assert.equal(classifyGmailFailure(500, { error: { message: 'secret' } }).reason, null);
  });

  it('waits one second unless Retry-After is 1 or 2', () => {
    assert.equal(retryDelay('2'), 2000);
    assert.equal(retryDelay('1'), 1000);
    assert.equal(retryDelay('9'), 1000);
    assert.equal(retryDelay('Wed, 21 Oct 2015 07:28:00 GMT'), 1000);
  });
});
