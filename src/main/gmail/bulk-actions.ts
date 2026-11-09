import { isGoogleAccountId } from '../../shared/google-accounts.ts';
import {
  gmailErrorCodes,
  isGmailId,
  type GmailBulkAction,
  type GmailBulkLabelRequest,
  type GmailBulkResult,
  type GmailBulkThreadsRequest,
  type GmailErrorCode,
  type GmailLabelDefinition,
  type GmailLabelDeleteRequest,
  type GmailLabelDeleted,
  type GmailLabelNameRequest,
  type GmailLabelRenameRequest
} from '../../shared/gmail.ts';
import { GmailError } from './errors.ts';

const gmailRoot = 'https://gmail.googleapis.com/gmail/v1/users/me';
const bulkLimit = 4;
const unstarLimit = 50;
const metadataLimit = 1000;

interface MailRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string;
  mutation?: boolean;
}

interface ListedLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
}

interface MetaMessage {
  id: string;
  internalDate: number;
  labelIds: string[];
}

type ItemState =
  | { kind: 'pending' }
  | { kind: 'succeeded' }
  | { kind: 'unconfirmed' }
  | { kind: 'failed'; code: GmailErrorCode }
  | { kind: 'not-attempted' };

const stopCodes = new Set<GmailErrorCode>([
  'needs-reauth',
  'insufficient-scope',
  'encryption-unavailable',
  'rate-limited'
]);

export interface BulkDependencies {
  authed: (accountId: string, url: string, request: MailRequest) => Promise<unknown>;
  withRead: <T>(accountId: string, run: () => Promise<T>) => Promise<T>;
  requireGrant: (accountId: string) => void;
  reserveThread: (accountId: string, threadId: string) => () => void;
  threadBusy: (accountId: string, threadId: string) => boolean;
  bulkBusy: (accountId: string) => boolean;
  reserveBulk: (accountId: string) => () => void;
  normalizeError: (error: unknown) => GmailError;
}

export interface BulkActions {
  bulkThreads(request: GmailBulkThreadsRequest): Promise<GmailBulkResult>;
  bulkLabel(request: GmailBulkLabelRequest): Promise<GmailBulkResult>;
  createLabel(request: GmailLabelNameRequest): Promise<GmailLabelDefinition>;
  renameLabel(request: GmailLabelRenameRequest): Promise<GmailLabelDefinition>;
  deleteLabel(request: GmailLabelDeleteRequest): Promise<GmailLabelDeleted>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,13}$/.test(value)) return -1;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function errorCode(error: GmailError): GmailErrorCode {
  return gmailErrorCodes.find((code) => code === error.code) ?? 'internal';
}

function requireThreads(accountId: string, threadIds: readonly string[]): string[] {
  if (!isGoogleAccountId(accountId)) throw new GmailError('invalid-request');
  if (threadIds.length < 1 || threadIds.length > 20) throw new GmailError('invalid-request');
  const seen = new Set<string>();
  for (const threadId of threadIds) {
    if (!isGmailId(threadId) || seen.has(threadId)) throw new GmailError('invalid-request');
    seen.add(threadId);
  }
  return [...threadIds];
}

function checkedName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 225) throw new GmailError('invalid-request');
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127 || character === '/') throw new GmailError('invalid-request');
  }
  return trimmed;
}

function pack(threadIds: readonly string[], states: Map<string, ItemState>): GmailBulkResult {
  const succeeded: string[] = [];
  const failed: GmailBulkResult['failed'] = [];
  const unconfirmed: string[] = [];
  const notAttempted: string[] = [];
  for (const threadId of threadIds) {
    const state = states.get(threadId) ?? { kind: 'not-attempted' as const };
    if (state.kind === 'succeeded') succeeded.push(threadId);
    else if (state.kind === 'unconfirmed') unconfirmed.push(threadId);
    else if (state.kind === 'failed') failed.push({ threadId, code: state.code });
    else notAttempted.push(threadId);
  }
  return { succeeded, failed, unconfirmed, notAttempted };
}

export function createBulkActions(deps: BulkDependencies): BulkActions {
  function hold(accountId: string, threadIds: readonly string[]): () => void {
    if (deps.bulkBusy(accountId)) throw new GmailError('operation-in-progress');
    for (const threadId of threadIds) {
      if (deps.threadBusy(accountId, threadId)) throw new GmailError('operation-in-progress');
    }
    const releaseBulk = deps.reserveBulk(accountId);
    const releases: (() => void)[] = [];
    try {
      for (const threadId of threadIds) releases.push(deps.reserveThread(accountId, threadId));
    } catch (error) {
      for (const release of releases) release();
      releaseBulk();
      throw error;
    }
    return () => {
      for (const release of releases) release();
      releaseBulk();
    };
  }

  async function settle(
    accountId: string,
    threadIds: readonly string[],
    run: (threadId: string) => Promise<void>,
    prepare?: () => Promise<void>
  ): Promise<GmailBulkResult> {
    const release = hold(accountId, threadIds);
    try {
      return await deps.withRead(accountId, async () => {
        deps.requireGrant(accountId);
        if (prepare !== undefined) await prepare();
        const states = new Map<string, ItemState>(
          threadIds.map((threadId) => [threadId, { kind: 'pending' }])
        );
        let cursor = 0;
        let stop = false;
        const worker = async (): Promise<void> => {
          for (;;) {
            if (stop) return;
            const index = cursor;
            cursor += 1;
            if (index >= threadIds.length) return;
            const threadId = threadIds[index];
            if (threadId === undefined) return;
            try {
              await run(threadId);
              states.set(threadId, { kind: 'succeeded' });
            } catch (caught) {
              const error = deps.normalizeError(caught);
              if (error.code === 'network') {
                states.set(threadId, { kind: 'unconfirmed' });
                continue;
              }
              const code = errorCode(error);
              states.set(threadId, { kind: 'failed', code });
              if (stopCodes.has(code)) stop = true;
            }
          }
        };
        const workers = Array.from({ length: Math.min(bulkLimit, threadIds.length) }, () =>
          worker()
        );
        await Promise.all(workers);
        for (const threadId of threadIds) {
          if (states.get(threadId)?.kind === 'pending') {
            states.set(threadId, { kind: 'not-attempted' });
          }
        }
        return pack(threadIds, states);
      });
    } finally {
      release();
    }
  }

  async function post(
    accountId: string,
    url: string,
    body: Record<string, string[]> | null
  ): Promise<unknown> {
    return deps.authed(
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

  async function modifyThread(
    accountId: string,
    threadId: string,
    body: Record<string, string[]>
  ): Promise<void> {
    const payload = await post(accountId, `${gmailRoot}/threads/${threadId}/modify`, body);
    accepted(payload, threadId);
  }

  async function metadata(accountId: string, threadId: string): Promise<MetaMessage[]> {
    const url = new URL(`${gmailRoot}/threads/${threadId}`);
    url.searchParams.set('format', 'metadata');
    const payload = await deps.authed(accountId, url.href, { method: 'GET' });
    if (!isRecord(payload) || payload.id !== threadId || !Array.isArray(payload.messages)) {
      throw new GmailError('unavailable');
    }
    if (payload.messages.length > metadataLimit) throw new GmailError('too-large');
    const messages: MetaMessage[] = [];
    for (const message of payload.messages) {
      if (!isRecord(message) || !isGmailId(message.id)) throw new GmailError('unavailable');
      const labelIds = Array.isArray(message.labelIds)
        ? message.labelIds.filter((labelId): labelId is string => typeof labelId === 'string')
        : [];
      messages.push({ id: message.id, internalDate: stamp(message.internalDate), labelIds });
    }
    if (messages.length === 0) throw new GmailError('not-found');
    return messages;
  }

  function newest(messages: readonly MetaMessage[]): MetaMessage {
    return messages.reduce((best, message) => {
      if (message.internalDate > best.internalDate) return message;
      if (message.internalDate === best.internalDate && message.id > best.id) return message;
      return best;
    });
  }

  async function modifyMessage(
    accountId: string,
    messageId: string,
    body: Record<string, string[]>
  ): Promise<void> {
    const payload = await post(accountId, `${gmailRoot}/messages/${messageId}/modify`, body);
    accepted(payload, messageId);
  }

  async function starThread(accountId: string, threadId: string): Promise<void> {
    const messages = await metadata(accountId, threadId);
    const message = newest(messages);
    await modifyMessage(accountId, message.id, { addLabelIds: ['STARRED'] });
  }

  async function unstarThread(accountId: string, threadId: string): Promise<void> {
    const messages = await metadata(accountId, threadId);
    const starred = messages
      .filter((message) => message.labelIds.includes('STARRED'))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const limited = starred.slice(0, unstarLimit);
    for (const message of limited) {
      await modifyMessage(accountId, message.id, { removeLabelIds: ['STARRED'] });
    }
    if (starred.length > unstarLimit) throw new GmailError('too-large');
  }

  async function applyAction(
    accountId: string,
    threadId: string,
    action: GmailBulkAction
  ): Promise<void> {
    if (action === 'read') {
      await modifyThread(accountId, threadId, { removeLabelIds: ['UNREAD'] });
      return;
    }
    if (action === 'unread') {
      await modifyThread(accountId, threadId, { addLabelIds: ['UNREAD'] });
      return;
    }
    if (action === 'archive') {
      await modifyThread(accountId, threadId, { removeLabelIds: ['INBOX'] });
      return;
    }
    if (action === 'trash') {
      const payload = await post(accountId, `${gmailRoot}/threads/${threadId}/trash`, null);
      accepted(payload, threadId);
      return;
    }
    if (action === 'untrash') {
      const payload = await post(accountId, `${gmailRoot}/threads/${threadId}/untrash`, null);
      accepted(payload, threadId);
      return;
    }
    if (action === 'star') {
      await starThread(accountId, threadId);
      return;
    }
    await unstarThread(accountId, threadId);
  }

  async function allLabels(accountId: string): Promise<ListedLabel[]> {
    const payload = await deps.authed(accountId, `${gmailRoot}/labels`, { method: 'GET' });
    if (!isRecord(payload) || !Array.isArray(payload.labels)) throw new GmailError('unavailable');
    const labels: ListedLabel[] = [];
    for (const label of payload.labels) {
      if (!isRecord(label) || !isGmailId(label.id)) continue;
      if (label.type !== 'system' && label.type !== 'user') continue;
      if (typeof label.name !== 'string' || label.name.length < 1 || label.name.length > 256) {
        continue;
      }
      labels.push({ id: label.id, name: label.name, type: label.type });
    }
    return labels;
  }

  function requireUser(labels: readonly ListedLabel[], labelId: string): ListedLabel {
    const label = labels.find((item) => item.id === labelId);
    if (label === undefined) throw new GmailError('not-found');
    if (label.type !== 'user') throw new GmailError('invalid-request');
    return label;
  }

  function rejectTakenName(
    labels: readonly ListedLabel[],
    name: string,
    ignoreId: string | null
  ): void {
    if (labels.some((label) => label.type === 'system' && label.name === name)) {
      throw new GmailError('invalid-request');
    }
    if (labels.some((label) => label.name === name && label.id !== ignoreId)) {
      throw new GmailError('label-exists');
    }
  }

  async function sendLabel(
    accountId: string,
    url: string,
    method: 'POST' | 'PUT',
    name: string
  ): Promise<unknown> {
    try {
      return await deps.authed(accountId, url, {
        method,
        mutation: true,
        body: JSON.stringify({
          name,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show'
        })
      });
    } catch (caught) {
      const error = deps.normalizeError(caught);
      if (error.status === 409) throw new GmailError('label-exists', 409);
      throw error;
    }
  }

  async function storedUser(
    accountId: string,
    id: string,
    name: string
  ): Promise<GmailLabelDefinition> {
    const fresh = await allLabels(accountId);
    const found = fresh.find(
      (label) => label.id === id && label.type === 'user' && label.name === name
    );
    if (found === undefined) throw new GmailError('invalid-response');
    return { id: found.id, name: found.name };
  }

  return {
    async bulkThreads(request) {
      const threadIds = requireThreads(request.accountId, request.threadIds);
      return settle(request.accountId, threadIds, (threadId) =>
        applyAction(request.accountId, threadId, request.action)
      );
    },
    async bulkLabel(request) {
      const threadIds = requireThreads(request.accountId, request.threadIds);
      if (!isGmailId(request.labelId)) throw new GmailError('invalid-request');
      return settle(
        request.accountId,
        threadIds,
        (threadId) => {
          const body: Record<string, string[]> = {};
          if (request.mode === 'add') body.addLabelIds = [request.labelId];
          else body.removeLabelIds = [request.labelId];
          return modifyThread(request.accountId, threadId, body);
        },
        async () => {
          const labels = await allLabels(request.accountId);
          requireUser(labels, request.labelId);
        }
      );
    },
    async createLabel(request) {
      if (!isGoogleAccountId(request.accountId)) throw new GmailError('invalid-request');
      const name = checkedName(request.name);
      return deps.withRead(request.accountId, async () => {
        deps.requireGrant(request.accountId);
        const labels = await allLabels(request.accountId);
        rejectTakenName(labels, name, null);
        const payload = await sendLabel(request.accountId, `${gmailRoot}/labels`, 'POST', name);
        if (!isRecord(payload) || !isGmailId(payload.id) || payload.type !== 'user') {
          throw new GmailError('invalid-response');
        }
        return storedUser(request.accountId, payload.id, name);
      });
    },
    async renameLabel(request) {
      if (!isGoogleAccountId(request.accountId) || !isGmailId(request.labelId)) {
        throw new GmailError('invalid-request');
      }
      const name = checkedName(request.name);
      return deps.withRead(request.accountId, async () => {
        deps.requireGrant(request.accountId);
        const labels = await allLabels(request.accountId);
        const current = requireUser(labels, request.labelId);
        if (current.name === name) throw new GmailError('invalid-request');
        rejectTakenName(labels, name, request.labelId);
        const payload = await sendLabel(
          request.accountId,
          `${gmailRoot}/labels/${request.labelId}`,
          'PUT',
          name
        );
        if (!isRecord(payload) || payload.id !== request.labelId) {
          throw new GmailError('invalid-response');
        }
        return storedUser(request.accountId, request.labelId, name);
      });
    },
    async deleteLabel(request) {
      if (!isGoogleAccountId(request.accountId) || !isGmailId(request.labelId)) {
        throw new GmailError('invalid-request');
      }
      return deps.withRead(request.accountId, async () => {
        deps.requireGrant(request.accountId);
        const labels = await allLabels(request.accountId);
        requireUser(labels, request.labelId);
        await deps.authed(request.accountId, `${gmailRoot}/labels/${request.labelId}`, {
          method: 'DELETE',
          mutation: true
        });
        return { id: request.labelId };
      });
    }
  };
}
