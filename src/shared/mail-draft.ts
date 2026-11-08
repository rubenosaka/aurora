import { isGmailId } from './gmail.ts';
import { isGoogleAccountId } from './google-accounts.ts';
import {
  collectRecipients,
  composeSubjectLimit,
  hasHeaderBreak,
  isComposeBody,
  type ComposeSendKind
} from './mail-compose.ts';

export const attachmentCountLimit = 10;
export const attachmentByteLimit = 5 * 1024 * 1024;
export const composerGenerationLimit = 1_000_000_000;

const sendKinds: readonly ComposeSendKind[] = ['new', 'reply', 'reply-all', 'forward'];
const tokenPattern = /^[A-Za-z0-9]{32}$/;

export interface DraftAttachmentRef {
  token: string;
  fileName: string;
  mediaType: string;
  size: number;
}

export interface DraftSaveRequest {
  accountId: string;
  draftId: string | null;
  expectedMessageId: string | null;
  kind: ComposeSendKind;
  threadId: string | null;
  messageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachmentTokens: string[];
  replaceConfirmed: boolean;
  composerGeneration: number;
}

export interface DraftSaved {
  draftId: string;
  messageId: string;
  threadId: string | null;
}

export interface DraftOpenRequest {
  accountId: string;
  threadId: string;
  messageId: string;
  composerGeneration: number;
}

export interface DraftOpened {
  locked: boolean;
  draftId: string;
  messageId: string;
  threadId: string | null;
  kind: ComposeSendKind;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  subjectLocked: boolean;
  attachments: DraftAttachmentRef[];
}

export interface DraftDeleteRequest {
  accountId: string;
  draftId: string;
  expectedMessageId: string;
}

export interface DraftDeleted {
  deleted: true;
}

export interface AttachmentPickRequest {
  accountId: string;
  composerGeneration: number;
}

export interface AttachmentDropRequest {
  accountId: string;
  composerGeneration: number;
  token: string;
}

export interface AttachmentDownloadRequest {
  accountId: string;
  messageId: string;
  partId: string | null;
  attachmentId: string | null;
}

export interface AttachmentSaved {
  saved: boolean;
}

export interface AttachmentDropped {
  dropped: true;
}

export interface PickedAttachments {
  attachments: DraftAttachmentRef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isSendKind(value: unknown): value is ComposeSendKind {
  return sendKinds.some((kind) => kind === value);
}

function generationOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > composerGenerationLimit) return null;
  return value;
}

function optionalId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (isGmailId(value)) return value;
  return undefined;
}

function addressList(value: unknown, allowEmpty: boolean): string[] | null {
  if (!Array.isArray(value)) return null;
  const addresses = value.filter((item): item is string => typeof item === 'string');
  if (addresses.length !== value.length) return null;
  const collected = collectRecipients(addresses, [], [], allowEmpty);
  if (collected === null) return null;
  return collected.to;
}

function fieldList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const addresses = value.filter((item): item is string => typeof item === 'string');
  if (addresses.length !== value.length) return null;
  return addresses;
}

function tokensOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > attachmentCountLimit) return null;
  const tokens: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !tokenPattern.test(item) || tokens.includes(item)) return null;
    tokens.push(item);
  }
  return tokens;
}

function subjectOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > composeSubjectLimit + 5 || hasHeaderBreak(value)) return null;
  return value;
}

export function sanitizeFileName(value: string): string {
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

export function isAttachmentToken(value: unknown): value is string {
  return typeof value === 'string' && tokenPattern.test(value);
}

export function parseDraftAttachment(value: unknown): DraftAttachmentRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['token', 'fileName', 'mediaType', 'size']) ||
    !isAttachmentToken(value.token) ||
    typeof value.fileName !== 'string' ||
    typeof value.mediaType !== 'string' ||
    typeof value.size !== 'number'
  ) {
    return null;
  }
  if (
    value.fileName.length === 0 ||
    value.fileName.length > 200 ||
    hasHeaderBreak(value.fileName)
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value.mediaType)) return null;
  if (!Number.isInteger(value.size) || value.size < 0 || value.size > attachmentByteLimit)
    return null;
  return {
    token: value.token,
    fileName: value.fileName,
    mediaType: value.mediaType,
    size: value.size
  };
}

export function parseDraftSave(value: unknown): DraftSaveRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'accountId',
      'draftId',
      'expectedMessageId',
      'kind',
      'threadId',
      'messageId',
      'to',
      'cc',
      'bcc',
      'subject',
      'body',
      'attachmentTokens',
      'replaceConfirmed',
      'composerGeneration'
    ]) ||
    !isGoogleAccountId(value.accountId) ||
    !isSendKind(value.kind) ||
    typeof value.replaceConfirmed !== 'boolean'
  ) {
    return null;
  }
  const draftId = optionalId(value.draftId);
  const expectedMessageId = optionalId(value.expectedMessageId);
  const generation = generationOf(value.composerGeneration);
  const to = fieldList(value.to);
  const cc = fieldList(value.cc);
  const bcc = fieldList(value.bcc);
  const subject = subjectOf(value.subject);
  const attachmentTokens = tokensOf(value.attachmentTokens);
  if (
    draftId === undefined ||
    expectedMessageId === undefined ||
    generation === null ||
    to === null ||
    cc === null ||
    bcc === null ||
    subject === null ||
    attachmentTokens === null
  ) {
    return null;
  }
  if (typeof value.body !== 'string' || !isComposeBody(value.body)) return null;
  const recipients = collectRecipients(to, cc, bcc, true);
  if (recipients === null) return null;
  const threaded = value.kind === 'reply' || value.kind === 'reply-all';
  const threadId = optionalId(value.threadId);
  const messageId = optionalId(value.messageId);
  if (threadId === undefined || messageId === undefined) return null;
  if (threaded) {
    if (threadId === null || messageId === null) return null;
  } else if (threadId !== null || messageId !== null) return null;
  if ((draftId === null) !== (expectedMessageId === null)) return null;
  return {
    accountId: value.accountId,
    draftId,
    expectedMessageId,
    kind: value.kind,
    threadId,
    messageId,
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    subject,
    body: value.body,
    attachmentTokens,
    replaceConfirmed: value.replaceConfirmed,
    composerGeneration: generation
  };
}

export function parseDraftSaved(value: unknown): DraftSaved | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['draftId', 'messageId', 'threadId']) ||
    !isGmailId(value.draftId) ||
    !isGmailId(value.messageId)
  ) {
    return null;
  }
  const threadId = optionalId(value.threadId);
  if (threadId === undefined) return null;
  return { draftId: value.draftId, messageId: value.messageId, threadId };
}

export function parseDraftOpen(value: unknown): DraftOpenRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['accountId', 'threadId', 'messageId', 'composerGeneration']) ||
    !isGoogleAccountId(value.accountId) ||
    !isGmailId(value.threadId) ||
    !isGmailId(value.messageId)
  ) {
    return null;
  }
  const composerGeneration = generationOf(value.composerGeneration);
  if (composerGeneration === null) return null;
  return {
    accountId: value.accountId,
    threadId: value.threadId,
    messageId: value.messageId,
    composerGeneration
  };
}

export function parseDraftOpened(value: unknown): DraftOpened | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'locked',
      'draftId',
      'messageId',
      'threadId',
      'kind',
      'to',
      'cc',
      'bcc',
      'subject',
      'body',
      'subjectLocked',
      'attachments'
    ]) ||
    typeof value.locked !== 'boolean' ||
    !isGmailId(value.draftId) ||
    !isGmailId(value.messageId) ||
    !isSendKind(value.kind) ||
    typeof value.subjectLocked !== 'boolean' ||
    typeof value.body !== 'string' ||
    !Array.isArray(value.attachments)
  ) {
    return null;
  }
  const threadId = optionalId(value.threadId);
  const subject = subjectOf(value.subject);
  const to = addressList(value.to, true);
  const cc = addressList(value.cc, true);
  const bcc = addressList(value.bcc, true);
  if (threadId === undefined || subject === null || to === null || cc === null || bcc === null) {
    return null;
  }
  if (!isComposeBody(value.body)) return null;
  const attachments: DraftAttachmentRef[] = [];
  for (const item of value.attachments) {
    const attachment = parseDraftAttachment(item);
    if (attachment === null) return null;
    attachments.push(attachment);
  }
  return {
    locked: value.locked,
    draftId: value.draftId,
    messageId: value.messageId,
    threadId,
    kind: value.kind,
    to,
    cc,
    bcc,
    subject,
    body: value.body,
    subjectLocked: value.subjectLocked,
    attachments
  };
}

export function parseDraftDelete(value: unknown): DraftDeleteRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['accountId', 'draftId', 'expectedMessageId']) ||
    !isGoogleAccountId(value.accountId) ||
    !isGmailId(value.draftId) ||
    !isGmailId(value.expectedMessageId)
  ) {
    return null;
  }
  return {
    accountId: value.accountId,
    draftId: value.draftId,
    expectedMessageId: value.expectedMessageId
  };
}

export function parseDraftDeleted(value: unknown): DraftDeleted | null {
  if (!isRecord(value) || !hasExactKeys(value, ['deleted']) || value.deleted !== true) return null;
  return { deleted: true };
}

export function parseAttachmentPick(value: unknown): AttachmentPickRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['accountId', 'composerGeneration']) ||
    !isGoogleAccountId(value.accountId)
  ) {
    return null;
  }
  const composerGeneration = generationOf(value.composerGeneration);
  if (composerGeneration === null) return null;
  return { accountId: value.accountId, composerGeneration };
}

export function parsePickedAttachments(value: unknown): PickedAttachments | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['attachments']) ||
    !Array.isArray(value.attachments)
  ) {
    return null;
  }
  const attachments: DraftAttachmentRef[] = [];
  for (const item of value.attachments) {
    const attachment = parseDraftAttachment(item);
    if (attachment === null) return null;
    attachments.push(attachment);
  }
  return { attachments };
}

export function parseAttachmentDrop(value: unknown): AttachmentDropRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['accountId', 'composerGeneration', 'token']) ||
    !isGoogleAccountId(value.accountId) ||
    !isAttachmentToken(value.token)
  ) {
    return null;
  }
  const composerGeneration = generationOf(value.composerGeneration);
  if (composerGeneration === null) return null;
  return { accountId: value.accountId, composerGeneration, token: value.token };
}

export function parseAttachmentDownload(value: unknown): AttachmentDownloadRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['accountId', 'messageId', 'partId', 'attachmentId']) ||
    !isGoogleAccountId(value.accountId) ||
    !isGmailId(value.messageId)
  ) {
    return null;
  }
  const partId =
    value.partId === null
      ? null
      : typeof value.partId === 'string' && /^[0-9.]{1,32}$/.test(value.partId)
        ? value.partId
        : undefined;
  const attachmentId =
    value.attachmentId === null
      ? null
      : typeof value.attachmentId === 'string' && /^[A-Za-z0-9_-]{1,2000}$/.test(value.attachmentId)
        ? value.attachmentId
        : undefined;
  if (partId === undefined || attachmentId === undefined) return null;
  if (partId === null && attachmentId === null) return null;
  return { accountId: value.accountId, messageId: value.messageId, partId, attachmentId };
}

export function parseAttachmentSaved(value: unknown): AttachmentSaved | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['saved']) ||
    (value.saved !== true && value.saved !== false)
  ) {
    return null;
  }
  return { saved: value.saved };
}

export function parseAttachmentDropped(value: unknown): AttachmentDropped | null {
  if (!isRecord(value) || !hasExactKeys(value, ['dropped']) || value.dropped !== true) return null;
  return { dropped: true };
}
