import { isGoogleAccountId } from './google-accounts.ts';
import { isGmailId } from './gmail.ts';

export const composeBodyByteLimit = 262_144;
export const composeRecipientLimit = 50;
export const composeSubjectLimit = 998;

export const composeSeedKinds = ['reply', 'reply-all', 'forward'] as const;
export const composeSendKinds = ['new', 'reply', 'reply-all', 'forward'] as const;

export type ComposeSeedKind = (typeof composeSeedKinds)[number];
export type ComposeSendKind = (typeof composeSendKinds)[number];

export interface ComposeSeedQuery {
  accountId: string;
  threadId: string;
  messageId: string;
  kind: ComposeSeedKind;
}

export interface ComposeSeed {
  to: string[];
  cc: string[];
  subject: string;
}

export interface ComposeMessage {
  accountId: string;
  kind: ComposeSendKind;
  threadId: string | null;
  messageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export interface ComposeSent {
  id: string;
  threadId: string | null;
}

export interface ComposeRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

const mailboxPattern =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const messageIdPattern = /<[A-Za-z0-9!#$%&'*+/=?^_`{|}~.@-]{1,200}>/g;
const replyPrefix = /^(?:(?:re|fw|fwd)\s*:\s*)+/i;
const forwardPrefix = /^(?:fw|fwd)\s*:\s*/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const actual = Object.getOwnPropertyNames(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

export function hasHeaderBreak(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 0 || code === 10 || code === 13) return true;
  }
  return false;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function isMailboxAddress(value: string): boolean {
  return value.length <= 254 && mailboxPattern.test(value) && !hasHeaderBreak(value);
}

export function isComposeBody(value: string): boolean {
  if (utf8Bytes(value) > composeBodyByteLimit) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

export function mailboxesFromHeader(value: string): string[] {
  if (hasHeaderBreak(value)) return [];
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angled = false;
  for (const character of value) {
    if (character === '"' && !angled) quoted = !quoted;
    else if (character === '<' && !quoted) angled = true;
    else if (character === '>' && !quoted) angled = false;
    if (character === ',' && !quoted && !angled) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  const addresses: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const angledAddress = trimmed.match(/<([^<>]+)>\s*$/);
    const candidate = (angledAddress?.[1] ?? trimmed).trim();
    if (isMailboxAddress(candidate)) addresses.push(candidate);
  }
  return addresses;
}

export function messageIdsFromHeader(value: string): string[] {
  if (hasHeaderBreak(value)) return [];
  return value.match(messageIdPattern) ?? [];
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function without(values: readonly string[], banned: readonly string[]): string[] {
  return values.filter((value) => !banned.some((item) => sameAddress(value, item)));
}

export function collectRecipients(
  to: readonly string[],
  cc: readonly string[],
  bcc: readonly string[],
  allowEmpty = false
): ComposeRecipients | null {
  const seen = new Set<string>();
  const take = (values: readonly string[], into: string[]): boolean => {
    for (const value of values) {
      if (!isMailboxAddress(value)) return false;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      if (seen.size >= composeRecipientLimit) return false;
      seen.add(key);
      into.push(value);
    }
    return true;
  };
  const nextTo: string[] = [];
  const nextCc: string[] = [];
  const nextBcc: string[] = [];
  if (!take(to, nextTo) || !take(cc, nextCc) || !take(bcc, nextBcc)) return null;
  if (seen.size === 0 && !allowEmpty) return null;
  return { to: nextTo, cc: nextCc, bcc: nextBcc };
}

export function replySubject(source: string): string | null {
  if (hasHeaderBreak(source) || source.length > composeSubjectLimit) return null;
  const stripped = source.replace(replyPrefix, '').trim();
  const subject = stripped.length === 0 ? 'Re:' : `Re: ${stripped}`;
  if (hasHeaderBreak(subject) || subject.length > composeSubjectLimit + 4) return null;
  return subject;
}

export function forwardSubject(source: string): string | null {
  if (hasHeaderBreak(source) || source.length > composeSubjectLimit) return null;
  const stripped = source.replace(forwardPrefix, '');
  const subject = stripped.length === 0 ? 'Fwd:' : `Fwd: ${stripped}`;
  if (hasHeaderBreak(subject) || subject.length > composeSubjectLimit + 5) return null;
  return subject;
}

export function seedRecipients(input: {
  kind: ComposeSeedKind;
  from: readonly string[];
  to: readonly string[];
  cc: readonly string[];
  replyTo: readonly string[];
  selfAddress: string;
}): ComposeRecipients {
  if (input.kind === 'forward') return { to: [], cc: [], bcc: [] };
  const target = input.replyTo.length > 0 ? [...input.replyTo] : [...input.from];
  let to = target;
  if (
    to.length > 0 &&
    to.every((address) => sameAddress(address, input.selfAddress)) &&
    input.to.some((address) => !sameAddress(address, input.selfAddress))
  ) {
    to = [...input.to];
  }
  if (input.kind === 'reply') {
    return collectRecipients(to, [], []) ?? { to: [], cc: [], bcc: [] };
  }
  const withoutSelf = without(to, [input.selfAddress]);
  const replyTo = withoutSelf.length > 0 ? withoutSelf : to;
  const cc = without([...input.to, ...input.cc], [...replyTo, input.selfAddress]);
  return collectRecipients(replyTo, cc, []) ?? { to: [], cc: [], bcc: [] };
}

export function trimReferences(existing: readonly string[], parent: string): string[] {
  const all = [...existing];
  if (all[all.length - 1] !== parent) all.push(parent);
  if (all.length <= 10) return all;
  const head = all[0] ?? parent;
  const tail = all.slice(all.length - 9).filter((id) => id !== head);
  return [head, ...tail];
}

function shorten(value: string): string {
  const marker = '\n[Quoted text was shortened.]\n';
  if (utf8Bytes(value) <= composeBodyByteLimit) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, mid) + marker;
    if (utf8Bytes(candidate) <= composeBodyByteLimit) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low) + marker;
}

export function replyQuote(input: {
  from: string | null;
  date: string | null;
  text: string | null;
}): string {
  const body = input.text ?? 'The original message had no plain-text body.';
  const quoted = body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return shorten(`\n\nOn ${input.date ?? ''}, ${input.from ?? ''} wrote:\n${quoted}`);
}

export function forwardQuote(input: {
  from: string | null;
  date: string | null;
  subject: string | null;
  to: string | null;
  text: string | null;
}): string {
  const body = input.text ?? 'The original message had no plain-text body.';
  return shorten(
    `\n\n---------- Forwarded message ---------\nFrom: ${input.from ?? ''}\nDate: ${input.date ?? ''}\nSubject: ${input.subject ?? ''}\nTo: ${input.to ?? ''}\n\n${body}`
  );
}

function addressList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > composeRecipientLimit) return null;
  const addresses: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !isMailboxAddress(item)) return null;
    addresses.push(item);
  }
  return addresses;
}

function isSeedKind(value: unknown): value is ComposeSeedKind {
  return composeSeedKinds.some((kind) => kind === value);
}

function isSendKind(value: unknown): value is ComposeSendKind {
  return composeSendKinds.some((kind) => kind === value);
}

function composeText(value: unknown, maxLength: number, allowEmpty: boolean): string | null {
  if (typeof value !== 'string') return null;
  if (!allowEmpty && value.length === 0) return null;
  if (value.length > maxLength || hasHeaderBreak(value)) return null;
  return value;
}

export function parseComposeSeedQuery(value: unknown): ComposeSeedQuery | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['accountId', 'threadId', 'messageId', 'kind']) ||
    !isGoogleAccountId(value.accountId) ||
    !isGmailId(value.threadId) ||
    !isGmailId(value.messageId)
  ) {
    return null;
  }
  const kind = value.kind;
  if (!isSeedKind(kind)) return null;
  return {
    accountId: value.accountId,
    threadId: value.threadId,
    messageId: value.messageId,
    kind
  };
}

export function parseComposeSeed(value: unknown): ComposeSeed | null {
  if (!isRecord(value) || !hasExactKeys(value, ['to', 'cc', 'subject'])) return null;
  const to = addressList(value.to);
  const cc = addressList(value.cc);
  const subject = composeText(value.subject, composeSubjectLimit + 5, true);
  if (to === null || cc === null || subject === null) return null;
  return { to, cc, subject };
}

export function parseComposeMessage(value: unknown): ComposeMessage | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'accountId',
      'kind',
      'threadId',
      'messageId',
      'to',
      'cc',
      'bcc',
      'subject',
      'body'
    ]) ||
    !isGoogleAccountId(value.accountId) ||
    !isSendKind(value.kind)
  ) {
    return null;
  }
  const kind = value.kind;
  if (!isSendKind(kind)) return null;
  const to = addressList(value.to);
  const cc = addressList(value.cc);
  const bcc = addressList(value.bcc);
  const subject = composeText(value.subject, composeSubjectLimit + 5, true);
  if (to === null || cc === null || bcc === null || subject === null) return null;
  if (typeof value.body !== 'string' || !isComposeBody(value.body)) return null;
  const threaded = kind === 'reply' || kind === 'reply-all';
  if (threaded) {
    if (!isGmailId(value.threadId) || !isGmailId(value.messageId)) return null;
  } else if (value.threadId !== null || value.messageId !== null) return null;
  const recipients = collectRecipients(to, cc, bcc);
  if (recipients === null) return null;
  return {
    accountId: value.accountId,
    kind,
    threadId: threaded ? value.threadId : null,
    messageId: threaded ? value.messageId : null,
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    subject,
    body: value.body
  };
}

export function parseComposeSent(value: unknown): ComposeSent | null {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'threadId']) || !isGmailId(value.id)) {
    return null;
  }
  if (value.threadId !== null && !isGmailId(value.threadId)) return null;
  return { id: value.id, threadId: value.threadId };
}
