import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseGmailThread } from '../../shared/gmail.ts';
import { GmailError } from './errors.ts';
import { decodeConversation } from './mime.ts';

function textPart(mimeType: string, text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    mimeType,
    body: { data: Buffer.from(text).toString('base64url'), size: text.length },
    ...extra
  };
}

function textPartBytes(mimeType: string, bytes: Buffer, charsetParameter: string): unknown {
  return {
    mimeType,
    headers: [{ name: 'Content-Type', value: `${mimeType}; ${charsetParameter}` }],
    body: { data: bytes.toString('base64url'), size: bytes.length }
  };
}

const spanishUtf8 = Buffer.from('suscripción', 'utf8');
const spanishWindows1252 = Buffer.from([
  0x73, 0x75, 0x73, 0x63, 0x72, 0x69, 0x70, 0x63, 0x69, 0xf3, 0x6e, 0x20, 0x80
]);

describe('gmail mime', () => {
  it('returns a conversation whose line breaks pass the shared parser', () => {
    const messages = decodeConversation('threadone', [
      {
        id: 'messageone',
        internalDate: '1000',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [{ name: 'Subject', value: 'Hello' }],
          parts: [
            textPart('text/plain', 'Hello\r\nWorld'),
            textPart('text/html', '<p>Hello</p>\n<p>World</p>')
          ]
        }
      }
    ]);
    const parsed = parseGmailThread({ id: 'threadone', messages });
    assert.equal(parsed?.messages[0]?.text, 'Hello\r\nWorld');
    assert.equal(parsed?.messages[0]?.html?.includes('\n'), true);
    assert.equal(parsed?.messages[0]?.html?.includes('<p>'), true);
  });

  it('keeps sanitized html and plain text and omits attachment bytes', () => {
    const messages = decodeConversation('threadone', [
      {
        id: 'messageone',
        internalDate: '1000',
        labelIds: ['UNREAD'],
        payload: {
          mimeType: 'multipart/alternative',
          parts: [
            textPart('text/plain', 'Hello plain'),
            textPart(
              'text/html',
              '<p onclick="evil()">Hi</p><script>alert(1)</script><iframe src="https://evil.example"></iframe><img src="https://images.example/a.png" onerror="evil()"><a href="javascript:alert(1)">Bad</a><a href="https://example.com/ok">Ok</a>'
            ),
            {
              mimeType: 'application/pdf',
              filename: '../secret.pdf',
              body: { size: 42, data: Buffer.from('pdf-bytes').toString('base64url') }
            }
          ]
        }
      }
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.text, 'Hello plain');
    assert.equal(messages[0]?.html?.includes('script'), false);
    assert.equal(messages[0]?.html?.includes('iframe'), false);
    assert.equal(messages[0]?.html?.includes('img'), false);
    assert.equal(messages[0]?.html?.includes('onerror'), false);
    assert.equal(messages[0]?.html?.includes('javascript:'), false);
    assert.equal(messages[0]?.html?.includes('https://example.com/ok'), true);
    assert.equal(messages[0]?.imagesOmitted, true);
    assert.equal(messages[0]?.unread, true);
    assert.deepEqual(messages[0]?.attachments, [
      { fileName: '..secret.pdf', mimeType: 'application/pdf', size: 42 }
    ]);
    assert.equal(JSON.stringify(messages).includes('pdf-bytes'), false);
  });

  it('rejects illegal base64, a non-array parts value, deep nesting, and an oversized part', () => {
    assert.throws(
      () =>
        decodeConversation('threadone', [
          { id: 'messageone', payload: { mimeType: 'text/plain', body: { data: 'ab+c' } } }
        ]),
      (error: unknown) => error instanceof GmailError && error.code === 'unavailable'
    );
    assert.throws(
      () =>
        decodeConversation('threadone', [
          { id: 'messageone', payload: { mimeType: 'multipart/mixed', parts: {} } }
        ]),
      (error: unknown) => error instanceof GmailError && error.code === 'unavailable'
    );
    let nested: unknown = textPart('text/plain', 'leaf');
    for (let index = 0; index < 8; index += 1) {
      nested = { mimeType: 'multipart/mixed', parts: [nested] };
    }
    assert.throws(
      () => decodeConversation('threadone', [{ id: 'messageone', payload: nested }]),
      (error: unknown) => error instanceof GmailError && error.code === 'too-large'
    );
    assert.throws(
      () =>
        decodeConversation('threadone', [
          {
            id: 'messageone',
            payload: textPart('text/plain', 'a'.repeat(1_000_001))
          }
        ]),
      (error: unknown) => error instanceof GmailError && error.code === 'too-large'
    );
  });

  it('reads a content-disposition file name and clips header text', () => {
    const messages = decodeConversation('threadone', [
      {
        id: 'messageone',
        internalDate: '1000',
        payload: {
          mimeType: 'multipart/related',
          headers: [
            { name: 1, value: 'skip' },
            'skip',
            { name: 'Subject', value: `Hello\u0000${'s'.repeat(2000)}` }
          ],
          parts: [
            {
              mimeType: 'text/plain',
              headers: [
                { name: 'Content-Type', value: 'text/plain; charset=windows-1252' },
                { name: 'Subject', value: `Hello\u0000${'s'.repeat(998)}` }
              ],
              body: { data: Buffer.from('caf\u00e9', 'latin1').toString('base64url') }
            },
            {
              mimeType: 'application/octet-stream',
              headers: [{ name: 'Content-Disposition', value: 'attachment; filename="notes.txt"' }],
              body: { size: 3 }
            }
          ]
        }
      }
    ]);
    assert.equal(messages[0]?.text, 'café');
    assert.equal(messages[0]?.subject?.length, 998);
    assert.equal(messages[0]?.subject?.startsWith('Hellos'), true);
    assert.deepEqual(messages[0]?.attachments, [
      { fileName: 'notes.txt', mimeType: 'application/octet-stream', size: 3 }
    ]);
  });

  it('decodes UTF-8 Spanish text mislabeled as us-ascii', () => {
    const messages = decodeConversation('threadone', [
      {
        id: 'messageone',
        internalDate: '1000',
        payload: textPartBytes('text/plain', spanishUtf8, 'charset="us-ascii"')
      }
    ]);
    assert.equal(messages[0]?.text, 'suscripción');
  });

  it('decodes UTF-8 Spanish text mislabeled as iso-8859-1', () => {
    const messages = decodeConversation('threadone', [
      {
        id: 'messageone',
        internalDate: '1000',
        payload: textPartBytes('text/plain', spanishUtf8, 'charset=iso-8859-1')
      }
    ]);
    assert.equal(messages[0]?.text, 'suscripción');
  });

  it('decodes UTF-8 Spanish text mislabeled as windows-1252', () => {
    const messages = decodeConversation('threadone', [
      {
        id: 'messageone',
        internalDate: '1000',
        payload: textPartBytes('text/plain', spanishUtf8, 'charset=windows-1252')
      }
    ]);
    assert.equal(messages[0]?.text, 'suscripción');
  });

  it('decodes genuine Windows-1252 Spanish text', () => {
    const messages = decodeConversation('threadone', [
      {
        id: 'messageone',
        internalDate: '1000',
        payload: textPartBytes('text/plain', spanishWindows1252, 'charset=windows-1252')
      }
    ]);
    const parsed = parseGmailThread({ id: 'threadone', messages });
    assert.equal(parsed?.messages[0]?.text, 'suscripción €');
  });

  it('keeps correctly labeled UTF-8, including an invalid byte', () => {
    const valid = decodeConversation('threadone', [
      {
        id: 'messageone',
        internalDate: '1000',
        payload: textPartBytes('text/plain', spanishUtf8, 'charset=utf-8')
      }
    ]);
    assert.equal(valid[0]?.text, 'suscripción');
    const replaced = decodeConversation('threadone', [
      {
        id: 'messageone',
        internalDate: '1000',
        payload: textPartBytes('text/plain', Buffer.from([0xff]), 'charset=utf-8')
      }
    ]);
    assert.equal(replaced[0]?.text, '\uFFFD');
    const otherCharset = decodeConversation('threadone', [
      {
        id: 'messageone',
        internalDate: '1000',
        payload: textPartBytes('text/plain', Buffer.from([0xf3]), 'charset=iso-8859-2')
      }
    ]);
    assert.equal(otherCharset[0]?.text, '\uFFFD');
  });

  it('decodes a mislabeled conversation and passes the shared thread parser', () => {
    const messages = decodeConversation('threadone', [
      {
        id: 'messageone',
        internalDate: '1000',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [{ name: 'Subject', value: 'suscripción' }],
          parts: [
            textPartBytes(
              'text/plain',
              Buffer.from('suscripción\r\n', 'utf8'),
              'charset=iso-8859-1'
            ),
            textPartBytes(
              'text/html',
              Buffer.from('<p>suscripción</p>', 'utf8'),
              'charset=iso-8859-1'
            )
          ]
        }
      }
    ]);
    const parsed = parseGmailThread({ id: 'threadone', messages });
    assert.equal(parsed?.messages[0]?.text, 'suscripción\r\n');
    assert.equal(parsed?.messages[0]?.html?.includes('suscripción'), true);
    assert.equal(parsed?.messages[0]?.html?.includes('<p>'), true);
    assert.equal(parsed?.messages[0]?.subject, 'suscripción');
  });

  it('rejects 51 messages instead of returning the oldest ones', () => {
    const messages = Array.from({ length: 51 }, (_value, index) => ({
      id: `m${index}`,
      internalDate: String(index),
      payload: textPart('text/plain', 'short')
    }));
    assert.throws(
      () => decodeConversation('threadone', messages),
      (error: unknown) => error instanceof GmailError && error.code === 'too-large'
    );
  });
});
