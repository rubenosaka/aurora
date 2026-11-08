import { randomBytes } from 'node:crypto';
import { isGmailId, isGmailPageToken } from '../../shared/gmail.ts';
import {
  attachmentByteLimit,
  attachmentCountLimit,
  sanitizeFileName,
  type AttachmentDownloadRequest,
  type AttachmentDropRequest,
  type AttachmentPickRequest,
  type DraftDeleteRequest,
  type DraftDeleted,
  type DraftOpenRequest,
  type DraftOpened,
  type DraftSaveRequest,
  type DraftSaved,
  type PickedAttachments
} from '../../shared/mail-draft.ts';
import {
  hasHeaderBreak,
  mailboxesFromHeader,
  messageIdsFromHeader,
  replySubject,
  trimReferences
} from '../../shared/mail-compose.ts';
import { buildOutgoingRaw, type OutgoingFile } from './compose-mime.ts';
import { saveDestination, writeDownload } from './download-file.ts';
import { GmailError } from './errors.ts';

const gmailRoot = 'https://gmail.googleapis.com/gmail/v1/users/me';

const extensionTypes: Record<string, string> = {
  txt: 'text/plain',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  csv: 'text/csv',
  json: 'application/json'
};

interface DraftHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string;
  delivery?: 'send' | 'save' | 'create';
  mutation?: boolean;
}

interface HeldFile {
  accountId: string;
  generation: number;
  token: string;
  fileName: string;
  mediaType: string;
  bytes: Buffer;
}

interface RemoteIdentity {
  draftId: string;
  messageId: string;
  threadId: string | null;
  historyId: string | null;
}

interface StoredReply {
  accountId: string;
  generation: number;
  threadId: string;
  inReplyTo: string;
  references: string[];
  subject: string;
}

interface KnownDraft {
  messageId: string;
  historyId: string | null;
}

export interface DraftSource {
  subject: string;
  messageIdHeader: string | null;
  references: string[];
}

export interface DraftActionDependencies {
  authed: (accountId: string, url: string, request: DraftHttpRequest) => Promise<unknown>;
  requireGrant: (accountId: string) => void;
  senderIdentity: (accountId: string) => { email: string; displayName: string | null };
  withRead: <T>(accountId: string, run: () => Promise<T>) => Promise<T>;
  busySends: Set<string>;
  loadSource: (accountId: string, threadId: string, messageId: string) => Promise<DraftSource>;
  pickFiles?: () => Promise<Array<{ name: string; bytes: Uint8Array }>>;
  chooseSavePath?: (fileName: string) => Promise<string | null>;
  writeSave?: (target: string, bytes: Uint8Array) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function newToken(): string {
  return randomBytes(24)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, 'A')
    .slice(0, 32)
    .padEnd(32, 'A');
}

function mediaOf(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return extensionTypes[extension] ?? 'application/octet-stream';
}

function historyOf(value: unknown): string | null {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null;
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

export function createDraftActions(deps: DraftActionDependencies) {
  const files: HeldFile[] = [];
  const replies: StoredReply[] = [];
  const known = new Map<string, KnownDraft>();
  const messageDrafts = new Map<string, string>();
  const busyDrafts = new Set<string>();

  function key(accountId: string, draftId: string): string {
    return `${accountId}\n${draftId}`;
  }

  function held(accountId: string, generation: number): HeldFile[] {
    return files.filter((file) => file.accountId === accountId && file.generation === generation);
  }

  function remember(accountId: string, identity: RemoteIdentity): void {
    known.set(key(accountId, identity.draftId), {
      messageId: identity.messageId,
      historyId: identity.historyId
    });
    for (const [storedKey, draftId] of messageDrafts) {
      if (draftId === identity.draftId && storedKey.startsWith(`${accountId}\n`)) {
        messageDrafts.delete(storedKey);
      }
    }
    messageDrafts.set(key(accountId, identity.messageId), identity.draftId);
  }

  function forget(accountId: string, draftId: string): void {
    known.delete(key(accountId, draftId));
    for (const [storedKey, storedId] of messageDrafts) {
      if (storedId === draftId && storedKey.startsWith(`${accountId}\n`)) {
        messageDrafts.delete(storedKey);
      }
    }
  }

  function identityOf(payload: unknown, expectedDraftId: string | null): RemoteIdentity {
    if (!isRecord(payload) || !isGmailId(payload.id)) throw new GmailError('save-unconfirmed');
    if (expectedDraftId !== null && payload.id !== expectedDraftId) {
      throw new GmailError('save-unconfirmed');
    }
    if (!isRecord(payload.message) || !isGmailId(payload.message.id)) {
      throw new GmailError('save-unconfirmed');
    }
    const threadId = payload.message.threadId;
    if (threadId !== undefined && threadId !== null && !isGmailId(threadId)) {
      throw new GmailError('save-unconfirmed');
    }
    return {
      draftId: payload.id,
      messageId: payload.message.id,
      threadId: isGmailId(threadId) ? threadId : null,
      historyId: historyOf(payload.message.historyId)
    };
  }

  function changed(accountId: string, remote: RemoteIdentity, expectedMessageId: string): boolean {
    if (remote.messageId !== expectedMessageId) return true;
    const stored = known.get(key(accountId, remote.draftId));
    return (
      stored?.historyId !== null &&
      stored?.historyId !== undefined &&
      remote.historyId !== null &&
      stored.historyId !== remote.historyId
    );
  }

  async function readIdentity(accountId: string, draftId: string): Promise<RemoteIdentity> {
    const url = new URL(`${gmailRoot}/drafts/${draftId}`);
    url.searchParams.set('format', 'minimal');
    const payload = await deps.authed(accountId, url.href, { method: 'GET' });
    const identity = identityOf(payload, draftId);
    return identity;
  }

  async function findDraftId(accountId: string, messageId: string): Promise<string> {
    const cached = messageDrafts.get(key(accountId, messageId));
    if (cached !== undefined) return cached;
    let pageToken: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url = new URL(`${gmailRoot}/drafts`);
      url.searchParams.set('maxResults', '100');
      if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
      const payload = await deps.authed(accountId, url.href, { method: 'GET' });
      if (!isRecord(payload)) throw new GmailError('unavailable');
      const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
      for (const draft of drafts) {
        if (!isRecord(draft) || !isGmailId(draft.id) || !isRecord(draft.message)) continue;
        if (draft.message.id === messageId) return draft.id;
      }
      if (typeof payload.nextPageToken !== 'string' || !isGmailPageToken(payload.nextPageToken)) {
        break;
      }
      pageToken = payload.nextPageToken;
    }
    throw new GmailError('not-found');
  }

  function plainText(data: string): string {
    const bytes = Buffer.from(data, 'base64url');
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  function walkDraft(
    part: unknown,
    depth: number,
    found: {
      locked: boolean;
      text: string[];
      files: Array<{
        fileName: string;
        mediaType: string;
        partId: string | null;
        attachmentId: string | null;
        data: string | null;
        size: number;
      }>;
    }
  ): void {
    if (depth > 8 || !isRecord(part)) return;
    const mime = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    const headers = headerMap(part.headers);
    const disposition = (headers.get('content-disposition') ?? '').toLowerCase();
    const contentType = (headers.get('content-type') ?? '').toLowerCase();
    if (mime.startsWith('text/html') || contentType.includes('text/html')) found.locked = true;
    if (
      (mime.startsWith('image/') && headers.has('content-id')) ||
      (mime.startsWith('image/') && disposition.startsWith('inline'))
    ) {
      found.locked = true;
    }
    const filename =
      typeof part.filename === 'string' && part.filename.trim().length > 0 ? part.filename : null;
    const attachment = filename !== null || disposition.includes('attachment');
    if (attachment && !mime.startsWith('multipart/')) {
      const body = isRecord(part.body) ? part.body : null;
      const attachmentId =
        body && typeof body.attachmentId === 'string' && isGmailId(body.attachmentId)
          ? body.attachmentId
          : body &&
              typeof body.attachmentId === 'string' &&
              /^[A-Za-z0-9_-]{1,2000}$/.test(body.attachmentId)
            ? body.attachmentId
            : null;
      const partId =
        typeof part.partId === 'string' && /^[0-9.]{1,32}$/.test(part.partId) ? part.partId : null;
      const size =
        body && typeof body.size === 'number' && Number.isInteger(body.size) ? body.size : 0;
      const data = body && typeof body.data === 'string' ? body.data : null;
      found.files.push({
        fileName: sanitizeFileName(filename ?? 'Attachment'),
        mediaType: mediaOf(filename ?? ''),
        partId,
        attachmentId,
        data,
        size
      });
    }
    if (
      mime === 'text/plain' &&
      !attachment &&
      isRecord(part.body) &&
      typeof part.body.data === 'string'
    ) {
      found.text.push(plainText(part.body.data));
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) walkDraft(child, depth + 1, found);
    }
  }

  async function bytesFor(
    accountId: string,
    messageId: string,
    file: { attachmentId: string | null; data: string | null; size: number }
  ): Promise<Buffer> {
    if (file.size > attachmentByteLimit) throw new GmailError('too-large');
    if (file.data !== null) {
      const bytes = Buffer.from(file.data, 'base64url');
      if (bytes.byteLength > attachmentByteLimit) throw new GmailError('too-large');
      if (file.size > 0 && bytes.byteLength !== file.size) throw new GmailError('unavailable');
      return bytes;
    }
    if (file.attachmentId === null) throw new GmailError('unavailable');
    const payload = await deps.authed(
      accountId,
      `${gmailRoot}/messages/${messageId}/attachments/${file.attachmentId}`,
      { method: 'GET' }
    );
    if (!isRecord(payload) || typeof payload.data !== 'string') throw new GmailError('unavailable');
    const bytes = Buffer.from(payload.data, 'base64url');
    if (bytes.byteLength > attachmentByteLimit) throw new GmailError('too-large');
    if (file.size > 0 && bytes.byteLength !== file.size) throw new GmailError('unavailable');
    return bytes;
  }

  function filesFor(request: DraftSaveRequest): OutgoingFile[] {
    const selected: OutgoingFile[] = [];
    let total = 0;
    for (const token of request.attachmentTokens) {
      const file = files.find(
        (item) =>
          item.token === token &&
          item.accountId === request.accountId &&
          item.generation === request.composerGeneration
      );
      if (file === undefined) throw new GmailError('invalid-request');
      total += file.bytes.byteLength;
      if (selected.length >= attachmentCountLimit || total > attachmentByteLimit) {
        throw new GmailError('too-large');
      }
      selected.push({ fileName: file.fileName, mediaType: file.mediaType, bytes: file.bytes });
    }
    return selected;
  }

  async function mimeFor(
    request: DraftSaveRequest
  ): Promise<{ raw: string; threadId: string | null }> {
    const identity = deps.senderIdentity(request.accountId);
    let subject = request.subject;
    let inReplyTo: string | null = null;
    let references: string[] = [];
    let threadId: string | null = null;
    if (request.kind === 'reply' || request.kind === 'reply-all') {
      const stored = replies.find(
        (item) =>
          item.accountId === request.accountId && item.generation === request.composerGeneration
      );
      if (stored !== undefined) {
        if (request.threadId !== stored.threadId || request.subject !== stored.subject) {
          throw new GmailError('invalid-request');
        }
        subject = stored.subject;
        inReplyTo = stored.inReplyTo;
        references = stored.references;
        threadId = stored.threadId;
      } else {
        if (request.threadId === null || request.messageId === null) {
          throw new GmailError('invalid-request');
        }
        const source = await deps.loadSource(
          request.accountId,
          request.threadId,
          request.messageId
        );
        const expected = replySubject(source.subject);
        if (expected === null || request.subject !== expected || source.messageIdHeader === null) {
          throw new GmailError('invalid-request');
        }
        subject = expected;
        inReplyTo = source.messageIdHeader;
        references = trimReferences(source.references, source.messageIdHeader);
        threadId = request.threadId;
      }
    }
    if (hasHeaderBreak(subject)) throw new GmailError('invalid-request');
    const raw = buildOutgoingRaw({
      fromName: identity.displayName,
      fromEmail: identity.email,
      recipients: { to: request.to, cc: request.cc, bcc: request.bcc },
      subject,
      body: request.body,
      inReplyTo,
      references,
      now: new Date(),
      files: filesFor(request)
    });
    return { raw, threadId };
  }

  function messageBody(raw: string, threadId: string | null, draftId: string | null): string {
    const message: { raw: string; threadId?: string } = { raw };
    if (threadId !== null) message.threadId = threadId;
    return JSON.stringify(draftId === null ? { message } : { id: draftId, message });
  }

  async function guardRemote(request: DraftSaveRequest): Promise<void> {
    if (request.draftId === null || request.expectedMessageId === null) return;
    const remote = await readIdentity(request.accountId, request.draftId);
    if (!changed(request.accountId, remote, request.expectedMessageId)) return;
    if (!request.replaceConfirmed) throw new GmailError('draft-conflict');
  }

  return {
    async saveDraft(request: DraftSaveRequest): Promise<DraftSaved> {
      if (busySendsHas(deps, request.accountId) || busyDrafts.has(request.accountId)) {
        throw new GmailError('operation-in-progress');
      }
      busyDrafts.add(request.accountId);
      try {
        return await deps.withRead(request.accountId, async () => {
          deps.requireGrant(request.accountId);
          const built = await mimeFor(request);
          if (request.draftId === null) {
            const payload = await deps.authed(request.accountId, `${gmailRoot}/drafts`, {
              method: 'POST',
              body: messageBody(built.raw, built.threadId, null),
              delivery: 'create'
            });
            const identity = identityOf(payload, null);
            remember(request.accountId, identity);
            return {
              draftId: identity.draftId,
              messageId: identity.messageId,
              threadId: identity.threadId
            };
          }
          await guardRemote(request);
          const payload = await deps.authed(
            request.accountId,
            `${gmailRoot}/drafts/${request.draftId}`,
            {
              method: 'PUT',
              body: messageBody(built.raw, built.threadId, request.draftId),
              delivery: 'save'
            }
          );
          const identity = identityOf(payload, request.draftId);
          remember(request.accountId, identity);
          return {
            draftId: identity.draftId,
            messageId: identity.messageId,
            threadId: identity.threadId
          };
        });
      } finally {
        busyDrafts.delete(request.accountId);
      }
    },
    async openDraft(request: DraftOpenRequest): Promise<DraftOpened> {
      return deps.withRead(request.accountId, async () => {
        deps.requireGrant(request.accountId);
        const draftId = await findDraftId(request.accountId, request.messageId);
        const url = new URL(`${gmailRoot}/drafts/${draftId}`);
        url.searchParams.set('format', 'full');
        const payload = await deps.authed(request.accountId, url.href, { method: 'GET' });
        const identity = identityOf(payload, draftId);
        if (!isRecord(payload) || !isRecord(payload.message)) throw new GmailError('unavailable');
        const message = payload.message;
        if (!isRecord(message.payload)) throw new GmailError('unavailable');
        const mime = message.payload;
        if (identity.threadId !== request.threadId) throw new GmailError('invalid-request');
        const headers = headerMap(mime.headers);
        const found = {
          locked: false,
          text: [] as string[],
          files: [] as Array<{
            fileName: string;
            mediaType: string;
            partId: string | null;
            attachmentId: string | null;
            data: string | null;
            size: number;
          }>
        };
        walkDraft(mime, 1, found);
        const subject = headers.get('subject') ?? '';
        if (hasHeaderBreak(subject) || subject.length > 998)
          throw new GmailError('invalid-request');
        const body = found.text.join('\n');
        const parent = messageIdsFromHeader(headers.get('in-reply-to') ?? '')[0] ?? null;
        const references = messageIdsFromHeader(headers.get('references') ?? '');
        const reply = parent !== null && identity.threadId !== null;
        if (reply && identity.threadId !== null) {
          const replySubjectText = replySubject(subject) ?? subject;
          replies.push({
            accountId: request.accountId,
            generation: request.composerGeneration,
            threadId: identity.threadId,
            inReplyTo: parent,
            references: trimReferences(references, parent),
            subject: replySubjectText
          });
        }
        remember(request.accountId, identity);
        if (found.locked) {
          return {
            locked: true,
            draftId,
            messageId: identity.messageId,
            threadId: reply ? identity.threadId : null,
            kind: reply ? 'reply' : 'new',
            to: mailboxesFromHeader(headers.get('to') ?? ''),
            cc: mailboxesFromHeader(headers.get('cc') ?? ''),
            bcc: mailboxesFromHeader(headers.get('bcc') ?? ''),
            subject,
            body,
            subjectLocked: reply,
            attachments: []
          };
        }
        let total = 0;
        const attachments = [];
        for (const file of found.files) {
          const bytes = await bytesFor(request.accountId, identity.messageId, file);
          total += bytes.byteLength;
          if (attachments.length >= attachmentCountLimit || total > attachmentByteLimit) {
            throw new GmailError('too-large');
          }
          const token = newToken();
          files.push({
            accountId: request.accountId,
            generation: request.composerGeneration,
            token,
            fileName: file.fileName,
            mediaType: file.mediaType,
            bytes
          });
          attachments.push({
            token,
            fileName: file.fileName,
            mediaType: file.mediaType,
            size: bytes.byteLength
          });
        }
        return {
          locked: false,
          draftId,
          messageId: identity.messageId,
          threadId: reply ? identity.threadId : null,
          kind: reply ? 'reply' : 'new',
          to: mailboxesFromHeader(headers.get('to') ?? ''),
          cc: mailboxesFromHeader(headers.get('cc') ?? ''),
          bcc: mailboxesFromHeader(headers.get('bcc') ?? ''),
          subject: reply ? (replySubject(subject) ?? subject) : subject,
          body,
          subjectLocked: reply,
          attachments
        };
      });
    },
    async deleteDraft(request: DraftDeleteRequest): Promise<DraftDeleted> {
      return deps.withRead(request.accountId, async () => {
        deps.requireGrant(request.accountId);
        const remote = await readIdentity(request.accountId, request.draftId);
        if (changed(request.accountId, remote, request.expectedMessageId)) {
          throw new GmailError('draft-conflict');
        }
        try {
          await deps.authed(request.accountId, `${gmailRoot}/drafts/${request.draftId}`, {
            method: 'DELETE',
            mutation: true
          });
        } catch (error) {
          if (!(error instanceof GmailError) || error.code !== 'not-found') throw error;
        }
        forget(request.accountId, request.draftId);
        return { deleted: true };
      });
    },
    async sendDraft(request: DraftSaveRequest): Promise<{ id: string; threadId: string | null }> {
      const draftId = request.draftId;
      if (draftId === null || request.expectedMessageId === null) {
        throw new GmailError('invalid-request');
      }
      if (deps.busySends.has(request.accountId) || busyDrafts.has(request.accountId)) {
        throw new GmailError('operation-in-progress');
      }
      deps.busySends.add(request.accountId);
      try {
        return await deps.withRead(request.accountId, async () => {
          deps.requireGrant(request.accountId);
          await guardRemote(request);
          const built = await mimeFor(request);
          const payload = await deps.authed(request.accountId, `${gmailRoot}/drafts/send`, {
            method: 'POST',
            body: messageBody(built.raw, built.threadId, request.draftId),
            delivery: 'send'
          });
          if (!isRecord(payload) || !isGmailId(payload.id))
            throw new GmailError('send-unconfirmed');
          const threadId = isGmailId(payload.threadId) ? payload.threadId : null;
          forget(request.accountId, draftId);
          dropGeneration(files, request.accountId, request.composerGeneration);
          return { id: payload.id, threadId };
        });
      } finally {
        deps.busySends.delete(request.accountId);
      }
    },
    async pickAttachments(request: AttachmentPickRequest): Promise<PickedAttachments> {
      if (deps.pickFiles === undefined) throw new GmailError('unavailable');
      return deps.withRead(request.accountId, async () => {
        deps.requireGrant(request.accountId);
        const chosen = await deps.pickFiles?.();
        if (chosen === undefined || chosen.length === 0) return { attachments: [] };
        const existing = held(request.accountId, request.composerGeneration);
        if (existing.length + chosen.length > attachmentCountLimit)
          throw new GmailError('too-large');
        let total = existing.reduce((sum, file) => sum + file.bytes.byteLength, 0);
        const prepared: HeldFile[] = [];
        for (const file of chosen) {
          if (file.bytes.byteLength > attachmentByteLimit) throw new GmailError('too-large');
          total += file.bytes.byteLength;
          if (total > attachmentByteLimit) throw new GmailError('too-large');
          prepared.push({
            accountId: request.accountId,
            generation: request.composerGeneration,
            token: newToken(),
            fileName: sanitizeFileName(file.name),
            mediaType: mediaOf(file.name),
            bytes: Buffer.from(file.bytes)
          });
        }
        files.push(...prepared);
        return {
          attachments: prepared.map((file) => ({
            token: file.token,
            fileName: file.fileName,
            mediaType: file.mediaType,
            size: file.bytes.byteLength
          }))
        };
      });
    },
    dropAttachment(request: AttachmentDropRequest): Promise<{ dropped: true }> {
      const index = files.findIndex(
        (file) =>
          file.token === request.token &&
          file.accountId === request.accountId &&
          file.generation === request.composerGeneration
      );
      if (index >= 0) files.splice(index, 1);
      return Promise.resolve({ dropped: true });
    },
    async downloadAttachment(request: AttachmentDownloadRequest): Promise<{ saved: boolean }> {
      if (deps.chooseSavePath === undefined) throw new GmailError('unavailable');
      return deps.withRead(request.accountId, async () => {
        const url = new URL(`${gmailRoot}/messages/${request.messageId}`);
        url.searchParams.set('format', 'full');
        const payload = await deps.authed(request.accountId, url.href, { method: 'GET' });
        if (!isRecord(payload) || !isRecord(payload.payload)) throw new GmailError('unavailable');
        const found = {
          locked: false,
          text: [] as string[],
          files: [] as Array<{
            fileName: string;
            mediaType: string;
            partId: string | null;
            attachmentId: string | null;
            data: string | null;
            size: number;
          }>
        };
        walkDraft(payload.payload, 1, found);
        const match = found.files.find((file) => {
          if (request.attachmentId !== null) return file.attachmentId === request.attachmentId;
          return file.partId === request.partId;
        });
        if (match === undefined) throw new GmailError('not-found');
        if (match.size > attachmentByteLimit) throw new GmailError('too-large');
        const bytes = await bytesFor(request.accountId, request.messageId, match);
        const destination = await deps.chooseSavePath?.(sanitizeFileName(match.fileName));
        if (destination === null || destination === undefined) return { saved: false };
        if (saveDestination(destination) === null) throw new GmailError('invalid-request');
        try {
          if (deps.writeSave !== undefined) await deps.writeSave(destination, bytes);
          else await writeDownload(destination, bytes);
        } catch {
          throw new GmailError('unavailable');
        }
        return { saved: true };
      });
    }
  };
}

function busySendsHas(deps: DraftActionDependencies, accountId: string): boolean {
  return deps.busySends.has(accountId);
}

function dropGeneration(files: HeldFile[], accountId: string, generation: number): void {
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const file = files[index];
    if (file !== undefined && file.accountId === accountId && file.generation === generation) {
      files.splice(index, 1);
    }
  }
}
