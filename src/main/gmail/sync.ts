import { type DatabaseSync } from 'node:sqlite';
import {
  gmailNotificationOpenChannel,
  gmailSyncChangedChannel,
  isGmailId,
  isGmailPageToken,
  parseGmailNotificationOpen,
  parseGmailSyncChanged,
  type GmailNotificationPreference,
  type GmailSyncChanged,
  type GmailSyncState,
  type GmailSyncStatus,
  type GmailSyncView
} from '../../shared/gmail.ts';
import { type GoogleAccountSummary } from '../../shared/google-accounts.ts';
import { mailboxesFromHeader } from '../../shared/mail-compose.ts';
import { OAuthFlowError } from '../oauth/errors.ts';
import { withTransaction } from '../persistence/database.ts';
import { PersistenceError } from '../persistence/errors.ts';
import { GmailError } from './errors.ts';
import { type SyncToast } from './notifier.ts';
import { utf8Size } from './mime.ts';

const gmailRoot = 'https://gmail.googleapis.com/gmail/v1/users/me';
const historyPageLimit = 5;
const historyPayloadLimit = 1_000_000;
const metadataPayloadLimit = 65_536;
const toastCap = 3;
const dedupLimit = 1000;
const dedupWindowMs = 14 * 24 * 60 * 60 * 1000;
const focusGapMs = 30_000;
export const syncIntervalMs = 120_000;
const excludedLabels = new Set(['SPAM', 'TRASH', 'DRAFT', 'SENT', 'CHAT']);
const historyIdPattern = /^\d{1,32}$/;
const stampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface SyncScheduler {
  set(delay: number, run: () => void): () => void;
}

export interface MailboxSyncDependencies {
  database: DatabaseSync;
  listAccounts: () => GoogleAccountSummary[];
  read: (accountId: string, url: string) => Promise<unknown>;
  bulkBusy: (accountId: string) => boolean;
  notify: SyncToast;
  emit: (channel: string, payload: unknown) => void;
  now?: () => Date;
  schedule?: SyncScheduler;
}

export interface MailboxSync {
  start(): void;
  shutdown(): void;
  suspend(): void;
  resume(): void;
  focus(accountId: string): void;
  accountConnected(accountId: string): void;
  accountDisconnected(accountId: string): void;
  afterBulk(accountId: string): void;
  status(accountId: string): GmailSyncStatus;
  setPreferences(input: GmailNotificationPreference): GmailSyncStatus;
  reportView(view: GmailSyncView): void;
}

interface HistoryMessage {
  id: string;
  threadId: string;
  labelIds: string[] | null;
}

interface LabelChange {
  message: HistoryMessage;
  labelIds: string[];
}

interface HistoryRecord {
  id: string;
  added: HistoryMessage[];
  deleted: HistoryMessage[];
  labelsAdded: LabelChange[];
  labelsRemoved: LabelChange[];
  uncertain: boolean;
}

interface HistoryPage {
  historyId: string;
  nextPageToken: string | null;
  records: HistoryRecord[];
}

interface Candidate {
  messageId: string;
  threadId: string;
  sender: string;
  subject: string;
}

interface Impact {
  threads: Set<string>;
  labels: Set<string>;
  folderLabels: Set<string>;
  uncertain: boolean;
}

class HistoryExpired extends Error {
  constructor() {
    super('history expired');
    this.name = 'HistoryExpired';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asGmail(error: unknown): GmailError {
  if (error instanceof GmailError) return error;
  if (error instanceof OAuthFlowError) {
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

function scopeFailure(error: GmailError): boolean {
  return (
    error.code === 'insufficient-scope' ||
    (error.code === 'permission-denied' &&
      (error.reason === 'insufficientPermissions' ||
        error.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'))
  );
}

function clip(value: string): string {
  let text = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) continue;
    text += character;
    if (text.length >= 120) break;
  }
  return text.trim();
}

function stampOf(now: Date): string {
  const stamp = now.toISOString();
  if (!stampPattern.test(stamp)) throw new GmailError('internal');
  return stamp;
}

function parseHistoryId(value: unknown): string | null {
  if (typeof value !== 'string' || !historyIdPattern.test(value)) return null;
  return value;
}

function parseLabelList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const labels: string[] = [];
  for (const labelId of value) {
    if (!isGmailId(labelId)) return null;
    labels.push(labelId);
  }
  return labels;
}

function parseHistoryMessage(value: unknown): HistoryMessage | null {
  if (!isRecord(value) || !isGmailId(value.id) || !isGmailId(value.threadId)) return null;
  if (value.labelIds === undefined) {
    return { id: value.id, threadId: value.threadId, labelIds: null };
  }
  const labelIds = parseLabelList(value.labelIds);
  if (labelIds === null) return null;
  return { id: value.id, threadId: value.threadId, labelIds };
}

function parseMessages(value: unknown): HistoryMessage[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) return null;
  const messages: HistoryMessage[] = [];
  for (const item of value) {
    const message = isRecord(item) ? parseHistoryMessage(item.message ?? item) : null;
    if (message === null) return null;
    messages.push(message);
  }
  return messages;
}

function parseChanges(value: unknown): LabelChange[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) return null;
  const changes: LabelChange[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const message = parseHistoryMessage(item.message);
    const labelIds = parseLabelList(item.labelIds);
    if (message === null || labelIds === null) return null;
    changes.push({ message, labelIds });
  }
  return changes;
}

function parseHistoryPage(payload: unknown): HistoryPage {
  if (utf8Size(payload) > historyPayloadLimit) throw new GmailError('too-large');
  if (!isRecord(payload)) throw new GmailError('unavailable');
  const historyId = parseHistoryId(payload.historyId);
  if (historyId === null) throw new GmailError('unavailable');
  const nextPageToken =
    payload.nextPageToken === undefined || payload.nextPageToken === null
      ? null
      : payload.nextPageToken;
  if (nextPageToken !== null && !isGmailPageToken(nextPageToken))
    throw new GmailError('unavailable');
  const history = payload.history === undefined ? [] : payload.history;
  if (!Array.isArray(history) || history.length > 100) throw new GmailError('unavailable');
  const records: HistoryRecord[] = [];
  for (const item of history) {
    if (!isRecord(item)) throw new GmailError('unavailable');
    const id = parseHistoryId(item.id);
    const added = parseMessages(item.messagesAdded);
    const deleted = parseMessages(item.messagesDeleted);
    const labelsAdded = parseChanges(item.labelsAdded);
    const labelsRemoved = parseChanges(item.labelsRemoved);
    if (
      id === null ||
      added === null ||
      deleted === null ||
      labelsAdded === null ||
      labelsRemoved === null
    ) {
      throw new GmailError('unavailable');
    }
    const specific = added.length + deleted.length + labelsAdded.length + labelsRemoved.length;
    const generic = Array.isArray(item.messages) && item.messages.length > 0;
    records.push({
      id,
      added,
      deleted,
      labelsAdded,
      labelsRemoved,
      uncertain: specific === 0 && generic
    });
  }
  return { historyId, nextPageToken, records };
}

function headerValue(payload: unknown, name: string): string | null {
  if (!isRecord(payload) || !isRecord(payload.payload)) return null;
  const headers = payload.payload.headers;
  if (!Array.isArray(headers)) return null;
  for (const header of headers) {
    if (!isRecord(header) || typeof header.name !== 'string' || typeof header.value !== 'string') {
      continue;
    }
    if (header.name.toLowerCase() === name.toLowerCase()) return header.value;
  }
  return null;
}

function inboxArrival(labelIds: readonly string[] | null): boolean | null {
  if (labelIds === null) return null;
  if (!labelIds.includes('INBOX')) return false;
  return !labelIds.some((labelId) => excludedLabels.has(labelId));
}

function sentByOwner(from: string | null, owner: string | null): boolean | null {
  if (owner === null || from === null) return null;
  const mailboxes = mailboxesFromHeader(from);
  if (mailboxes.length === 0) return null;
  const ownerMailbox = owner.toLowerCase();
  return mailboxes.some((mailbox) => mailbox.toLowerCase() === ownerMailbox);
}

function noteMessage(impact: Impact, message: HistoryMessage, labels: readonly string[]): void {
  impact.threads.add(message.threadId);
  for (const labelId of labels) impact.labels.add(labelId);
  if (message.labelIds === null) impact.uncertain = true;
  else for (const labelId of message.labelIds) impact.folderLabels.add(labelId);
}

function absorb(impact: Impact, record: HistoryRecord): void {
  if (record.uncertain) impact.uncertain = true;
  for (const message of record.added) noteMessage(impact, message, message.labelIds ?? []);
  for (const message of record.deleted) noteMessage(impact, message, message.labelIds ?? []);
  for (const change of record.labelsAdded) noteMessage(impact, change.message, change.labelIds);
  for (const change of record.labelsRemoved) noteMessage(impact, change.message, change.labelIds);
}

function pageEventThreadId(view: GmailSyncView, impact: Impact): string | null {
  if (view.threadId !== null && impact.threads.has(view.threadId)) return view.threadId;
  return null;
}

function refreshFor(
  view: GmailSyncView | null,
  accountId: string,
  impact: Impact
): GmailSyncChanged {
  const none: GmailSyncChanged = { accountId, refresh: 'none', threadId: null };
  if (view === null || view.accountId !== accountId) return none;
  const changed = impact.threads.size > 0 || impact.labels.size > 0 || impact.uncertain;
  if (!changed) return none;
  if (impact.uncertain) {
    return view.threadId === null
      ? { accountId, refresh: 'page', threadId: null }
      : { accountId, refresh: 'thread', threadId: view.threadId };
  }
  if (view.threadId !== null && impact.threads.has(view.threadId)) {
    return { accountId, refresh: 'thread', threadId: pageEventThreadId(view, impact) };
  }
  if (view.query !== null && impact.threads.size > 0) {
    return { accountId, refresh: 'page', threadId: pageEventThreadId(view, impact) };
  }
  const folder = view.labelId;
  const folderHit =
    folder !== null && (impact.labels.has(folder) || impact.folderLabels.has(folder));
  if (folderHit) return { accountId, refresh: 'page', threadId: pageEventThreadId(view, impact) };
  if (impact.labels.size > 0 || impact.threads.size > 0) {
    return { accountId, refresh: 'labels', threadId: null };
  }
  return none;
}

export function createMailboxSync(deps: MailboxSyncDependencies): MailboxSync {
  const now = deps.now ?? (() => new Date());
  const schedule = deps.schedule ?? {
    set(delay: number, run: () => void) {
      const handle = setTimeout(run, delay);
      return () => clearTimeout(handle);
    }
  };
  const states = new Map<string, GmailSyncState>();
  const epochs = new Map<string, number>();
  const jobs = new Map<string, Promise<void>>();
  const jobEpoch = new Map<string, number>();
  const pending = new Set<string>();
  const halted = new Set<string>();
  let view: GmailSyncView | null = null;
  let started = false;
  let stopped = false;
  let suspended = false;
  let notificationsBlocked = false;
  let cancelTimer: (() => void) | null = null;
  let sweep: Promise<void> | null = null;

  function account(accountId: string): GoogleAccountSummary | null {
    return deps.listAccounts().find((item) => item.id === accountId) ?? null;
  }

  function requireAccount(accountId: string): GoogleAccountSummary {
    const found = account(accountId);
    if (found === null) throw new GmailError('invalid-request');
    return found;
  }

  function readPrefs(): { notifications: 'on' | 'off'; content: 'show' | 'hide' } {
    const rows = deps.database
      .prepare('SELECT key, value FROM app_settings WHERE key IN (?, ?)')
      .all('gmail.notifications', 'gmail.notification_content') as Array<{
      key: string;
      value: string;
    }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
      notifications: values.get('gmail.notifications') === 'off' ? 'off' : 'on',
      content: values.get('gmail.notification_content') === 'hide' ? 'hide' : 'show'
    };
  }

  function lastSuccessAt(accountId: string): string | null {
    const row = deps.database
      .prepare('SELECT updated_at FROM mailbox_sync WHERE account_id = ?')
      .get(accountId) as { updated_at: string } | undefined;
    if (row === undefined || !stampPattern.test(row.updated_at)) return null;
    return row.updated_at;
  }

  function cursorOf(accountId: string): string | null {
    const row = deps.database
      .prepare('SELECT history_id FROM mailbox_sync WHERE account_id = ?')
      .get(accountId) as { history_id: string } | undefined;
    if (row === undefined) return null;
    return parseHistoryId(row.history_id);
  }

  function known(accountId: string, messageId: string): boolean {
    const row = deps.database
      .prepare('SELECT 1 AS present FROM notified_messages WHERE account_id = ? AND message_id = ?')
      .get(accountId, messageId);
    return row !== undefined;
  }

  function live(accountId: string, epoch: number): boolean {
    return !stopped && epochs.get(accountId) === epoch;
  }

  function persist(
    accountId: string,
    epoch: number,
    historyId: string,
    messageIds: readonly string[]
  ): boolean {
    if (!live(accountId, epoch) || parseHistoryId(historyId) === null) return false;
    const stamp = stampOf(now());
    const cutoff = stampOf(new Date(now().getTime() - dedupWindowMs));
    withTransaction(deps.database, () => {
      const insert = deps.database.prepare(
        `INSERT INTO notified_messages (account_id, message_id, notified_at)
         VALUES (?, ?, ?)
         ON CONFLICT(account_id, message_id) DO NOTHING`
      );
      for (const messageId of messageIds) {
        if (isGmailId(messageId)) insert.run(accountId, messageId, stamp);
      }
      deps.database
        .prepare(
          `INSERT INTO mailbox_sync (account_id, history_id, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             history_id = excluded.history_id,
             updated_at = excluded.updated_at`
        )
        .run(accountId, historyId, stamp);
      deps.database
        .prepare('DELETE FROM notified_messages WHERE account_id = ? AND notified_at < ?')
        .run(accountId, cutoff);
      deps.database
        .prepare(
          `DELETE FROM notified_messages
           WHERE account_id = ?
             AND message_id NOT IN (
               SELECT message_id FROM notified_messages
               WHERE account_id = ?
               ORDER BY notified_at DESC, message_id DESC
               LIMIT ${dedupLimit}
             )`
        )
        .run(accountId, accountId);
    });
    return live(accountId, epoch);
  }

  function publish(changed: GmailSyncChanged): void {
    if (stopped || parseGmailSyncChanged(changed) === null) return;
    deps.emit(gmailSyncChangedChannel, {
      accountId: changed.accountId,
      refresh: changed.refresh,
      threadId: changed.threadId
    });
  }

  function remember(accountId: string, state: GmailSyncState, changed: GmailSyncChanged): void {
    states.set(accountId, state);
    publish(changed);
  }

  async function profile(accountId: string): Promise<string> {
    const payload = await deps.read(accountId, `${gmailRoot}/profile`);
    if (utf8Size(payload) > metadataPayloadLimit || !isRecord(payload)) {
      throw new GmailError('unavailable');
    }
    const historyId = parseHistoryId(payload.historyId);
    if (historyId === null) throw new GmailError('unavailable');
    return historyId;
  }

  async function metadata(
    accountId: string,
    messageId: string
  ): Promise<{ labelIds: string[] | null; from: string | null; subject: string | null } | null> {
    const url = new URL(`${gmailRoot}/messages/${messageId}`);
    url.searchParams.set('format', 'metadata');
    url.searchParams.append('metadataHeaders', 'From');
    url.searchParams.append('metadataHeaders', 'Subject');
    let payload: unknown;
    try {
      payload = await deps.read(accountId, url.href);
    } catch (error) {
      if (error instanceof GmailError && error.code === 'not-found') return null;
      throw error;
    }
    if (
      utf8Size(payload) > metadataPayloadLimit ||
      !isRecord(payload) ||
      payload.id !== messageId
    ) {
      throw new GmailError('unavailable');
    }
    const labelIds = payload.labelIds === undefined ? null : parseLabelList(payload.labelIds);
    if (payload.labelIds !== undefined && labelIds === null) throw new GmailError('unavailable');
    return {
      labelIds,
      from: headerValue(payload, 'From'),
      subject: headerValue(payload, 'Subject')
    };
  }

  async function consider(
    summary: GoogleAccountSummary,
    message: HistoryMessage,
    candidates: Candidate[]
  ): Promise<'skip' | 'offline' | 'hold'> {
    if (known(summary.id, message.id)) return 'skip';
    if (candidates.some((candidate) => candidate.messageId === message.id)) return 'skip';
    const hinted = inboxArrival(message.labelIds);
    if (hinted === false) return 'skip';
    let detail: Awaited<ReturnType<typeof metadata>>;
    try {
      detail = await metadata(summary.id, message.id);
    } catch (error) {
      if (error instanceof GmailError && error.code === 'network') return 'offline';
      if (
        error instanceof GmailError &&
        (error.code === 'rate-limited' ||
          error.code === 'needs-reauth' ||
          error.code === 'operation-in-progress' ||
          scopeFailure(error))
      ) {
        throw error;
      }
      return 'hold';
    }
    if (detail === null) return 'skip';
    if (inboxArrival(detail.labelIds) !== true) return 'skip';
    if (sentByOwner(detail.from, summary.email) !== false) return 'skip';
    const sender = clip(detail.from ?? '');
    if (sender.length === 0) return 'skip';
    const subject = clip(detail.subject ?? '');
    candidates.push({
      messageId: message.id,
      threadId: message.threadId,
      sender,
      subject: subject.length === 0 ? '(no subject)' : subject
    });
    return 'skip';
  }

  function showToasts(summary: GoogleAccountSummary, candidates: readonly Candidate[]): void {
    const prefs = readPrefs();
    if (prefs.notifications !== 'on' || candidates.length === 0 || stopped) return;
    const multiple = deps.listAccounts().filter((item) => item.status === 'connected').length > 1;
    const prefix =
      prefs.content === 'show' && multiple && summary.email !== null ? clip(summary.email) : '';
    const individual = candidates.slice(0, toastCap);
    const rest = candidates.slice(toastCap);
    const notices = individual.map((candidate) => {
      if (prefs.content === 'hide') {
        return {
          title: 'New email received',
          body: 'New email received',
          threadId: candidate.threadId
        };
      }
      const title =
        prefix.length === 0 ? candidate.sender : clip(`${prefix} · ${candidate.sender}`);
      return { title, body: candidate.subject, threadId: candidate.threadId };
    });
    if (rest.length > 0) {
      const first = rest[0];
      if (first !== undefined) {
        notices.push({
          title:
            prefs.content === 'hide'
              ? 'New email received'
              : prefix.length === 0
                ? 'New mail'
                : clip(`${prefix} · New mail`),
          body: `${rest.length} more new messages`,
          threadId: first.threadId
        });
      }
    }
    for (const notice of notices) {
      deps.notify.show({
        title: notice.title,
        body: notice.body,
        onClick: () => {
          const payload = { accountId: summary.id, threadId: notice.threadId };
          if (parseGmailNotificationOpen(payload) === null) return;
          const current = account(summary.id);
          if (current === null || current.status !== 'connected') return;
          deps.emit(gmailNotificationOpenChannel, payload);
        },
        onFailed: () => {
          notificationsBlocked = true;
          publish({ accountId: summary.id, refresh: 'none', threadId: null });
        }
      });
    }
  }

  async function bootstrap(
    summary: GoogleAccountSummary,
    epoch: number,
    recovery: boolean
  ): Promise<void> {
    states.set(summary.id, 'bootstrapping');
    publish({ accountId: summary.id, refresh: 'none', threadId: null });
    const historyId = await profile(summary.id);
    if (!persist(summary.id, epoch, historyId, [])) return;
    const changed = recovery
      ? refreshFor(view, summary.id, {
          threads: new Set<string>(),
          labels: new Set<string>(),
          folderLabels: new Set<string>(),
          uncertain: true
        })
      : { accountId: summary.id, refresh: 'none' as const, threadId: null };
    remember(summary.id, 'idle', changed);
  }

  async function syncHistory(
    summary: GoogleAccountSummary,
    epoch: number,
    start: string
  ): Promise<void> {
    states.set(summary.id, 'syncing');
    publish({ accountId: summary.id, refresh: 'none', threadId: null });
    const impact: Impact = {
      threads: new Set<string>(),
      labels: new Set<string>(),
      folderLabels: new Set<string>(),
      uncertain: false
    };
    const candidates: Candidate[] = [];
    let pageToken: string | null = null;
    const finish = (state: GmailSyncState): void => {
      showToasts(summary, candidates);
      remember(summary.id, state, refreshFor(view, summary.id, impact));
    };
    try {
      for (let page = 0; page < historyPageLimit; page += 1) {
        if (!live(summary.id, epoch)) return;
        if (deps.bulkBusy(summary.id)) {
          pending.add(summary.id);
          finish('skipped');
          return;
        }
        const url = new URL(`${gmailRoot}/history`);
        url.searchParams.set('startHistoryId', start);
        url.searchParams.set('maxResults', '100');
        if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
        let payload: unknown;
        try {
          payload = await deps.read(summary.id, url.href);
        } catch (error) {
          if (error instanceof GmailError && error.code === 'not-found') throw new HistoryExpired();
          throw error;
        }
        const parsed = parseHistoryPage(payload);
        for (const record of parsed.records) {
          if (!live(summary.id, epoch)) return;
          const recorded: string[] = [];
          for (const message of record.added) {
            const outcome = await consider(summary, message, candidates);
            if (outcome === 'offline') {
              finish('offline');
              return;
            }
            if (outcome === 'hold') {
              finish('idle');
              return;
            }
            const added = candidates[candidates.length - 1];
            if (added !== undefined && added.messageId === message.id) recorded.push(message.id);
          }
          absorb(impact, record);
          if (!persist(summary.id, epoch, record.id, recorded)) return;
        }
        if (parsed.nextPageToken === null) {
          if (!persist(summary.id, epoch, parsed.historyId, [])) return;
          finish('idle');
          return;
        }
        if (parsed.records.length === 0) {
          finish('idle');
          return;
        }
        pageToken = parsed.nextPageToken;
      }
      finish('idle');
    } catch (error) {
      showToasts(summary, candidates);
      throw error;
    }
  }

  async function execute(accountId: string, epoch: number): Promise<void> {
    if (!live(accountId, epoch) || suspended) return;
    const summary = account(accountId);
    if (summary === null || summary.status !== 'connected') {
      if (summary?.status === 'needs_reauth') states.set(accountId, 'needs-reauth');
      return;
    }
    if (halted.has(accountId)) {
      remember(accountId, 'needs-reauth', { accountId, refresh: 'none', threadId: null });
      return;
    }
    if (deps.bulkBusy(accountId)) {
      pending.add(accountId);
      remember(accountId, 'skipped', { accountId, refresh: 'none', threadId: null });
      return;
    }
    pending.delete(accountId);
    try {
      const cursor = cursorOf(accountId);
      if (cursor === null) await bootstrap(summary, epoch, false);
      else await syncHistory(summary, epoch, cursor);
    } catch (error) {
      if (!live(accountId, epoch)) return;
      if (error instanceof HistoryExpired) {
        try {
          await bootstrap(summary, epoch, true);
        } catch (recoveryError) {
          fail(accountId, epoch, asGmail(recoveryError));
        }
        return;
      }
      fail(accountId, epoch, asGmail(error));
    }
  }

  function fail(accountId: string, epoch: number, error: GmailError): void {
    if (!live(accountId, epoch)) return;
    if (error.code === 'needs-reauth' || scopeFailure(error)) {
      if (scopeFailure(error)) halted.add(accountId);
      remember(accountId, 'needs-reauth', { accountId, refresh: 'none', threadId: null });
      return;
    }
    if (error.code === 'network') {
      remember(accountId, 'offline', { accountId, refresh: 'none', threadId: null });
      return;
    }
    if (error.code === 'operation-in-progress') {
      remember(accountId, 'skipped', { accountId, refresh: 'none', threadId: null });
      return;
    }
    remember(accountId, 'idle', { accountId, refresh: 'none', threadId: null });
  }

  function runAccount(accountId: string): Promise<void> {
    const epoch = epochs.get(accountId) ?? 0;
    if (!epochs.has(accountId)) epochs.set(accountId, epoch);
    const current = jobs.get(accountId);
    if (current !== undefined && jobEpoch.get(accountId) === epoch) return current;
    let job: Promise<void> = Promise.resolve();
    job = Promise.resolve(current).then(
      () => execute(accountId, epoch),
      () => execute(accountId, epoch)
    );
    jobs.set(accountId, job);
    jobEpoch.set(accountId, epoch);
    void job.finally(() => {
      if (jobs.get(accountId) === job) jobs.delete(accountId);
    });
    return job;
  }

  function runAll(): Promise<void> {
    if (sweep !== null) return sweep;
    const job = (async () => {
      if (stopped || suspended) return;
      for (const summary of deps.listAccounts()) {
        if (stopped || suspended) return;
        if (summary.status !== 'connected') {
          states.set(summary.id, 'needs-reauth');
          continue;
        }
        await runAccount(summary.id);
      }
    })().finally(() => {
      sweep = null;
    });
    sweep = job;
    return job;
  }

  function arm(): void {
    cancelTimer?.();
    cancelTimer = schedule.set(syncIntervalMs, () => {
      if (!stopped && !suspended) void runAll();
      if (!stopped) arm();
    });
  }

  function bump(accountId: string): void {
    epochs.set(accountId, (epochs.get(accountId) ?? 0) + 1);
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      arm();
      void runAll();
    },
    shutdown() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
    },
    suspend() {
      suspended = true;
    },
    resume() {
      if (stopped) return;
      suspended = false;
      if (started) arm();
      void runAll();
    },
    focus(accountId: string) {
      const summary = requireAccount(accountId);
      if (summary.status !== 'connected' || stopped || suspended) return;
      const success = lastSuccessAt(accountId);
      if (success !== null && now().getTime() - Date.parse(success) <= focusGapMs) return;
      void runAccount(accountId);
    },
    accountConnected(accountId: string) {
      bump(accountId);
      halted.delete(accountId);
      pending.delete(accountId);
      deps.database.prepare('DELETE FROM mailbox_sync WHERE account_id = ?').run(accountId);
      deps.database.prepare('DELETE FROM notified_messages WHERE account_id = ?').run(accountId);
      if (stopped || suspended) return;
      void runAccount(accountId);
    },
    accountDisconnected(accountId: string) {
      bump(accountId);
      halted.delete(accountId);
      pending.delete(accountId);
      states.delete(accountId);
      if (view?.accountId === accountId) view = null;
    },
    afterBulk(accountId: string) {
      if (!pending.has(accountId) || stopped) return;
      pending.delete(accountId);
      if (suspended) {
        pending.add(accountId);
        return;
      }
      void runAccount(accountId);
    },
    status(accountId: string) {
      const summary = requireAccount(accountId);
      const prefs = readPrefs();
      let state = states.get(accountId) ?? 'idle';
      if (summary.status === 'needs_reauth') state = 'needs-reauth';
      return {
        state,
        lastSuccessAt: lastSuccessAt(accountId),
        notifications: prefs.notifications,
        content: prefs.content,
        pending: pending.has(accountId),
        notificationsBlocked
      };
    },
    setPreferences(input) {
      requireAccount(input.accountId);
      const stamp = stampOf(now());
      withTransaction(deps.database, () => {
        const write = deps.database.prepare(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        );
        write.run('gmail.notifications', input.notifications, stamp);
        write.run('gmail.notification_content', input.content, stamp);
      });
      return this.status(input.accountId);
    },
    reportView(next) {
      view = next.accountId === null ? null : next;
    }
  };
}
