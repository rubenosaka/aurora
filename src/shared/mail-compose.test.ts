import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectRecipients,
  forwardQuote,
  forwardSubject,
  isMailboxAddress,
  mailboxesFromHeader,
  messageIdsFromHeader,
  parseComposeMessage,
  replyQuote,
  replySubject,
  seedRecipients,
  trimReferences
} from './mail-compose.ts';

const accountId = '00000000-0000-4000-8000-000000000001';

describe('mail compose', () => {
  it('accepts an ASCII address and drops a header that tries to add another line', () => {
    assert.equal(isMailboxAddress('Ada <ada@example.com>'), false);
    assert.equal(isMailboxAddress('adá@example.com'), false);
    assert.equal(isMailboxAddress('ada@example.com'), true);
    assert.deepEqual(
      mailboxesFromHeader('Ada Lovelace <ada@example.com>, "Bob, Jr" <bob@example.com>'),
      ['ada@example.com', 'bob@example.com']
    );
    assert.deepEqual(mailboxesFromHeader('ada@example.com\r\nBcc: evil@example.com'), []);
    assert.deepEqual(messageIdsFromHeader('<id.one@example.com> <id.two@example.com>'), [
      '<id.one@example.com>',
      '<id.two@example.com>'
    ]);
    assert.deepEqual(messageIdsFromHeader('<bad id>'), []);
  });

  it('builds reply and forward subjects and keeps the sender out of reply all', () => {
    assert.equal(replySubject('Re: Fwd: Hello'), 'Re: Hello');
    assert.equal(replySubject(''), 'Re:');
    assert.equal(replySubject('Hello\r\nBcc: evil@example.com'), null);
    assert.equal(forwardSubject('Fw: Notes'), 'Fwd: Notes');
    const replyAll = seedRecipients({
      kind: 'reply-all',
      from: ['bob@example.com'],
      to: ['ada@example.com', 'cara@example.com'],
      cc: ['dan@example.com'],
      replyTo: [],
      selfAddress: 'ada@example.com'
    });
    assert.deepEqual(replyAll.to, ['bob@example.com']);
    assert.deepEqual(replyAll.cc, ['cara@example.com', 'dan@example.com']);
    assert.equal(replyAll.bcc.length, 0);
    const sent = seedRecipients({
      kind: 'reply',
      from: ['ada@example.com'],
      to: ['bob@example.com'],
      cc: [],
      replyTo: [],
      selfAddress: 'ada@example.com'
    });
    assert.deepEqual(sent.to, ['bob@example.com']);
    const redirected = seedRecipients({
      kind: 'reply',
      from: ['bob@example.com'],
      to: ['ada@example.com'],
      cc: ['cara@example.com'],
      replyTo: ['reply@example.com'],
      selfAddress: 'ada@example.com'
    });
    assert.deepEqual(redirected.to, ['reply@example.com']);
    assert.equal(redirected.cc.length, 0);
  });

  it('rejects an injected recipient and keeps one copy of a repeated address', () => {
    assert.equal(collectRecipients(['ada@example.com\r\nBcc: evil@example.com'], [], []), null);
    assert.deepEqual(
      collectRecipients(
        ['Ada@Example.com', 'bob@example.com'],
        ['ada@example.com'],
        ['bob@example.com']
      ),
      {
        to: ['Ada@Example.com', 'bob@example.com'],
        cc: [],
        bcc: []
      }
    );
    const sent = parseComposeMessage({
      accountId,
      kind: 'new',
      threadId: null,
      messageId: null,
      to: ['bob@example.com'],
      cc: [],
      bcc: [],
      subject: 'Café',
      body: 'Hola\n'
    });
    assert.equal(sent?.subject, 'Café');
    assert.equal(
      parseComposeMessage({
        accountId,
        kind: 'new',
        threadId: 'threadsame',
        messageId: null,
        to: ['bob@example.com'],
        cc: [],
        bcc: [],
        subject: 'Hi',
        body: ''
      }),
      null
    );
  });

  it('quotes plain text and shortens a body that does not fit', () => {
    const reply = replyQuote({ from: 'Bob', date: 'Monday', text: 'Line' });
    assert.equal(reply.includes('> Line'), true);
    assert.equal(reply.includes('<'), false);
    const missing = forwardQuote({
      from: 'Bob',
      date: null,
      subject: 'Hello',
      to: 'Ada',
      text: null
    });
    assert.equal(missing.includes('The original message had no plain-text body.'), true);
    const huge = replyQuote({ from: 'Bob', date: 'Monday', text: 'a'.repeat(300_000) });
    assert.equal(huge.includes('[Quoted text was shortened.]'), true);
    assert.deepEqual(
      trimReferences(['<a@example.com>', '<b@example.com>'], '<c@example.com>').length <= 10,
      true
    );
  });
});
