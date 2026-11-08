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

export function buildOutgoingRaw(input: {
  fromName: string | null;
  fromEmail: string;
  recipients: ComposeRecipients;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: readonly string[];
  now: Date;
}): string {
  if (!isComposeBody(input.body) || hasHeaderBreak(input.subject))
    throw new GmailError('invalid-request');
  if (utf8Bytes(input.body) > composeBodyByteLimit) throw new GmailError('too-large');
  const headers = [
    'MIME-Version: 1.0',
    fold('Date', imfDate(input.now)),
    fold('From', formatAddress(input.fromName, input.fromEmail)),
    addressHeader('To', input.recipients.to),
    addressHeader('Cc', input.recipients.cc),
    addressHeader('Bcc', input.recipients.bcc),
    fold('Subject', headerText(input.subject)),
    input.inReplyTo === null ? null : fold('In-Reply-To', input.inReplyTo),
    input.references.length === 0 ? null : fold('References', input.references.join(' ')),
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ].filter((line): line is string => line !== null);
  const message = `${headers.join('\r\n')}\r\n\r\n${encodeBody(input.body)}\r\n`;
  const raw = Buffer.from(message, 'utf8').toString('base64url');
  if (utf8Bytes(raw) > composeRawByteLimit) throw new GmailError('too-large');
  return raw;
}
