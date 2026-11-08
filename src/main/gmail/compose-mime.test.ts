import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildOutgoingRaw, formatAddress } from './compose-mime.ts';
import { GmailError } from './errors.ts';

const now = new Date('2026-11-08T18:00:00.000Z');

function decode(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('outgoing mime', () => {
  it('writes UTF-8 plain text and encodes an international subject and display name', () => {
    const raw = buildOutgoingRaw({
      fromName: 'Ada Lovelace',
      fromEmail: 'ada@example.com',
      recipients: { to: ['bob@example.com'], cc: ['cara@example.com'], bcc: ['dan@example.com'] },
      subject: 'Café',
      body: 'Hola, café\n',
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>', '<parent@example.com>'],
      now
    });
    const message = decode(raw);
    assert.equal(message.includes('Content-Type: text/plain; charset=UTF-8'), true);
    assert.equal(message.includes('Content-Transfer-Encoding: base64'), true);
    assert.equal(message.includes('To: bob@example.com'), true);
    assert.equal(message.includes('Cc: cara@example.com'), true);
    assert.equal(message.includes('Bcc: dan@example.com'), true);
    assert.equal(message.includes('In-Reply-To: <parent@example.com>'), true);
    assert.equal(message.includes('=?UTF-8?B?'), true);
    assert.equal(message.includes('café'), false);
    const body = message.split('\r\n\r\n')[1] ?? '';
    assert.equal(
      Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'),
      'Hola, café\r\n'
    );
    assert.equal(formatAddress('倪', 'ni@example.com').startsWith('=?UTF-8?B?'), true);
    const longName = decode(
      buildOutgoingRaw({
        fromName: 'á'.repeat(40),
        fromEmail: 'ada@example.com',
        recipients: { to: ['bob@example.com'], cc: [], bcc: [] },
        subject: 'One two three four five six seven eight nine ten',
        body: 'Hi',
        inReplyTo: null,
        references: [],
        now
      })
    );
    assert.equal(longName.split('=?UTF-8?B?').length > 2, true);
  });

  it('builds multipart mail and encodes a non-ASCII file name without a new header', () => {
    const raw = buildOutgoingRaw({
      fromName: null,
      fromEmail: 'ada@example.com',
      recipients: { to: ['bob@example.com'], cc: [], bcc: [] },
      subject: 'Files',
      body: 'See attached',
      inReplyTo: null,
      references: [],
      now,
      files: [
        { fileName: 'notes.txt', mediaType: 'text/plain', bytes: Buffer.from('one') },
        { fileName: 'café.pdf', mediaType: 'application/pdf', bytes: Buffer.from('two') }
      ]
    });
    const message = decode(raw);
    assert.equal(message.includes('multipart/mixed'), true);
    assert.equal(message.includes('filename="notes.txt"'), true);
    assert.equal(message.includes("filename*=UTF-8''"), true);
    assert.equal(message.includes('\r\nBcc:'), false);
    assert.throws(
      () =>
        buildOutgoingRaw({
          fromName: null,
          fromEmail: 'ada@example.com',
          recipients: { to: ['bob@example.com'], cc: [], bcc: [] },
          subject: 'Files',
          body: 'See attached',
          inReplyTo: null,
          references: [],
          now,
          files: [
            {
              fileName: 'bad\r\nBcc: eve@example.com',
              mediaType: 'text/plain',
              bytes: Buffer.from('x')
            }
          ]
        }),
      (error: unknown) => error instanceof GmailError && error.code === 'invalid-request'
    );
    const plain = decode(
      buildOutgoingRaw({
        fromName: null,
        fromEmail: 'ada@example.com',
        recipients: { to: ['bob@example.com'], cc: [], bcc: [] },
        subject: 'Plain',
        body: 'Only text',
        inReplyTo: null,
        references: [],
        now
      })
    );
    assert.equal(plain.includes('multipart'), false);
  });

  it('does not let a subject or display name add a header', () => {
    assert.throws(
      () =>
        buildOutgoingRaw({
          fromName: 'Ada',
          fromEmail: 'ada@example.com',
          recipients: { to: ['bob@example.com'], cc: [], bcc: [] },
          subject: 'Hello\r\nBcc: evil@example.com',
          body: 'Hi',
          inReplyTo: null,
          references: [],
          now
        }),
      (error: unknown) => error instanceof GmailError && error.code === 'invalid-request'
    );
    const raw = buildOutgoingRaw({
      fromName: 'Ada\r\nBcc: evil@example.com',
      fromEmail: 'ada@example.com',
      recipients: { to: ['bob@example.com'], cc: [], bcc: [] },
      subject: 'Hello',
      body: 'Ignore\r\nBcc: evil@example.com',
      inReplyTo: null,
      references: [],
      now
    });
    const message = decode(raw);
    assert.equal(
      message.split('\r\n').some((line) => line.startsWith('Bcc:')),
      false
    );
    assert.equal(message.startsWith('MIME-Version: 1.0\r\n'), true);
  });
});
