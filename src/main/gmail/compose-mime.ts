import { randomBytes } from 'node:crypto';
import { GmailError } from './errors.ts';
import {
  composeBodyByteLimit,
  hasHeaderBreak,
  isComposeBody,
  isMailboxAddress,
  utf8Bytes,
  type ComposeRecipients
} from '../../shared/mail-compose.ts';

export const composeRawByteLimit = 1_048_576;
export const draftRawByteLimit = 12_582_912;

const mediaTypePattern = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

export interface OutgoingFile {
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}

const encodedWordLimit = 45;

function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function encodeWords(value: string): string {
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const character of value) {
    const size = utf8Bytes(character);
    if (bytes + size > encodedWordLimit && chunk.length > 0) {
      words.push(encodedWord(chunk));
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk.length > 0) words.push(encodedWord(chunk));
  return words.join(' ');
}

function headerText(value: string): string {
  if (hasHeaderBreak(value)) throw new GmailError('invalid-request');
  const ascii = [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code <= 126;
  });
  return ascii ? value : encodeWords(value);
}

export function formatAddress(name: string | null, email: string): string {
  if (!isMailboxAddress(email)) throw new GmailError('invalid-request');
  const display = name?.trim() ?? '';
  if (display.length === 0 || display.length > 200 || hasHeaderBreak(display)) return email;
  if (/[^\u0020-\u007e]/.test(display) || /["\\]/.test(display)) {
    return `${encodeWords(display)} <${email}>`;
  }
  if (/[()<>@,;:[\]"]/.test(display) || display.includes(' ')) return `"${display}" <${email}>`;
  return `${display} <${email}>`;
}

function fold(name: string, value: string): string {
  const words = value.split(' ');
  const lines: string[] = [];
  let current = `${name}:`;
  for (const word of words) {
    const next = `${current} ${word}`;
    if (next.length > 78 && current !== `${name}:`) {
      lines.push(current);
      current = ` ${word}`;
    } else current = next;
  }
  lines.push(current);
  return lines.join('\r\n');
}

function addressHeader(name: string, addresses: readonly string[]): string | null {
  if (addresses.length === 0) return null;
  if (addresses.some((address) => !isMailboxAddress(address)))
    throw new GmailError('invalid-request');
  return fold(name, addresses.join(', '));
}

export function imfDate(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ];
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

function encodeBody(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  const encoded = Buffer.from(normalized, 'utf8').toString('base64');
  const lines = encoded.match(/.{1,76}/g);
  return lines === null ? '' : lines.join('\r\n');
}

function encodeBytes(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString('base64');
  const lines = encoded.match(/.{1,76}/g);
  return lines === null ? '' : lines.join('\r\n');
}

function safeFileName(value: string): string {
  let text = '';
  for (const character of value) {
    if (character === '/' || character === '\\' || character === '"' || character === ';') continue;
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) continue;
    text += character;
    if (text.length === 200) break;
  }
  const trimmed = text.trim();
  return trimmed.length === 0 ? 'Attachment' : trimmed;
}

function fileNameParameter(value: string): string {
  const name = safeFileName(value);
  if (hasHeaderBreak(name)) throw new GmailError('invalid-request');
  const ascii = [...name].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code <= 126;
  });
  if (ascii) return `filename="${name}"`;
  return `filename*=UTF-8''${encodeURIComponent(name)}`;
}

function mixedBoundary(body: string, files: readonly OutgoingFile[]): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = randomBytes(18)
      .toString('base64url')
      .replace(/[^A-Za-z0-9]/g, 'A')
      .slice(0, 24)
      .padEnd(24, 'A');
    const visible = body.includes(token) || files.some((file) => file.fileName.includes(token));
    const embedded = files.some((file) =>
      Buffer.from(file.bytes).toString('latin1').includes(token)
    );
    if (!visible && !embedded) return token;
  }
  throw new GmailError('unavailable');
}

export function buildOutgoingRaw(input: {
  fromName: string | null;
  fromEmail: string;
  recipients: ComposeRecipients;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: readonly string[];
  now: Date;
  files?: readonly OutgoingFile[];
}): string {
  if (!isComposeBody(input.body) || hasHeaderBreak(input.subject))
    throw new GmailError('invalid-request');
  if (utf8Bytes(input.body) > composeBodyByteLimit) throw new GmailError('too-large');
  const files = input.files ?? [];
  if (files.length > 10) throw new GmailError('too-large');
  let fileBytes = 0;
  for (const file of files) {
    if (!mediaTypePattern.test(file.mediaType) || hasHeaderBreak(file.fileName)) {
      throw new GmailError('invalid-request');
    }
    fileBytes += file.bytes.byteLength;
    if (fileBytes > 5 * 1024 * 1024) throw new GmailError('too-large');
  }
  const common = [
    'MIME-Version: 1.0',
    fold('Date', imfDate(input.now)),
    fold('From', formatAddress(input.fromName, input.fromEmail)),
    addressHeader('To', input.recipients.to),
    addressHeader('Cc', input.recipients.cc),
    addressHeader('Bcc', input.recipients.bcc),
    fold('Subject', headerText(input.subject)),
    input.inReplyTo === null ? null : fold('In-Reply-To', input.inReplyTo),
    input.references.length === 0 ? null : fold('References', input.references.join(' '))
  ].filter((line): line is string => line !== null);
  let message: string;
  if (files.length === 0) {
    message = `${[...common, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'].join('\r\n')}\r\n\r\n${encodeBody(input.body)}\r\n`;
  } else {
    const boundary = mixedBoundary(input.body, files);
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBody(input.body),
      ...files.flatMap((file) => [
        `--${boundary}`,
        `Content-Type: ${file.mediaType}`,
        `Content-Disposition: attachment; ${fileNameParameter(file.fileName)}`,
        'Content-Transfer-Encoding: base64',
        '',
        encodeBytes(file.bytes)
      ]),
      `--${boundary}--`,
      ''
    ];
    message = `${[...common, `Content-Type: multipart/mixed; boundary="${boundary}"`].join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
  }
  const raw = Buffer.from(message, 'utf8').toString('base64url');
  const limit = files.length === 0 ? composeRawByteLimit : draftRawByteLimit;
  if (utf8Bytes(raw) > limit) throw new GmailError('too-large');
  return raw;
}
