import { isGoogleAccountId } from './google-accounts.ts';
import {
  type ComposeMessage,
  type ComposeSeed,
  type ComposeSeedQuery,
  type ComposeSent
} from './mail-compose.ts';

export const gmailLabelsChannel = 'gmail:labels';
export const gmailThreadsChannel = 'gmail:threads';
export const gmailThreadChannel = 'gmail:thread';
export const gmailOpenLinkChannel = 'gmail:open-link';
export const gmailMarkReadChannel = 'gmail:mark-read';
export const gmailMarkUnreadChannel = 'gmail:mark-unread';
export const gmailArchiveThreadChannel = 'gmail:archive-thread';
export const gmailTrashThreadChannel = 'gmail:trash-thread';
export const gmailUntrashThreadChannel = 'gmail:untrash-thread';
export const gmailAddLabelChannel = 'gmail:add-label';
export const gmailRemoveLabelChannel = 'gmail:remove-label';
export const gmailStarMessageChannel = 'gmail:star-message';
export const gmailUnstarMessageChannel = 'gmail:unstar-message';
export const gmailComposeSeedChannel = 'gmail:compose-seed';
export const gmailSendMessageChannel = 'gmail:send-message';

export const gmailChannels = [
  gmailLabelsChannel,
  gmailThreadsChannel,
  gmailThreadChannel,
  gmailOpenLinkChannel,
  gmailMarkReadChannel,
  gmailMarkUnreadChannel,
  gmailArchiveThreadChannel,
  gmailTrashThreadChannel,
  gmailUntrashThreadChannel,
  gmailAddLabelChannel,
  gmailRemoveLabelChannel,
  gmailStarMessageChannel,
  gmailUnstarMessageChannel,
  gmailComposeSeedChannel,
  gmailSendMessageChannel
] as const;

export type GmailChannel = (typeof gmailChannels)[number];

export const gmailErrorCodes = [
  'unauthorized',
  'invalid-request',
  'invalid-response',
  'needs-reauth',
  'network',
  'encryption-unavailable',
  'operation-in-progress',
  'rate-limited',
  'unavailable',
  'not-found',
  'too-large',
  'permission-denied',
  'insufficient-scope',
  'gmail-rejected',
  'send-unconfirmed',
  'internal'
] as const;

export type GmailErrorCode = (typeof gmailErrorCodes)[number];

export type GmailResult<T> =
  { ok: true; value: T } | { ok: false; error: { code: GmailErrorCode } };

const messages: Record<GmailErrorCode, string> = {
  unauthorized: 'Request rejected.',
  'invalid-request': 'Request rejected.',
  'invalid-response': 'Response rejected.',
  'needs-reauth': 'The saved Google credential can no longer be used.',
  network: 'Aurora could not reach Google.',
  'encryption-unavailable': 'Credential protection is unavailable.',
  'operation-in-progress': 'Another Google account change is already in progress.',
  'rate-limited': 'Gmail is limiting requests. Try again in a moment.',
  unavailable: 'Aurora could not read this mailbox.',
  'not-found': 'This conversation is no longer available.',
  'too-large': 'This conversation is too large to show.',
  'permission-denied': 'Gmail did not allow this request.',
  'insufficient-scope': 'Reconnect this Google account before changing mail.',
  'gmail-rejected': 'Gmail refused this request.',
  'send-unconfirmed':
    'Aurora could not confirm whether Gmail sent this message. Check Sent before sending it again.',
  internal: 'Request failed.'
};

export class GmailIpcError extends Error {
  readonly code: GmailErrorCode;

  constructor(code: GmailErrorCode) {
    super(messages[code]);
    this.name = 'GmailIpcError';
    this.code = code;
  }
}

export function gmailErrorMessage(code: GmailErrorCode): string {
  return messages[code];
}

export const gmailIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

export interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  unreadCount: number | null;
}

export interface GmailLabelList {
  labels: GmailLabel[];
}

export interface GmailThreadSummary {
  id: string;
  subject: string | null;
  from: string | null;
  date: string | null;
  snippet: string | null;
  unread: boolean;
  starred: boolean;
}

export interface GmailThreadList {
  threads: GmailThreadSummary[];
  nextPageToken: string | null;
}

export interface GmailAttachment {
  fileName: string;
  mimeType: string;
  size: number;
}

export interface GmailMessage {
  id: string;
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  date: string | null;
  unread: boolean;
  starred: boolean;
  labelIds: string[];
  text: string | null;
  html: string | null;
  imagesOmitted: boolean;
  attachments: GmailAttachment[];
}

export interface GmailThread {
  id: string;
  messages: GmailMessage[];
}

export interface GmailOpenedLink {
  opened: true;
}

export interface GmailReadState {
  threadId: string;
  unread: boolean;
}

export interface GmailThreadChanged {
  threadId: string;
}

export interface GmailLabelChanged {
  threadId: string;
  labelId: string;
}

export interface GmailStarChanged {
  threadId: string;
  messageId: string;
  starred: boolean;
}

export interface GmailThreadQuery {
  accountId: string;
  labelId: string | null;
  query: string | null;
  pageToken: string | null;
}

const datePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const actual = Object.getOwnPropertyNames(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function hasDisallowedBodyControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function isGmailId(value: unknown): value is string {
  return typeof value === 'string' && gmailIdPattern.test(value);
}

export function isGmailPageToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 1024 &&
    !hasControlCharacter(value)
  );
}

function isGmailErrorCode(value: unknown): value is GmailErrorCode {
  return typeof value === 'string' && gmailErrorCodes.some((code) => code === value);
}

function boundedText(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) return undefined;
  if (hasControlCharacter(value)) return undefined;
  return value;
}

function boundedBody(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) return undefined;
  if (hasDisallowedBodyControl(value)) return undefined;
  return value;
}

function optionalDate(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !datePattern.test(value)) return undefined;
  return value;
}

function isUnreadCount(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
}

function isLabel(value: unknown): value is GmailLabel {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'name', 'type', 'unreadCount'])) return false;
  if (!isGmailId(value.id)) return false;
  const name = boundedText(value.name, 256);
  if (name === undefined || name === null) return false;
  if (value.type !== 'system' && value.type !== 'user') return false;
  return isUnreadCount(value.unreadCount);
}

function isLabelIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every((id) => isGmailId(id));
}

function isSummary(value: unknown): value is GmailThreadSummary {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'subject', 'from', 'date', 'snippet', 'unread', 'starred'])
  ) {
    return false;
  }
  if (
    !isGmailId(value.id) ||
    typeof value.unread !== 'boolean' ||
    typeof value.starred !== 'boolean'
  )
    return false;
  if (boundedText(value.subject, 998) === undefined) return false;
  if (boundedText(value.from, 2000) === undefined) return false;
  if (boundedText(value.snippet, 500) === undefined) return false;
  return optionalDate(value.date) !== undefined;
}

function isAttachment(value: unknown): value is GmailAttachment {
  if (!isRecord(value) || !hasExactKeys(value, ['fileName', 'mimeType', 'size'])) return false;
  const fileName = boundedText(value.fileName, 256);
  const mimeType = boundedText(value.mimeType, 256);
  if (fileName === undefined || fileName === null) return false;
  if (mimeType === undefined || mimeType === null) return false;
  return (
    typeof value.size === 'number' &&
    Number.isInteger(value.size) &&
    value.size >= 0 &&
    value.size <= Number.MAX_SAFE_INTEGER
  );
}

function isMessage(value: unknown): value is GmailMessage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'from',
      'to',
      'cc',
      'bcc',
      'subject',
      'date',
      'unread',
      'starred',
      'labelIds',
      'text',
      'html',
      'imagesOmitted',
      'attachments'
    ])
  ) {
    return false;
  }
  if (
    !isGmailId(value.id) ||
    typeof value.unread !== 'boolean' ||
    typeof value.starred !== 'boolean' ||
    !isLabelIdList(value.labelIds)
  ) {
    return false;
  }
  if (typeof value.imagesOmitted !== 'boolean' || !Array.isArray(value.attachments)) return false;
  if (value.attachments.length > 100) return false;
  if (boundedText(value.from, 2000) === undefined) return false;
  if (boundedText(value.to, 2000) === undefined) return false;
  if (boundedText(value.cc, 2000) === undefined) return false;
  if (boundedText(value.bcc, 2000) === undefined) return false;
  if (boundedText(value.subject, 998) === undefined) return false;
  if (optionalDate(value.date) === undefined) return false;
  if (boundedBody(value.text, 1_500_000) === undefined) return false;
  if (boundedBody(value.html, 1_500_000) === undefined) return false;
  return value.attachments.every((attachment) => isAttachment(attachment));
}

export function parseGmailResult<T>(
  value: unknown,
  parseValue: (value: unknown) => T | null
): GmailResult<T> {
  const invalid: GmailResult<T> = { ok: false, error: { code: 'invalid-response' } };
  if (!isRecord(value) || typeof value.ok !== 'boolean') return invalid;
  if (value.ok) {
    if (!hasExactKeys(value, ['ok', 'value'])) return invalid;
    const parsed = parseValue(value.value);
    if (parsed === null) return invalid;
    return { ok: true, value: parsed };
  }
  if (!hasExactKeys(value, ['ok', 'error']) || !isRecord(value.error)) return invalid;
  if (!hasExactKeys(value.error, ['code']) || !isGmailErrorCode(value.error.code)) return invalid;
  return { ok: false, error: { code: value.error.code } };
}

export function parseGmailLabelList(value: unknown): GmailLabelList | null {
  if (!isRecord(value) || !hasExactKeys(value, ['labels']) || !Array.isArray(value.labels)) {
    return null;
  }
  if (value.labels.length > 500) return null;
  const labels: GmailLabel[] = [];
  for (const label of value.labels) {
    if (!isLabel(label)) return null;
    labels.push(label);
  }
  return { labels };
}

export function parseGmailThreadList(value: unknown): GmailThreadList | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['threads', 'nextPageToken']) ||
    !Array.isArray(value.threads)
  ) {
    return null;
  }
  if (value.threads.length > 20) return null;
  if (value.nextPageToken !== null && !isGmailPageToken(value.nextPageToken)) return null;
  const threads: GmailThreadSummary[] = [];
  for (const thread of value.threads) {
    if (!isSummary(thread)) return null;
    threads.push(thread);
  }
  return { threads, nextPageToken: value.nextPageToken };
}

export function parseGmailThread(value: unknown): GmailThread | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'messages']) ||
    !isGmailId(value.id) ||
    !Array.isArray(value.messages)
  ) {
    return null;
  }
  if (value.messages.length > 50) return null;
  const messages: GmailMessage[] = [];
  for (const message of value.messages) {
    if (!isMessage(message)) return null;
    messages.push(message);
  }
  return { id: value.id, messages };
}

export function parseGmailOpenedLink(value: unknown): GmailOpenedLink | null {
  if (!isRecord(value) || !hasExactKeys(value, ['opened']) || value.opened !== true) return null;
  return { opened: true };
}

export function parseGmailReadState(value: unknown): GmailReadState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['threadId', 'unread']) ||
    !isGmailId(value.threadId) ||
    typeof value.unread !== 'boolean'
  ) {
    return null;
  }
  return { threadId: value.threadId, unread: value.unread };
}

export function parseGmailThreadChanged(value: unknown): GmailThreadChanged | null {
  if (!isRecord(value) || !hasExactKeys(value, ['threadId']) || !isGmailId(value.threadId)) {
    return null;
  }
  return { threadId: value.threadId };
}

export function parseGmailLabelChanged(value: unknown): GmailLabelChanged | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['threadId', 'labelId']) ||
    !isGmailId(value.threadId) ||
    !isGmailId(value.labelId)
  ) {
    return null;
  }
  return { threadId: value.threadId, labelId: value.labelId };
}

export function parseGmailStarChanged(value: unknown): GmailStarChanged | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['threadId', 'messageId', 'starred']) ||
    !isGmailId(value.threadId) ||
    !isGmailId(value.messageId) ||
    typeof value.starred !== 'boolean'
  ) {
    return null;
  }
  return { threadId: value.threadId, messageId: value.messageId, starred: value.starred };
}

export function parseGmailThreadQuery(value: unknown): GmailThreadQuery | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['accountId', 'labelId', 'query', 'pageToken']) ||
    !isGoogleAccountId(value.accountId)
  ) {
    return null;
  }
  const labelId = value.labelId;
  const query = boundedText(value.query, 512);
  const pageToken = value.pageToken;
  if (labelId !== null && !isGmailId(labelId)) return null;
  if (query === undefined) return null;
  if (pageToken !== null && !isGmailPageToken(pageToken)) return null;
  return {
    accountId: value.accountId,
    labelId,
    query,
    pageToken
  };
}

export function unwrapGmailResult<T>(value: unknown, parseValue: (value: unknown) => T | null): T {
  const result = parseGmailResult(value, parseValue);
  if (!result.ok) throw new GmailIpcError(result.error.code);
  return result.value;
}

export interface GmailBridge {
  listLabels(accountId: string): Promise<GmailResult<GmailLabelList>>;
  listThreads(query: GmailThreadQuery): Promise<GmailResult<GmailThreadList>>;
  readThread(accountId: string, threadId: string): Promise<GmailResult<GmailThread>>;
  openLink(url: string): Promise<GmailResult<GmailOpenedLink>>;
  markRead(accountId: string, threadId: string): Promise<GmailResult<GmailReadState>>;
  markUnread(accountId: string, threadId: string): Promise<GmailResult<GmailReadState>>;
  archiveThread(accountId: string, threadId: string): Promise<GmailResult<GmailThreadChanged>>;
  trashThread(accountId: string, threadId: string): Promise<GmailResult<GmailThreadChanged>>;
  untrashThread(accountId: string, threadId: string): Promise<GmailResult<GmailThreadChanged>>;
  addLabel(
    accountId: string,
    threadId: string,
    labelId: string
  ): Promise<GmailResult<GmailLabelChanged>>;
  removeLabel(
    accountId: string,
    threadId: string,
    labelId: string
  ): Promise<GmailResult<GmailLabelChanged>>;
  starMessage(
    accountId: string,
    threadId: string,
    messageId: string
  ): Promise<GmailResult<GmailStarChanged>>;
  unstarMessage(
    accountId: string,
    threadId: string,
    messageId: string
  ): Promise<GmailResult<GmailStarChanged>>;
  composeSeed(query: ComposeSeedQuery): Promise<GmailResult<ComposeSeed>>;
  sendMessage(message: ComposeMessage): Promise<GmailResult<ComposeSent>>;
}

export interface GmailApi {
  listLabels(accountId: string): Promise<GmailLabelList>;
  listThreads(query: GmailThreadQuery): Promise<GmailThreadList>;
  readThread(accountId: string, threadId: string): Promise<GmailThread>;
  openLink(url: string): Promise<GmailOpenedLink>;
  markRead(accountId: string, threadId: string): Promise<GmailReadState>;
  markUnread(accountId: string, threadId: string): Promise<GmailReadState>;
  archiveThread(accountId: string, threadId: string): Promise<GmailThreadChanged>;
  trashThread(accountId: string, threadId: string): Promise<GmailThreadChanged>;
  untrashThread(accountId: string, threadId: string): Promise<GmailThreadChanged>;
  addLabel(accountId: string, threadId: string, labelId: string): Promise<GmailLabelChanged>;
  removeLabel(accountId: string, threadId: string, labelId: string): Promise<GmailLabelChanged>;
  starMessage(accountId: string, threadId: string, messageId: string): Promise<GmailStarChanged>;
  unstarMessage(accountId: string, threadId: string, messageId: string): Promise<GmailStarChanged>;
  composeSeed(query: ComposeSeedQuery): Promise<ComposeSeed>;
  sendMessage(message: ComposeMessage): Promise<ComposeSent>;
}
