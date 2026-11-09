import {
  type GmailBulkLabelRequest,
  type GmailBulkResult,
  type GmailBulkThreadsRequest,
  type GmailLabel,
  type GmailLabelDefinition,
  type GmailLabelDeleteRequest,
  type GmailLabelDeleted,
  type GmailLabelNameRequest,
  type GmailLabelRenameRequest,
  type GmailMessage,
  type GmailThreadSummary
} from '../../shared/gmail.ts';
import { isGmailId, isGmailPageToken } from '../../shared/gmail.ts';
import { isGoogleAccountId } from '../../shared/google-accounts.ts';
import {
  collectRecipients,
  forwardSubject,
  hasHeaderBreak,
  isMailboxAddress,
  mailboxesFromHeader,
  messageIdsFromHeader,
  replySubject,
  seedRecipients,
  trimReferences,
  type ComposeMessage,
  type ComposeSeed,
  type ComposeSeedQuery,
  type ComposeSent
} from '../../shared/mail-compose.ts';
import { OAuthFlowError } from '../oauth/errors.ts';
import { type GoogleAccountService } from '../oauth/google-accounts.ts';
import { PersistenceError } from '../persistence/errors.ts';
import { createBulkActions } from './bulk-actions.ts';
import { buildOutgoingRaw } from './compose-mime.ts';
import { createDraftActions } from './draft-actions.ts';
import { GmailError } from './errors.ts';
import { classifyGmailFailure, readLimitedBody, recordGmailFailure, retryDelay } from './http.ts';
import { acceptExternalUrl } from './links.ts';
import { decodeConversation, utf8Size } from './mime.ts';
import {
  type AttachmentDownloadRequest,
  type AttachmentDropRequest,
  type AttachmentPickRequest,
  type DraftDeleteRequest,
  type DraftOpenRequest,
  type DraftSaveRequest,
  type PickedAttachments
} from '../../shared/mail-draft.ts';

const gmailRoot = 'https://gmail.googleapis.com/gmail/v1/users/me';
const listPayloadLimit = 512_000;
const threadPayloadLimit = 2_000_000;
const visibleSystemLabels = ['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'STARRED', 'IMPORTANT'];
const metadataHeaders = ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date'];
const composeHeaders = [
  'From',
  'To',
  'Cc',
  'Reply-To',
  'Subject',
  'Date',
  'Message-ID',
  'References'
];

export interface GmailReaderDependencies {
  accounts: GoogleAccountService;
  fetchImpl: typeof fetch;
  openExternal: (url: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  pickFiles?: () => Promise<Array<{ name: string; bytes: Uint8Array }>>;
  chooseSavePath?: (fileName: string) => Promise<string | null>;
  writeSave?: (target: string, bytes: Uint8Array) => Promise<void>;
}

export interface GmailReader {
  listLabels(accountId: string): Promise<{ labels: GmailLabel[] }>;
  listThreads(input: {
    accountId: string;
    labelId: string | null;
    query: string | null;
    pageToken: string | null;
  }): Promise<{ threads: GmailThreadSummary[]; nextPageToken: string | null }>;
  readThread(
    accountId: string,
    threadId: string
  ): Promise<{ id: string; messages: GmailMessage[] }>;
  openLink(url: string): Promise<{ opened: true }>;
  markRead(accountId: string, threadId: string): Promise<{ threadId: string; unread: boolean }>;
  markUnread(accountId: string, threadId: string): Promise<{ threadId: string; unread: boolean }>;
  archiveThread(accountId: string, threadId: string): Promise<{ threadId: string }>;
  trashThread(accountId: string, threadId: string): Promise<{ threadId: string }>;
  untrashThread(accountId: string, threadId: string): Promise<{ threadId: string }>;
  addLabel(
    accountId: string,
    threadId: string,
    labelId: string
  ): Promise<{ threadId: string; labelId: string }>;
  removeLabel(
    accountId: string,
    threadId: string,
    labelId: string
  ): Promise<{ threadId: string; labelId: string }>;
  starMessage(
    accountId: string,
    threadId: string,
    messageId: string
  ): Promise<{ threadId: string; messageId: string; starred: boolean }>;
  unstarMessage(
    accountId: string,
    threadId: string,
    messageId: string
  ): Promise<{ threadId: string; messageId: string; starred: boolean }>;
  composeSeed(query: ComposeSeedQuery): Promise<ComposeSeed>;
  sendMessage(message: ComposeMessage): Promise<ComposeSent>;
  saveDraft(
    request: DraftSaveRequest
  ): ReturnType<ReturnType<typeof createDraftActions>['saveDraft']>;
  openDraft(
    request: DraftOpenRequest
  ): ReturnType<ReturnType<typeof createDraftActions>['openDraft']>;
  deleteDraft(
    request: DraftDeleteRequest
  ): ReturnType<ReturnType<typeof createDraftActions>['deleteDraft']>;
  sendDraft(
    request: DraftSaveRequest
  ): ReturnType<ReturnType<typeof createDraftActions>['sendDraft']>;
  pickAttachments(request: AttachmentPickRequest): Promise<PickedAttachments>;
  dropAttachment(request: AttachmentDropRequest): Promise<{ dropped: true }>;
  downloadAttachment(request: AttachmentDownloadRequest): Promise<{ saved: boolean }>;
  bulkThreads(request: GmailBulkThreadsRequest): Promise<GmailBulkResult>;
  bulkLabel(request: GmailBulkLabelRequest): Promise<GmailBulkResult>;
  createLabel(request: GmailLabelNameRequest): Promise<GmailLabelDefinition>;
  renameLabel(request: GmailLabelRenameRequest): Promise<GmailLabelDefinition>;
  deleteLabel(request: GmailLabelDeleteRequest): Promise<GmailLabelDeleted>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asGmail(error: unknown): GmailError {
  if (error instanceof GmailError) return error;
  if (error instanceof OAuthFlowError) {
    if (error.code === 'provider-rejected' || error.code === 'oauth-cancelled') {
      return new GmailError('unavailable');
    }
    if (
      error.code === 'needs-reauth' ||
      error.code === 'network' ||
      error.code === 'encryption-unavailable' ||
      error.code === 'operation-in-progress' ||
      error.code === 'invalid-request'
    ) {
      return new GmailError(error.code);
    }
    return new GmailError('internal');
  }
  if (error instanceof PersistenceError) {
    if (error.code === 'encryption-unavailable') return new GmailError('encryption-unavailable');
    if (error.code === 'decrypt-failed' || error.code === 'not-found') {
      return new GmailError('needs-reauth');
    }
  }
  return new GmailError('internal');
}

const snippetNamedReferences = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00A0']
]);

function clip(value: string, maxLength: number): string | null {
  let text = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) continue;
    text += character;
    if (text.length === maxLength) break;
  }
  return text.length === 0 ? null : text;
}

function isAsciiLetter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function snippetDigit(character: string, hex: boolean): number | null {
  const code = character.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (!hex) return null;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return null;
}

function isDisallowedSnippetCode(code: number): boolean {
  return code <= 31 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
}

function readNamedSnippetReference(
  value: string,
  start: number
): { text: string; consumed: number } | null {
  const limit = Math.min(value.length, start + 6);
  for (let end = start + 1; end < limit; end += 1) {
    const character = value[end];
    if (character === ';') {
      const text = snippetNamedReferences.get(value.slice(start + 1, end));
      return text === undefined ? null : { text, consumed: end - start + 1 };
    }
    if (character === undefined || !isAsciiLetter(character)) return null;
  }
  return null;
}

function readNumericSnippetReference(
  value: string,
  start: number
): { text: string; consumed: number } | null {
  let index = start + 2;
  let hex = false;
  if (value[index] === 'x' || value[index] === 'X') {
    hex = true;
    index += 1;
  }
  const base = hex ? 16 : 10;
  let code = 0;
  let digits = 0;
  while (index < value.length) {
    const digit = snippetDigit(value[index] ?? '', hex);
    if (digit === null) break;
    const next = code * base + digit;
    if (next > 0x10ffff) return null;
    code = next;
    digits += 1;
    index += 1;
  }
  if (digits === 0 || value[index] !== ';' || isDisallowedSnippetCode(code)) return null;
  return { text: String.fromCodePoint(code), consumed: index - start + 1 };
}

function readSnippetReference(
  value: string,
  start: number
): { text: string; consumed: number } | null {
  if (value[start + 1] === '#') return readNumericSnippetReference(value, start);
  return readNamedSnippetReference(value, start);
}

function decodeSnippetReferences(value: string): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '&') {
      parts.push(value[index] ?? '');
      continue;
    }
    const reference = readSnippetReference(value, index);
    if (reference === null) {
      parts.push('&');
      continue;
    }
    parts.push(reference.text);
    index += reference.consumed - 1;
  }
  return parts.join('');
}

function headerValue(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return '';
  for (const header of headers) {
    if (!isRecord(header) || typeof header.name !== 'string' || typeof header.value !== 'string') {
      continue;
    }
    if (header.name.toLowerCase() === name) return header.value;
  }
  return '';
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

function requireQuery(value: string | null): string | null {
  if (value === null) return null;
  if (value.length < 1 || value.length > 512) throw new GmailError('invalid-request');
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) throw new GmailError('invalid-request');
  }
  return value;
}

function requirePageToken(value: string | null): string | null {
  if (value === null) return null;
  if (!isGmailPageToken(value)) throw new GmailError('invalid-request');
  return value;
}

function labelName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return clip(value, 256) ?? fallback;
}

function unreadCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    return null;
  }
  return value;
}

function visibleLabels(payload: unknown): GmailLabel[] {
  if (!isRecord(payload) || !Array.isArray(payload.labels)) throw new GmailError('unavailable');
  const system = new Map<string, GmailLabel>();
  const users: GmailLabel[] = [];
  for (const label of payload.labels) {
    if (!isRecord(label) || !isGmailId(label.id)) continue;
    if (label.type !== 'system' && label.type !== 'user') continue;
    const item: GmailLabel = {
      id: label.id,
      name: labelName(label.name, label.id),
      type: label.type,
      unreadCount: unreadCount(label.messagesUnread)
    };
    if (label.type === 'user') users.push(item);
    else if (visibleSystemLabels.includes(label.id)) system.set(label.id, item);
  }
  users.sort((left, right) => left.name.localeCompare(right.name));
  return [
    ...visibleSystemLabels.flatMap((id) => {
      const label = system.get(id);
      return label === undefined ? [] : [label];
    }),
    ...users
  ];
}

function summaryOf(
  fallbackSnippet: unknown,
  metadata: unknown,
  fallbackId: string
): GmailThreadSummary {
  if (!isRecord(metadata)) throw new GmailError('unavailable');
  const messages = Array.isArray(metadata.messages) ? metadata.messages.filter(isRecord) : [];
  const ordered = [...messages].sort(
    (left, right) => stamp(left.internalDate) - stamp(right.internalDate)
  );
  const oldest = ordered[0];
  const newest = ordered[ordered.length - 1];
  const oldestHeaders =
    oldest !== undefined && isRecord(oldest.payload) ? oldest.payload.headers : [];
  const newestHeaders =
    newest !== undefined && isRecord(newest.payload) ? newest.payload.headers : [];
  const snippet =
    typeof metadata.snippet === 'string'
      ? metadata.snippet
      : typeof fallbackSnippet === 'string'
        ? fallbackSnippet
        : '';
  const id = isGmailId(metadata.id) ? metadata.id : fallbackId;
  return {
    id,
    subject: oldest === undefined ? null : clip(headerValue(oldestHeaders, 'subject'), 998),
    from: newest === undefined ? null : clip(headerValue(newestHeaders, 'from'), 2000),
    date: newest === undefined ? null : isoDate(newest.internalDate),
    snippet: clip(decodeSnippetReferences(snippet), 500),
    unread: messages.some(
      (message) => Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD')
    ),
    starred: messages.some(
      (message) => Array.isArray(message.labelIds) && message.labelIds.includes('STARRED')
    )
  };
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return results;
}

interface GmailRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string;
  mutation?: boolean;
  delivery?: 'send' | 'save' | 'create';
}

const readRequest: GmailRequest = { method: 'GET' };

export function createGmailReader(deps: GmailReaderDependencies): GmailReader {
  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const busyThreads = new Set<string>();
  const busyBulk = new Set<string>();
  const busySends = new Set<string>();

  async function gmailJson(
    token: string,
    url: string,
    request: GmailRequest,
    attempt: number
  ): Promise<unknown> {
    let response: Response;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json'
    };
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    try {
      response = await deps.fetchImpl(url, {
        method: request.method,
        headers,
        body: request.body,
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      if (request.delivery !== undefined) throw lostDelivery(request.delivery, null);
      throw new GmailError('network');
    }
    let bytes: Uint8Array;
    try {
      bytes = await readLimitedBody(response);
    } catch (error) {
      if (error instanceof GmailError && error.code === 'too-large') throw error;
      if (request.delivery !== undefined) throw lostDelivery(request.delivery, response.status);
      throw error;
    }
    let payload: unknown = null;
    if (bytes.byteLength > 0) {
      try {
        payload = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      } catch {
        if (request.delivery !== undefined) throw lostDelivery(request.delivery, response.status);
        if (response.ok) throw new GmailError('unavailable', response.status);
        payload = null;
      }
    }
    if (response.ok) {
      if (request.delivery === 'send') return acceptedSend(payload, response.status);
      if (request.method === 'DELETE' && payload === null) return {};
      if (payload === null) throw new GmailError('unavailable', response.status);
      return payload;
    }
    const failure = classifyGmailFailure(response.status, payload);
    if (request.delivery !== undefined)
      throw deliveryFailure(request.delivery, response.status, failure);
    const retry =
      attempt === 0 &&
      (response.status === 500 || response.status === 503 || failure.code === 'rate-limited');
    if (retry) {
      if (failure.code === 'rate-limited') {
        await sleep(retryDelay(response.headers.get('retry-after')));
      }
      return gmailJson(token, url, request, 1);
    }
    if (response.status !== 401) recordGmailFailure(response.status, failure.reason);
    throw new GmailError(
      mutationCode(request, response.status, failure),
      response.status,
      failure.reason
    );
  }

  async function authed(
    accountId: string,
    url: string,
    request: GmailRequest,
    retried = false
  ): Promise<unknown> {
    const token = await deps.accounts.mailboxAccess(accountId, retried);
    try {
      return await gmailJson(token, url, request, 0);
    } catch (error) {
      if (error instanceof GmailError && error.status === 401 && !retried) {
        deps.accounts.forgetMailboxAccess(accountId);
        return authed(accountId, url, request, true);
      }
      if (error instanceof GmailError && error.status === 401) {
        deps.accounts.forgetMailboxAccess(accountId);
        recordGmailFailure(401, error.reason);
        throw new GmailError('gmail-rejected', 401, error.reason);
      }
      throw error;
    }
  }

  async function withRead<T>(accountId: string, run: () => Promise<T>): Promise<T> {
    deps.accounts.beginMailboxRead();
    try {
      return await run();
    } catch (error) {
      throw asGmail(error);
    } finally {
      deps.accounts.endMailboxRead();
    }
  }

  function guard(value: unknown, maxBytes: number): void {
    if (utf8Size(value) > maxBytes) throw new GmailError('too-large');
  }

  async function loadLabels(accountId: string): Promise<GmailLabel[]> {
    const payload = await authed(accountId, `${gmailRoot}/labels`, readRequest);
    const labels = visibleLabels(payload);
    const value = { labels };
    guard(value, listPayloadLimit);
    return labels;
  }

  const bulk = createBulkActions({
    authed: (accountId, url, request) => authed(accountId, url, request),
    withRead,
    requireGrant,
    reserveThread: reserve,
    threadBusy: (accountId, threadId) => busyThreads.has(`${accountId}\n${threadId}`),
    bulkBusy: (accountId) => busyBulk.has(accountId),
    reserveBulk: (accountId) => {
      busyBulk.add(accountId);
      return () => {
        busyBulk.delete(accountId);
      };
    },
    normalizeError: asGmail
  });

  const drafts = createDraftActions({
    authed,
    requireGrant,
    senderIdentity,
    withRead,
    busySends,
    loadSource: loadComposeSource,
    pickFiles: deps.pickFiles,
    chooseSavePath: deps.chooseSavePath,
    writeSave: deps.writeSave
  });

  return {
    async listLabels(accountId) {
      if (!isGoogleAccountId(accountId)) throw new GmailError('invalid-request');
      return withRead(accountId, async () => ({ labels: await loadLabels(accountId) }));
    },
    async listThreads(input) {
      if (!isGoogleAccountId(input.accountId)) throw new GmailError('invalid-request');
      const query = requireQuery(input.query);
      const pageToken = requirePageToken(input.pageToken);
      if (input.labelId !== null && !isGmailId(input.labelId))
        throw new GmailError('invalid-request');
      if (query === null && input.labelId === null) throw new GmailError('invalid-request');
      return withRead(input.accountId, async () => {
        if (input.labelId !== null) {
          const labels = await loadLabels(input.accountId);
          if (!labels.some((label) => label.id === input.labelId)) {
            throw new GmailError('invalid-request');
          }
        }
        const url = new URL(`${gmailRoot}/threads`);
        url.searchParams.set('maxResults', '20');
        if (query === null && input.labelId !== null)
          url.searchParams.set('labelIds', input.labelId);
        if (query !== null) url.searchParams.set('q', query);
        if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
        if (query !== null || input.labelId === 'SPAM' || input.labelId === 'TRASH') {
          url.searchParams.set('includeSpamTrash', 'true');
        }
        const payload = await authed(input.accountId, url.href, readRequest);
        if (!isRecord(payload)) throw new GmailError('unavailable');
        const listed = Array.isArray(payload.threads) ? payload.threads : [];
        if (listed.length > 20) throw new GmailError('unavailable');
        const rows = await mapLimit(listed, 4, async (thread) => {
          if (!isRecord(thread) || !isGmailId(thread.id)) throw new GmailError('unavailable');
          const metadataUrl = new URL(`${gmailRoot}/threads/${thread.id}`);
          metadataUrl.searchParams.set('format', 'metadata');
          for (const header of metadataHeaders)
            metadataUrl.searchParams.append('metadataHeaders', header);
          const metadata = await authed(input.accountId, metadataUrl.href, readRequest);
          return summaryOf(thread.snippet, metadata, thread.id);
        });
        const nextPageToken =
          payload.nextPageToken === undefined || payload.nextPageToken === null
            ? null
            : payload.nextPageToken;
        if (nextPageToken !== null && !isGmailPageToken(nextPageToken)) {
          throw new GmailError('unavailable');
        }
        const value = { threads: rows, nextPageToken };
        guard(value, listPayloadLimit);
        return value;
      });
    },
    async readThread(accountId, threadId) {
      if (!isGoogleAccountId(accountId) || !isGmailId(threadId)) {
        throw new GmailError('invalid-request');
      }
      return withRead(accountId, async () => {
        const url = new URL(`${gmailRoot}/threads/${threadId}`);
        url.searchParams.set('format', 'full');
        const payload = await authed(accountId, url.href, readRequest);
        if (!isRecord(payload) || !Array.isArray(payload.messages)) {
          throw new GmailError('unavailable');
        }
        const messages = decodeConversation(threadId, payload.messages);
        const value = { id: threadId, messages };
        guard(value, threadPayloadLimit);
        return value;
      });
    },
    async openLink(url) {
      const href = acceptExternalUrl(url);
      if (href === null) throw new GmailError('invalid-request');
      try {
        await deps.openExternal(href);
      } catch {
        throw new GmailError('internal');
      }
      return { opened: true };
    },
    markRead(accountId, threadId) {
      return changeThread(accountId, threadId, { removeLabelIds: ['UNREAD'] }, false);
    },
    markUnread(accountId, threadId) {
      return changeThread(accountId, threadId, { addLabelIds: ['UNREAD'] }, true);
    },
    archiveThread(accountId, threadId) {
      return moveThread(accountId, threadId, { removeLabelIds: ['INBOX'] });
    },
    trashThread(accountId, threadId) {
      return relocateThread(accountId, threadId, 'trash');
    },
    untrashThread(accountId, threadId) {
      return relocateThread(accountId, threadId, 'untrash');
    },
    addLabel(accountId, threadId, labelId) {
      return changeUserLabel(accountId, threadId, labelId, true);
    },
    removeLabel(accountId, threadId, labelId) {
      return changeUserLabel(accountId, threadId, labelId, false);
    },
    starMessage(accountId, threadId, messageId) {
      return changeStar(accountId, threadId, messageId, true);
    },
    unstarMessage(accountId, threadId, messageId) {
      return changeStar(accountId, threadId, messageId, false);
    },
    composeSeed(query) {
      return loadComposeSeed(query);
    },
    sendMessage(message) {
      return deliverMessage(message);
    },
    saveDraft(request) {
      return drafts.saveDraft(request);
    },
    openDraft(request) {
      return drafts.openDraft(request);
    },
    deleteDraft(request) {
      return drafts.deleteDraft(request);
    },
    sendDraft(request) {
      return drafts.sendDraft(request);
    },
    pickAttachments(request) {
      return drafts.pickAttachments(request);
    },
    dropAttachment(request) {
      return drafts.dropAttachment(request);
    },
    downloadAttachment(request) {
      return drafts.downloadAttachment(request);
    },
    bulkThreads(request) {
      return bulk.bulkThreads(request);
    },
    bulkLabel(request) {
      return bulk.bulkLabel(request);
    },
    createLabel(request) {
      return bulk.createLabel(request);
    },
    renameLabel(request) {
      return bulk.renameLabel(request);
    },
    deleteLabel(request) {
      return bulk.deleteLabel(request);
    }
  };

  function reserve(accountId: string, threadId: string): () => void {
    const key = `${accountId}\n${threadId}`;
    if (busyThreads.has(key)) throw new GmailError('operation-in-progress');
    busyThreads.add(key);
    return () => {
      busyThreads.delete(key);
    };
  }

  async function mutate<T>(accountId: string, threadId: string, run: () => Promise<T>): Promise<T> {
    if (!isGoogleAccountId(accountId) || !isGmailId(threadId)) {
      throw new GmailError('invalid-request');
    }
    const release = reserve(accountId, threadId);
    try {
      return await withRead(accountId, async () => {
        const grant = deps.accounts.modificationGrant(accountId);
        if (grant === 'needs-reauth') throw new GmailError('needs-reauth');
        if (grant !== 'ready') throw new GmailError('insufficient-scope');
        return run();
      });
    } finally {
      release();
    }
  }

  async function post(accountId: string, url: string, body: Record<string, string[]> | null) {
    return authed(
      accountId,
      url,
      body === null
        ? { method: 'POST', mutation: true }
        : { method: 'POST', mutation: true, body: JSON.stringify(body) }
    );
  }

  function accepted(payload: unknown, id: string): void {
    if (!isRecord(payload) || payload.id !== id) throw new GmailError('invalid-response');
  }

  async function changeThread(
    accountId: string,
    threadId: string,
    body: Record<string, string[]>,
    unread: boolean
  ): Promise<{ threadId: string; unread: boolean }> {
    return mutate(accountId, threadId, async () => {
      const payload = await post(accountId, `${gmailRoot}/threads/${threadId}/modify`, body);
      accepted(payload, threadId);
      return { threadId, unread };
    });
  }

  async function moveThread(
    accountId: string,
    threadId: string,
    body: Record<string, string[]>
  ): Promise<{ threadId: string }> {
    return mutate(accountId, threadId, async () => {
      const payload = await post(accountId, `${gmailRoot}/threads/${threadId}/modify`, body);
      accepted(payload, threadId);
      return { threadId };
    });
  }

  async function relocateThread(
    accountId: string,
    threadId: string,
    action: 'trash' | 'untrash'
  ): Promise<{ threadId: string }> {
    return mutate(accountId, threadId, async () => {
      const payload = await post(accountId, `${gmailRoot}/threads/${threadId}/${action}`, null);
      accepted(payload, threadId);
      return { threadId };
    });
  }

  async function changeUserLabel(
    accountId: string,
    threadId: string,
    labelId: string,
    add: boolean
  ): Promise<{ threadId: string; labelId: string }> {
    if (!isGmailId(labelId)) throw new GmailError('invalid-request');
    return mutate(accountId, threadId, async () => {
      const labels = await loadLabels(accountId);
      if (!labels.some((label) => label.id === labelId && label.type === 'user')) {
        throw new GmailError('invalid-request');
      }
      const body: Record<string, string[]> = add
        ? { addLabelIds: [labelId] }
        : { removeLabelIds: [labelId] };
      const payload = await post(accountId, `${gmailRoot}/threads/${threadId}/modify`, body);
      accepted(payload, threadId);
      return { threadId, labelId };
    });
  }

  async function changeStar(
    accountId: string,
    threadId: string,
    messageId: string,
    starred: boolean
  ): Promise<{ threadId: string; messageId: string; starred: boolean }> {
    if (!isGmailId(messageId)) throw new GmailError('invalid-request');
    return mutate(accountId, threadId, async () => {
      const body: Record<string, string[]> = starred
        ? { addLabelIds: ['STARRED'] }
        : { removeLabelIds: ['STARRED'] };
      const payload = await post(accountId, `${gmailRoot}/messages/${messageId}/modify`, body);
      accepted(payload, messageId);
      return { threadId, messageId, starred };
    });
  }

  function requireGrant(accountId: string): void {
    const grant = deps.accounts.modificationGrant(accountId);
    if (grant === 'needs-reauth') throw new GmailError('needs-reauth');
    if (grant !== 'ready') throw new GmailError('insufficient-scope');
  }

  function senderIdentity(accountId: string): { email: string; displayName: string | null } {
    const account = deps.accounts.listAccounts().find((item) => item.id === accountId);
    if (account === undefined || account.status !== 'connected')
      throw new GmailError('needs-reauth');
    if (account.email === null || !isMailboxAddress(account.email))
      throw new GmailError('invalid-request');
    return { email: account.email, displayName: account.displayName };
  }

  async function loadComposeSource(
    accountId: string,
    threadId: string,
    messageId: string
  ): Promise<{
    threadId: string;
    subject: string;
    from: string[];
    to: string[];
    cc: string[];
    replyTo: string[];
    messageIdHeader: string | null;
    references: string[];
  }> {
    const url = new URL(`${gmailRoot}/messages/${messageId}`);
    url.searchParams.set('format', 'metadata');
    for (const header of composeHeaders) url.searchParams.append('metadataHeaders', header);
    const payload = await authed(accountId, url.href, readRequest);
    if (!isRecord(payload) || payload.threadId !== threadId)
      throw new GmailError('invalid-request');
    const headers = headerMap(isRecord(payload.payload) ? payload.payload.headers : undefined);
    const parent = messageIdsFromHeader(headers.get('message-id') ?? '');
    return {
      threadId,
      subject: headers.get('subject') ?? '',
      from: mailboxesFromHeader(headers.get('from') ?? ''),
      to: mailboxesFromHeader(headers.get('to') ?? ''),
      cc: mailboxesFromHeader(headers.get('cc') ?? ''),
      replyTo: mailboxesFromHeader(headers.get('reply-to') ?? ''),
      messageIdHeader: parent[0] ?? null,
      references: messageIdsFromHeader(headers.get('references') ?? '')
    };
  }

  async function loadComposeSeed(query: ComposeSeedQuery): Promise<ComposeSeed> {
    if (
      !isGoogleAccountId(query.accountId) ||
      !isGmailId(query.threadId) ||
      !isGmailId(query.messageId)
    ) {
      throw new GmailError('invalid-request');
    }
    return withRead(query.accountId, async () => {
      requireGrant(query.accountId);
      const identity = senderIdentity(query.accountId);
      const source = await loadComposeSource(query.accountId, query.threadId, query.messageId);
      const subject =
        query.kind === 'forward' ? forwardSubject(source.subject) : replySubject(source.subject);
      if (subject === null) throw new GmailError('invalid-request');
      if (query.kind !== 'forward' && source.messageIdHeader === null) {
        throw new GmailError('invalid-request');
      }
      const recipients = seedRecipients({
        kind: query.kind,
        from: source.from,
        to: source.to,
        cc: source.cc,
        replyTo: source.replyTo,
        selfAddress: identity.email
      });
      return { to: recipients.to, cc: recipients.cc, subject };
    });
  }

  async function deliverMessage(message: ComposeMessage): Promise<ComposeSent> {
    if (!isGoogleAccountId(message.accountId)) throw new GmailError('invalid-request');
    if (busySends.has(message.accountId)) throw new GmailError('operation-in-progress');
    busySends.add(message.accountId);
    try {
      return await withRead(message.accountId, async () => {
        requireGrant(message.accountId);
        const identity = senderIdentity(message.accountId);
        const recipients = collectRecipients(message.to, message.cc, message.bcc);
        if (recipients === null) throw new GmailError('invalid-request');
        let subject = message.subject;
        let inReplyTo: string | null = null;
        let references: string[] = [];
        let threadId: string | null = null;
        if (message.kind === 'reply' || message.kind === 'reply-all') {
          if (!isGmailId(message.threadId) || !isGmailId(message.messageId)) {
            throw new GmailError('invalid-request');
          }
          const source = await loadComposeSource(
            message.accountId,
            message.threadId,
            message.messageId
          );
          const expected = replySubject(source.subject);
          if (
            expected === null ||
            message.subject !== expected ||
            source.messageIdHeader === null
          ) {
            throw new GmailError('invalid-request');
          }
          subject = expected;
          inReplyTo = source.messageIdHeader;
          references = trimReferences(source.references, source.messageIdHeader);
          threadId = message.threadId;
        } else if (message.threadId !== null || message.messageId !== null) {
          throw new GmailError('invalid-request');
        }
        if (hasHeaderBreak(subject)) throw new GmailError('invalid-request');
        const raw = buildOutgoingRaw({
          fromName: identity.displayName,
          fromEmail: identity.email,
          recipients,
          subject,
          body: message.body,
          inReplyTo,
          references,
          now: new Date()
        });
        const requestBody: { raw: string; threadId?: string } = { raw };
        if (threadId !== null) requestBody.threadId = threadId;
        const payload = await authed(message.accountId, `${gmailRoot}/messages/send`, {
          method: 'POST',
          body: JSON.stringify(requestBody),
          delivery: 'send'
        });
        if (!isRecord(payload) || !isGmailId(payload.id)) throw new GmailError('send-unconfirmed');
        if (
          payload.threadId !== undefined &&
          payload.threadId !== null &&
          !isGmailId(payload.threadId)
        ) {
          throw new GmailError('send-unconfirmed');
        }
        return {
          id: payload.id,
          threadId: isGmailId(payload.threadId) ? payload.threadId : null
        };
      });
    } finally {
      busySends.delete(message.accountId);
    }
  }
}

function headerMap(value: unknown): Map<string, string> {
  const headers = new Map<string, string>();
  if (!Array.isArray(value)) return headers;
  for (const header of value) {
    if (!isRecord(header) || typeof header.name !== 'string' || typeof header.value !== 'string') {
      continue;
    }
    headers.set(header.name.toLowerCase(), header.value);
  }
  return headers;
}

function acceptedSend(payload: unknown, status: number): unknown {
  if (!isRecord(payload) || !isGmailId(payload.id))
    throw new GmailError('send-unconfirmed', status);
  if (payload.threadId !== undefined && payload.threadId !== null && !isGmailId(payload.threadId)) {
    throw new GmailError('send-unconfirmed', status);
  }
  return payload;
}

function lostDelivery(delivery: 'send' | 'save' | 'create', status: number | null): GmailError {
  if (delivery === 'send') return new GmailError('send-unconfirmed', status);
  return new GmailError('save-unconfirmed', status);
}

function deliveryFailure(
  delivery: 'send' | 'save' | 'create',
  status: number,
  failure: { code: GmailError['code']; reason: string | null }
): GmailError {
  const lost = delivery === 'send' ? 'send-unconfirmed' : 'save-unconfirmed';
  if (status === 401) return new GmailError('gmail-rejected', 401, failure.reason);
  if (status === 429 || status === 500 || status === 503 || failure.code === 'rate-limited') {
    recordGmailFailure(status, failure.reason);
    return new GmailError(lost, status, failure.reason);
  }
  if (status === 404) {
    recordGmailFailure(status, failure.reason);
    return new GmailError('not-found', status, failure.reason);
  }
  if (
    status === 403 &&
    (failure.reason === 'insufficientPermissions' ||
      failure.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')
  ) {
    recordGmailFailure(status, failure.reason);
    return new GmailError('insufficient-scope', status, failure.reason);
  }
  if (status === 403) {
    recordGmailFailure(status, failure.reason);
    return new GmailError('permission-denied', status, failure.reason);
  }
  recordGmailFailure(status, failure.reason);
  if (status >= 500) return new GmailError(lost, status, failure.reason);
  if (status === 400) return new GmailError('gmail-rejected', status, failure.reason);
  return new GmailError('gmail-rejected', status, failure.reason);
}

function mutationCode(
  request: GmailRequest,
  status: number,
  failure: { code: GmailError['code']; reason: string | null }
): GmailError['code'] {
  if (request.mutation !== true) return failure.code;
  if (status === 400) return 'gmail-rejected';
  if (
    status === 403 &&
    (failure.reason === 'insufficientPermissions' ||
      failure.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')
  ) {
    return 'insufficient-scope';
  }
  return failure.code;
}
