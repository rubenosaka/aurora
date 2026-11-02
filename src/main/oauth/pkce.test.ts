import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { createPkceVerifier, pkceChallengeS256 } from './pkce.ts';

describe('pkce', () => {
  it('creates an unpadded verifier and the S256 challenge', () => {
    const verifier = createPkceVerifier();
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(verifier.includes('='), false);
    assert.equal(
      pkceChallengeS256(verifier),
      createHash('sha256').update(verifier).digest('base64url')
    );
    assert.notEqual(createPkceVerifier(), verifier);
  });
});
