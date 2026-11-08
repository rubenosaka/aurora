import sanitizeHtml from 'sanitize-html';
import { acceptExternalUrl } from './links.ts';
import { GmailError } from './errors.ts';
import { type GmailAttachment, type GmailMessage } from '../../shared/gmail.ts';

const textPartLimit = 1_000_000;
const textSumLimit = 1_500_000;
const nestingLimit = 8;
const base64UrlPattern = /^[A-Za-z0-9_-]*={0,2}$/;
const mediaTypePattern = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const singleByteCharsets = new Set(['us-ascii', 'iso-8859-1', 'windows-1252']);
const windows1252From80 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178
];

const sanitizeOptions = {
  allowedTags: [
    'a',
    'p',
    'br',
    'div',
    'span',
    'strong',
    'em',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'hr'
  ],
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (_tagName: string, attribs: Record<string, string>) => {
      const href = acceptExternalUrl(attribs.href ?? '');
      return { tagName: 'a', attribs: href === null ? {} : { href } };
    }
  }
};

interface Header {
  name: string;
  value: string;
}

interface Collected {
  texts: string[];
  htmls: string[];
  attachments: GmailAttachment[];
  imagesOmitted: boolean;
  decodedUnits: number;
  alternativeText: boolean;
  alternativeHtml: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headersOf(value: unknown): Header[] {
  if (!Array.isArray(value)) return [];
  const headers: Header[] = [];
  for (const header of value) {
    if (!isRecord(header) || typeof header.name !== 'string' || typeof header.value !== 'string') {
      continue;
    }
    headers.push({ name: header.name, value: header.value });
  }
  return headers;
}

function headerValue(headers: Header[], name: string): string | null {
  const found = headers.find((header) => header.name.toLowerCase() === name);
  return found?.value ?? null;
}

function bounded(value: string, maxLength: number): string | null {
  let text = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) continue;
    text += character;
    if (text.length > maxLength) return text.slice(0, maxLength);
  }
  return text.length === 0 ? null : text;
}

function fileNameOf(filename: unknown, headers: Header[]): string | null {
  if (typeof filename === 'string' && filename.trim().length > 0) return filename;
  const disposition = headerValue(headers, 'content-disposition');
  if (disposition === null) return null;
  const match = /filename\*?=(?:UTF-8''|"?)([^";]+)/i.exec(disposition);
  const name = match?.[1]?.trim();
  return name === undefined || name.length === 0 ? null : name;
}

function displayFileName(value: string): string {
  let text = '';
  for (const character of value) {
    if (character === '/' || character === '\\') continue;
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) continue;
    text += character;
    if (text.length === 256) break;
  }
  return text.length === 0 ? 'Attachment' : text;
}

function mediaTypeOf(value: unknown): string {
  if (typeof value !== 'string' || !mediaTypePattern.test(value)) return 'application/octet-stream';
  return value;
}

function sizeOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0;
  if (value > Number.MAX_SAFE_INTEGER) return 0;
  return value;
}

function charsetOf(mimeType: string, headers: Header[]): string {
  const header = headerValue(headers, 'content-type') ?? mimeType;
  const match = /charset="?([^";\s]+)"?/i.exec(header);
  return match?.[1]?.toLowerCase() ?? 'utf-8';
}

function decodeText(data: string, charset: string): string {
  if (!base64UrlPattern.test(data)) throw new GmailError('unavailable');
  const bytes = Buffer.from(data, 'base64url');
  if (singleByteCharsets.has(charset)) return decodeSingleByteCharset(bytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function decodeSingleByteCharset(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return decodeWindows1252(bytes);
  }
}

function decodeWindows1252(bytes: Buffer): string {
  const codes = new Array<string>(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const point = byte >= 0x80 && byte <= 0x9f ? windows1252From80[byte - 0x80] : byte;
    codes[index] = String.fromCodePoint(point ?? byte);
  }
  return codes.join('');
}

function addText(
  collected: Collected,
  kind: 'text' | 'html',
  value: string,
  alternative: boolean
): void {
  if (value.length > textPartLimit) throw new GmailError('too-large');
  collected.decodedUnits += value.length;
  if (collected.decodedUnits > textSumLimit) throw new GmailError('too-large');
  if (kind === 'html') {
    if (/<\s*img\b/i.test(value)) collected.imagesOmitted = true;
    if (alternative && collected.alternativeHtml) return;
    if (alternative) collected.alternativeHtml = true;
    collected.htmls.push(value);
    return;
  }
  if (alternative && collected.alternativeText) return;
  if (alternative) collected.alternativeText = true;
  collected.texts.push(value);
}

function walk(part: unknown, depth: number, collected: Collected, alternative: boolean): void {
  if (depth > nestingLimit) throw new GmailError('too-large');
  if (!isRecord(part)) throw new GmailError('unavailable');
  const headers = headersOf(part.headers);
  const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
  if (part.parts !== undefined) {
    if (!Array.isArray(part.parts)) throw new GmailError('unavailable');
    const childAlternative = alternative || mimeType === 'multipart/alternative';
    for (const child of part.parts) walk(child, depth + 1, collected, childAlternative);
    return;
  }
  const filename = fileNameOf(part.filename, headers);
  const disposition = headerValue(headers, 'content-disposition') ?? '';
  if (filename !== null || /attachment/i.test(disposition)) {
    collected.attachments.push({
      fileName: displayFileName(filename ?? ''),
      mimeType: mediaTypeOf(part.mimeType),
      size: sizeOf(isRecord(part.body) ? part.body.size : 0)
    });
    return;
  }
  if (mimeType !== 'text/plain' && mimeType !== 'text/html') return;
  const data = isRecord(part.body) && typeof part.body.data === 'string' ? part.body.data : '';
  if (data.length === 0) return;
  const text = decodeText(data, charsetOf(mimeType, headers));
  addText(collected, mimeType === 'text/html' ? 'html' : 'text', text, alternative);
}

function sanitizedHtml(value: string): string | null {
  const clean = sanitizeHtml(value, sanitizeOptions).trim();
  return clean.length === 0 ? null : clean;
}

function stamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,13}$/.test(value)) return -1;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{1,13}$/.test(value)) return null;
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toISOString();
  } catch {
    return null;
  }
}

function messageId(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : fallback;
}

export function decodeConversation(threadId: string, messages: unknown[]): GmailMessage[] {
  if (messages.length > 50) throw new GmailError('too-large');
  const decoded = messages.map((message, index) => {
    if (!isRecord(message)) throw new GmailError('unavailable');
    const collected: Collected = {
      texts: [],
      htmls: [],
      attachments: [],
      imagesOmitted: false,
      decodedUnits: 0,
      alternativeText: false,
      alternativeHtml: false
    };
    walk(message.payload ?? { mimeType: 'text/plain' }, 1, collected, false);
    const text = collected.texts.join('\n');
    const htmlSource = collected.htmls.join('\n');
    if (text.length > textSumLimit || htmlSource.length > textSumLimit)
      throw new GmailError('too-large');
    const html = htmlSource.length === 0 ? null : sanitizedHtml(htmlSource);
    const headers = headersOf(isRecord(message.payload) ? message.payload.headers : undefined);
    const unread = Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD');
    return {
      order: stamp(message.internalDate),
      message: {
        id: messageId(message.id, `${threadId}-${index + 1}`),
        from: bounded(headerValue(headers, 'from') ?? '', 2000),
        to: bounded(headerValue(headers, 'to') ?? '', 2000),
        cc: bounded(headerValue(headers, 'cc') ?? '', 2000),
        bcc: bounded(headerValue(headers, 'bcc') ?? '', 2000),
        subject: bounded(headerValue(headers, 'subject') ?? '', 998),
        date: isoDate(message.internalDate),
        unread,
        text: text.length === 0 ? null : text,
        html,
        imagesOmitted: collected.imagesOmitted,
        attachments: collected.attachments
      } satisfies GmailMessage
    };
  });
  decoded.sort((left, right) => left.order - right.order);
  return decoded.map((item) => item.message);
}

export function utf8Size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
