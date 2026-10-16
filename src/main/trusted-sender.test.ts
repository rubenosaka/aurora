import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAuthorizedSender, type SenderSnapshot } from './trusted-sender.ts';

const devUrl = 'http://localhost:5173/';
const prodUrl = 'file:///C:/rga/aurora/out/renderer/index.html';

function sender(overrides: Partial<SenderSnapshot> = {}): SenderSnapshot {
  return {
    senderId: 7,
    authorizedSenderId: 7,
    frameUrl: devUrl,
    isMainFrame: true,
    authorizedUrl: devUrl,
    ...overrides
  };
}

describe('isAuthorizedSender', () => {
  it('accepts the authorized WebContents on the authorized document', () => {
    assert.equal(isAuthorizedSender(sender()), true);
    assert.equal(
      isAuthorizedSender(sender({ frameUrl: 'http://localhost:5173', authorizedUrl: devUrl })),
      true
    );
    assert.equal(isAuthorizedSender(sender({ frameUrl: prodUrl, authorizedUrl: prodUrl })), true);
    assert.equal(
      isAuthorizedSender(sender({ frameUrl: 'http://localhost:5173/#/settings' })),
      true
    );
    assert.equal(
      isAuthorizedSender(sender({ frameUrl: `${prodUrl}#/integrations`, authorizedUrl: prodUrl })),
      true
    );
  });

  it('rejects an unauthorized WebContents even when the document matches', () => {
    assert.equal(isAuthorizedSender(sender({ senderId: 8 })), false);
    assert.equal(isAuthorizedSender(sender({ authorizedSenderId: null })), false);
    assert.equal(isAuthorizedSender(sender({ senderId: null })), false);
  });

  it('rejects a subframe of the authorized WebContents', () => {
    assert.equal(isAuthorizedSender(sender({ isMainFrame: false })), false);
  });

  it('rejects a missing senderFrame', () => {
    assert.equal(isAuthorizedSender(sender({ frameUrl: null })), false);
    assert.equal(isAuthorizedSender(sender({ frameUrl: null, isMainFrame: false })), false);
  });

  it('rejects an external origin and an unexpected local file', () => {
    assert.equal(isAuthorizedSender(sender({ frameUrl: 'https://evil.example/' })), false);
    assert.equal(isAuthorizedSender(sender({ frameUrl: 'http://localhost:5173/other' })), false);
    assert.equal(
      isAuthorizedSender(sender({ frameUrl: 'http://localhost:5173/other#/settings' })),
      false
    );
    assert.equal(isAuthorizedSender(sender({ frameUrl: 'http://localhost:5173/?next=/' })), false);
    assert.equal(
      isAuthorizedSender(sender({ frameUrl: 'https://evil.example/#/settings' })),
      false
    );
    assert.equal(
      isAuthorizedSender(sender({ frameUrl: 'file:///C:/tmp/other.html', authorizedUrl: prodUrl })),
      false
    );
    assert.equal(
      isAuthorizedSender(sender({ frameUrl: 'http://user:pass@localhost:5173/' })),
      false
    );
    assert.equal(isAuthorizedSender(sender({ frameUrl: 'javascript:alert(1)' })), false);
    assert.equal(isAuthorizedSender(sender({ frameUrl: 'ws://localhost:5173/' })), false);
    assert.equal(isAuthorizedSender(sender({ frameUrl: 'http://[' })), false);
  });

  it('accepts a fragment on the authorized document from either side', () => {
    assert.equal(
      isAuthorizedSender(
        sender({ frameUrl: devUrl, authorizedUrl: 'http://localhost:5173/#/settings' })
      ),
      true
    );
  });
});
