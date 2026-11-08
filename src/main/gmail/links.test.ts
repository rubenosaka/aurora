import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptExternalUrl } from './links.ts';

describe('external urls', () => {
  it('accepts https and mailto', () => {
    assert.equal(acceptExternalUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(acceptExternalUrl('mailto:ada@example.com'), 'mailto:ada@example.com');
  });

  it('accepts a parsed href that still meets the rules', () => {
    assert.equal(acceptExternalUrl('http://example.com'), 'http://example.com/');
  });

  it('rejects malformed, credentialed, and unsupported urls', () => {
    assert.equal(acceptExternalUrl(''), null);
    assert.equal(acceptExternalUrl(`https://example.com/${'a'.repeat(2048)}`), null);
    assert.equal(acceptExternalUrl('mailto:'), null);
    assert.equal(acceptExternalUrl('http://'), null);
    assert.equal(acceptExternalUrl('javascript:alert(1)'), null);
    assert.equal(acceptExternalUrl('data:text/html,hi'), null);
    assert.equal(acceptExternalUrl('file:///tmp/a'), null);
    assert.equal(acceptExternalUrl('https://user:pass@example.com'), null);
    assert.equal(acceptExternalUrl('https://example.com/a\nb'), null);
    assert.equal(acceptExternalUrl('https://example.com/a b'), null);
    assert.equal(acceptExternalUrl('https://example.com/a\\b'), null);
    assert.equal(acceptExternalUrl('not a url'), null);
  });
});
