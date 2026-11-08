import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GmailIpcError,
  gmailErrorCodes,
  gmailErrorMessage,
  parseGmailLabelList,
  parseGmailOpenedLink,
  parseGmailResult,
  parseGmailThread,
  parseGmailThreadList,
  parseGmailThreadQuery,
  unwrapGmailResult
} from './gmail.ts';

describe('gmail contracts', () => {
  it('accepts a label list and rejects an extra field', () => {
    assert.equal(gmailErrorMessage('too-large'), 'This conversation is too large to show.');
    const labels = parseGmailLabelList({
      labels: [{ id: 'INBOX', name: 'INBOX', type: 'system', unreadCount: 1 }]
    });
    assert.equal(labels?.labels[0]?.unreadCount, 1);
    assert.equal(
      parseGmailThreadList({
        threads: [
          {
            id: 'threadsame',
            subject: 'Hello',
            from: 'Ada',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Hi',
            unread: true
          }
        ],
        nextPageToken: 'page-token-1'
      })?.nextPageToken,
      'page-token-1'
    );
    const leaked = parseGmailResult(
      {
        ok: true,
        value: {
          id: 'threadsame',
          messages: [],
          access_token: 'access-a'
        }
      },
      parseGmailThread
    );
    assert.deepEqual(leaked, { ok: false, error: { code: 'invalid-response' } });
    assert.equal(JSON.stringify(leaked).includes('access-a'), false);
    assert.equal(parseGmailLabelList({ labels: [], extra: true }), null);
    assert.equal(parseGmailThreadList({ threads: [], nextPageToken: 'bad\n' }), null);
    const message = {
      id: 'messageone',
      from: 'Ada <ada@example.com>',
      to: null,
      cc: null,
      bcc: null,
      subject: 'Hello',
      date: '2026-11-02T12:00:00.000Z',
      unread: false,
      text: 'Hello',
      html: null,
      imagesOmitted: false,
      attachments: [{ fileName: 'notes.txt', mimeType: 'text/plain', size: 4 }]
    };
    assert.equal(parseGmailThread({ id: 'threadsame', messages: [message] })?.messages.length, 1);
    assert.equal(
      parseGmailThread({
        id: 'threadsame',
        messages: [{ ...message, text: 'Hello\r\nWorld', html: '<p>Hello</p>\n<p>World</p>' }]
      })?.messages[0]?.text,
      'Hello\r\nWorld'
    );
    assert.equal(
      parseGmailThread({ id: 'threadsame', messages: [{ ...message, text: 'Hello\u0000' }] }),
      null
    );
    assert.equal(parseGmailThread({ id: 'threadsame', messages: [{ ...message, id: '' }] }), null);
    assert.equal(parseGmailOpenedLink({ opened: true })?.opened, true);
    assert.equal(parseGmailOpenedLink({ opened: false }), null);
    assert.equal(
      parseGmailThreadQuery({
        accountId: '00000000-0000-4000-8000-000000000001',
        labelId: 'INBOX',
        query: null,
        pageToken: null
      })?.labelId,
      'INBOX'
    );
    assert.equal(
      parseGmailThreadQuery({
        accountId: '00000000-0000-4000-8000-000000000001',
        labelId: null,
        query: 'from:ada@example.com',
        pageToken: 'page one'
      })?.query,
      'from:ada@example.com'
    );
    assert.equal(
      parseGmailResult({ ok: false, error: { code: 'not-found' } }, () => null).ok,
      false
    );
    assert.throws(
      () => unwrapGmailResult({ ok: false, error: { code: 'too-large' } }, () => null),
      (error: unknown) => error instanceof GmailIpcError && error.code === 'too-large'
    );
    for (const code of gmailErrorCodes) assert.equal(gmailErrorMessage(code).length > 0, true);
    const symbols = { labels: [] };
    Object.defineProperty(symbols, Symbol('extra'), { value: 1 });
    assert.equal(parseGmailLabelList(symbols), null);
    assert.equal(parseGmailLabelList({ labels: new Array(501).fill(null) }), null);
    assert.equal(
      parseGmailThreadList({ threads: new Array(21).fill(null), nextPageToken: null }),
      null
    );
    assert.equal(parseGmailThread({ id: 'threadsame', messages: new Array(51).fill(null) }), null);
    assert.equal(
      parseGmailThreadQuery({
        accountId: 'not-an-account',
        labelId: null,
        query: null,
        pageToken: null
      }),
      null
    );
    assert.equal(parseGmailResult({ ok: true }, () => null).ok, false);
    assert.equal(parseGmailResult({ ok: false, error: { code: 'nope' } }, () => null).ok, false);
    assert.equal(parseGmailResult(null, () => null).ok, false);
  });
});
