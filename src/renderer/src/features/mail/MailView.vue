<script setup lang="ts">
import {
  AlertOctagon,
  Archive,
  ChevronLeft,
  ChevronsUpDown,
  File,
  Flag,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  PanelLeft,
  Paperclip,
  Reply,
  ReplyAll,
  RotateCcw,
  Search,
  Send,
  SquarePen,
  Star,
  Tag,
  Trash2
} from '@lucide/vue';
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Component } from 'vue';
import { onBeforeRouteLeave, useRouter, RouterLink } from 'vue-router';
import {
  GmailIpcError,
  gmailErrorMessage,
  isGmailId,
  type GmailApi,
  type GmailBulkResult,
  type GmailErrorCode,
  type GmailLabel,
  type GmailMessage,
  type GmailSyncChanged,
  type GmailSyncStatus,
  type GmailThreadSummary
} from '../../../../shared/gmail.ts';
import {
  GoogleIpcError,
  type GoogleAccountSummary,
  type GoogleApi
} from '../../../../shared/google-accounts.ts';
import {
  forwardQuote,
  isMailboxAddress,
  replyQuote,
  type ComposeSendKind
} from '../../../../shared/mail-compose.ts';
import { type DraftAttachmentRef } from '../../../../shared/mail-draft.ts';
import { createRendererAppApi } from '../../aurora-client.ts';
import StatusPanel from '../../components/StatusPanel.vue';
import { pendingMailOpen } from './mail-open.ts';
import './mail.css';

const folderIcons: Record<string, Component> = {
  INBOX: Inbox,
  SENT: Send,
  DRAFT: File,
  SPAM: AlertOctagon,
  TRASH: Trash2,
  STARRED: Star,
  IMPORTANT: Flag
};

interface MailCompose {
  generation: number;
  accountId: string;
  from: string;
  kind: ComposeSendKind;
  threadId: string | null;
  messageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  toDraft: string;
  ccDraft: string;
  bccDraft: string;
  showCc: boolean;
  showBcc: boolean;
  subject: string;
  subjectLocked: boolean;
  body: string;
  baseline: string;
  sending: boolean;
  error: string;
  unconfirmed: boolean;
  draftId: string | null;
  expectedMessageId: string | null;
  anchorThreadId: string | null;
  attachments: DraftAttachmentRef[];
  locked: boolean;
  saving: boolean;
  conflict: boolean;
  saveUnconfirmed: boolean;
  readOnlyHtml: string | null;
}

const props = defineProps<{ googleApi?: GoogleApi; gmailApi?: GmailApi }>();
const router = useRouter();
const accounts = ref<GoogleAccountSummary[]>([]);
const accountId = ref('');
const labels = ref<GmailLabel[]>([]);
const labelId = ref('INBOX');
const searchText = ref('');
const activeQuery = ref<string | null>(null);
const threads = ref<GmailThreadSummary[]>([]);
const pageTokens = ref<(string | null)[]>([null]);
const pageIndex = ref(0);
const nextPageToken = ref<string | null>(null);
const messages = ref<GmailMessage[]>([]);
const openId = ref<string | null>(null);
const syncState = ref<GmailSyncStatus | null>(null);
const syncNow = ref(Date.now());
let stopSyncListen = (): void => undefined;
let syncClock = 0;
let queuedOpen: { accountId: string; threadId: string } | null = null;
const status = ref<'loading' | 'ready' | 'error'>('loading');
const detail = ref('');
const errorCode = ref<GmailErrorCode | null>(null);
const expandedMeta = ref<Record<string, boolean>>({});
const actionNotice = ref('');
const actionBusy = ref<string | null>(null);
const actionEpoch = ref(0);
const searchStale = ref(false);
const labelsOpen = ref(false);
const foldersExpanded = ref(false);
const trashTarget = ref<string | null>(null);
const cancelTrashButton = ref<HTMLButtonElement | null>(null);
const compose = ref<MailCompose | null>(null);
const composeStatus = ref('');
const pendingDiscard = ref<(() => void) | null>(null);
const composeToInput = ref<HTMLInputElement | null>(null);
const composeBodyInput = ref<HTMLTextAreaElement | null>(null);
const keepComposeButton = ref<HTMLButtonElement | null>(null);
let generation = 0;
let composeEpoch = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveFlight: Promise<boolean> | null = null;
const downloadKey = ref('');
const pendingDelete = ref(false);
const selectedIds = ref<string[]>([]);
const bulkBusy = ref(false);
const bulkStatus = ref('');
const bulkTrash = ref(false);
const labelsDialog = ref(false);
const labelName = ref('');
const labelNotice = ref('');
const labelBusy = ref(false);
const renameId = ref<string | null>(null);
const renameName = ref('');
const deleteLabelTarget = ref<GmailLabel | null>(null);
const bulkLabelId = ref('');
const selectAllBox = ref<HTMLInputElement | null>(null);
const cancelBulkTrashButton = ref<HTMLButtonElement | null>(null);
const cancelDeleteLabelButton = ref<HTMLButtonElement | null>(null);
const labelNameInput = ref<HTMLInputElement | null>(null);
const keepDraftButton = ref<HTMLButtonElement | null>(null);
const conversationLabelsButton = ref<HTMLButtonElement | null>(null);
const visibleStale = ref(false);
const syncStatusFailed = ref(false);
const modalOpeners: HTMLElement[] = [];
let discardOpener: HTMLElement | null = null;
let deleteDraftOpener: HTMLElement | null = null;
let deleteLabelReturnId: string | null = null;
let refreshMessage = '';
let visibleRecovery: Promise<void> | null = null;
let bulkEpoch = 0;

type MailModal =
  'discard' | 'delete-draft' | 'delete-label' | 'trash' | 'bulk-trash' | 'labels' | 'compose';

const activeModal = computed<MailModal | null>(() => {
  if (pendingDiscard.value !== null) return 'discard';
  if (pendingDelete.value && compose.value !== null) return 'delete-draft';
  if (deleteLabelTarget.value !== null) return 'delete-label';
  if (trashTarget.value !== null) return 'trash';
  if (bulkTrash.value) return 'bulk-trash';
  if (labelsDialog.value) return 'labels';
  if (compose.value !== null) return 'compose';
  return null;
});

function google(): GoogleApi {
  return props.googleApi ?? createRendererAppApi(window.aurora).google;
}

function gmail(): GmailApi {
  return props.gmailApi ?? createRendererAppApi(window.aurora).gmail;
}

const connectedAccounts = computed(() =>
  accounts.value.filter((account) => account.status === 'connected')
);
const showRecovery = computed(
  () =>
    errorCode.value === 'needs-reauth' ||
    errorCode.value === 'permission-denied' ||
    errorCode.value === 'gmail-rejected' ||
    errorCode.value === 'insufficient-scope'
);
const selectedAccount = computed(() =>
  accounts.value.find((account) => account.id === accountId.value)
);
const userLabels = computed(() => labels.value.filter((label) => label.type === 'user'));
const selectedCount = computed(() => selectedIds.value.length);
const allVisibleSelected = computed(
  () =>
    threads.value.length > 0 &&
    threads.value.every((thread) => selectedIds.value.includes(thread.id))
);
const someVisibleSelected = computed(() => selectedCount.value > 0 && !allVisibleSelected.value);
const conversationUnread = computed(() => messages.value.some((item) => item.unread));
const conversationInInbox = computed(() =>
  messages.value.some((item) => item.labelIds.includes('INBOX'))
);
const conversationInTrash = computed(
  () => labelId.value === 'TRASH' || messages.value.some((item) => item.labelIds.includes('TRASH'))
);

function accountLabel(account: GoogleAccountSummary): string {
  return account.email ?? account.displayName ?? 'Google account';
}

const conversationSubject = computed(() => messages.value[0]?.subject ?? '(no subject)');
const conversationDate = computed(() => messages.value[messages.value.length - 1]?.date ?? null);

function folderIcon(label: GmailLabel): Component {
  return folderIcons[label.id] ?? Tag;
}

function folderSelected(id: string): boolean {
  return id === labelId.value && activeQuery.value === null;
}

function formatDate(value: string | null): string {
  if (value === null) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date
  );
}

function fail(error: unknown): void {
  if (error instanceof GmailIpcError) {
    errorCode.value = error.code;
    detail.value = error.message;
  } else if (error instanceof GoogleIpcError) {
    errorCode.value = 'internal';
    detail.value = error.message;
  } else {
    errorCode.value = 'internal';
    detail.value = gmailErrorMessage('internal');
  }
  status.value = 'error';
}

function bump(): number {
  generation += 1;
  return generation;
}

function resetPages(): void {
  pageTokens.value = [null];
  pageIndex.value = 0;
  nextPageToken.value = null;
}

async function loadList(gen: number): Promise<void> {
  status.value = 'loading';
  errorCode.value = null;
  searchStale.value = false;
  actionNotice.value = '';
  const listed = await gmail().listLabels(accountId.value);
  if (gen !== generation) return;
  labels.value = listed.labels;
  if (!labels.value.some((label) => label.id === labelId.value)) {
    labelId.value = labels.value.some((label) => label.id === 'INBOX')
      ? 'INBOX'
      : (labels.value[0]?.id ?? 'INBOX');
  }
  const page = await gmail().listThreads({
    accountId: accountId.value,
    labelId: activeQuery.value === null ? labelId.value : null,
    query: activeQuery.value,
    pageToken: pageTokens.value[pageIndex.value] ?? null
  });
  if (gen !== generation) return;
  threads.value = page.threads;
  nextPageToken.value = page.nextPageToken;
  status.value = 'ready';
}

async function startList(): Promise<void> {
  visibleStale.value = false;
  invalidateBulk();
  threads.value = [];
  messages.value = [];
  openId.value = null;
  const gen = bump();
  try {
    await loadList(gen);
  } catch (error) {
    if (gen !== generation) return;
    fail(error);
  }
}

async function reloadPage(): Promise<void> {
  visibleStale.value = false;
  invalidateBulk();
  threads.value = [];
  messages.value = [];
  openId.value = null;
  const gen = bump();
  status.value = 'loading';
  errorCode.value = null;
  searchStale.value = false;
  actionNotice.value = '';
  try {
    const page = await gmail().listThreads({
      accountId: accountId.value,
      labelId: activeQuery.value === null ? labelId.value : null,
      query: activeQuery.value,
      pageToken: pageTokens.value[pageIndex.value] ?? null
    });
    if (gen !== generation) return;
    threads.value = page.threads;
    nextPageToken.value = page.nextPageToken;
    status.value = 'ready';
  } catch (error) {
    if (gen !== generation) return;
    fail(error);
  }
}

function chooseAccount(event: Event): void {
  const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
  const account = accounts.value.find((item) => item.id === value);
  if (account === undefined || account.status !== 'connected' || value === accountId.value) return;
  if (compose.value?.sending === true) return;
  const apply = (): void => {
    accountId.value = value;
    searchText.value = '';
    activeQuery.value = null;
    labelId.value = 'INBOX';
    resetPages();
    void startList();
  };
  if (compose.value !== null) {
    askDiscard(apply);
    return;
  }
  apply();
}

function chooseLabel(id: string): void {
  foldersExpanded.value = false;
  if (id === labelId.value && activeQuery.value === null && openId.value === null) return;
  labelId.value = id;
  searchText.value = '';
  activeQuery.value = null;
  resetPages();
  void startList();
}

function submitSearch(): void {
  if (status.value === 'loading') return;
  const query = searchText.value.trim();
  activeQuery.value = query.length === 0 ? null : query;
  resetPages();
  void startList();
}

function showNext(): void {
  if (nextPageToken.value === null) return;
  pageTokens.value = pageTokens.value.slice(0, pageIndex.value + 1);
  pageTokens.value.push(nextPageToken.value);
  pageIndex.value += 1;
  void reloadPage();
}

function showPrevious(): void {
  if (pageIndex.value === 0) return;
  pageIndex.value -= 1;
  void reloadPage();
}

async function openThread(id: string): Promise<void> {
  invalidateBulk();
  messages.value = [];
  openId.value = id;
  const gen = bump();
  status.value = 'loading';
  errorCode.value = null;
  try {
    const thread = await gmail().readThread(accountId.value, id);
    if (gen !== generation) return;
    messages.value = thread.messages;
    status.value = 'ready';
  } catch (error) {
    if (gen !== generation) return;
    fail(error);
  }
}

function back(): void {
  openId.value = null;
  messages.value = [];
  expandedMeta.value = {};
  errorCode.value = null;
  status.value = 'ready';
  bump();
}

function toggleMeta(id: string): void {
  expandedMeta.value = { ...expandedMeta.value, [id]: expandedMeta.value[id] !== true };
}

function hasRecipients(item: GmailMessage): boolean {
  return item.to !== null || item.cc !== null || item.bcc !== null;
}

function canChangeMail(): boolean {
  return selectedAccount.value?.canModifyMail === true;
}

function invalidateBulk(): void {
  bulkEpoch += 1;
  bulkBusy.value = false;
  selectedIds.value = [];
  bulkStatus.value = '';
  bulkTrash.value = false;
  labelsDialog.value = false;
  deleteLabelTarget.value = null;
  renameId.value = null;
}

function rowSelected(id: string): boolean {
  return selectedIds.value.includes(id);
}

function toggleRow(id: string): void {
  if (bulkBusy.value) return;
  if (rowSelected(id)) {
    selectedIds.value = selectedIds.value.filter((item) => item !== id);
    return;
  }
  if (selectedIds.value.length >= 20) return;
  selectedIds.value = [...selectedIds.value, id];
}

function toggleAllVisible(): void {
  if (bulkBusy.value) return;
  selectedIds.value = allVisibleSelected.value
    ? []
    : threads.value.map((thread) => thread.id).slice(0, 20);
}

function clearSelection(): void {
  if (bulkBusy.value) return;
  selectedIds.value = [];
}

function bulkSummary(result: GmailBulkResult): string {
  const succeeded = result.succeeded.length;
  const failed = result.failed.length;
  const unconfirmed = result.unconfirmed.length;
  const notAttempted = result.notAttempted.length;
  if (failed === 0 && unconfirmed === 0 && notAttempted === 0) {
    return `Updated ${succeeded} conversations.`;
  }
  const parts: string[] = [];
  if (succeeded === 0) parts.push('None of the selected conversations were updated.');
  else parts.push(`Updated ${succeeded}.`);
  if (failed > 0) parts.push(`${failed} could not be changed.`);
  if (unconfirmed > 0) parts.push(`${unconfirmed} could not be confirmed.`);
  if (notAttempted > 0) parts.push(`${notAttempted} were not attempted.`);
  return parts.join(' ');
}

async function refreshAfterBulk(account: string, notice: string): Promise<void> {
  const gen = bump();
  try {
    const listed = await gmail().listLabels(account);
    if (gen !== generation || account !== accountId.value) return;
    labels.value = listed.labels;
    const page = await gmail().listThreads({
      accountId: account,
      labelId: activeQuery.value === null ? labelId.value : null,
      query: activeQuery.value,
      pageToken: pageTokens.value[pageIndex.value] ?? null
    });
    if (gen !== generation || account !== accountId.value) return;
    threads.value = page.threads;
    nextPageToken.value = page.nextPageToken;
    status.value = 'ready';
    bulkStatus.value = notice;
  } catch (error) {
    if (gen !== generation || account !== accountId.value) return;
    bulkStatus.value = notice;
    actionNotice.value =
      error instanceof GmailIpcError ? error.message : gmailErrorMessage('internal');
  }
}

async function runBulk(run: (threadIds: string[]) => Promise<GmailBulkResult>): Promise<void> {
  if (bulkBusy.value || selectedIds.value.length === 0 || !canChangeMail()) return;
  const account = accountId.value;
  const threadIds = [...selectedIds.value];
  const epoch = bulkEpoch;
  bulkBusy.value = true;
  bulkStatus.value = '';
  actionNotice.value = '';
  try {
    const result = await run(threadIds);
    if (epoch !== bulkEpoch || account !== accountId.value) return;
    const notice = bulkSummary(result);
    selectedIds.value = [];
    await refreshAfterBulk(account, notice);
  } catch (error) {
    if (epoch !== bulkEpoch || account !== accountId.value) return;
    actionNotice.value =
      error instanceof GmailIpcError ? error.message : gmailErrorMessage('internal');
  } finally {
    if (epoch === bulkEpoch) bulkBusy.value = false;
  }
}

function bulkThreads(
  action: 'read' | 'unread' | 'archive' | 'trash' | 'untrash' | 'star' | 'unstar'
): void {
  void runBulk((threadIds) =>
    gmail().bulkThreads({ accountId: accountId.value, threadIds, action })
  );
}

function confirmBulkTrash(): void {
  bulkTrash.value = false;
  bulkThreads('trash');
}

function bulkUserLabel(mode: 'add' | 'remove'): void {
  const labelIdValue = bulkLabelId.value;
  if (labelIdValue.length === 0) return;
  void runBulk((threadIds) =>
    gmail().bulkLabel({
      accountId: accountId.value,
      threadIds,
      labelId: labelIdValue,
      mode
    })
  );
}

function pushOpener(event?: Event): void {
  const target = event?.currentTarget;
  if (target instanceof HTMLElement) modalOpeners.push(target);
}

function popOpener(): void {
  const opener = modalOpeners.pop() ?? null;
  focusElement(opener);
}

function openLabelDialog(event: Event): void {
  pushOpener(event);
  labelNotice.value = '';
  labelsDialog.value = true;
}

function askDeleteLabel(label: GmailLabel): void {
  deleteLabelReturnId = label.id;
  deleteLabelTarget.value = label;
}

function askDeleteDraft(event: Event): void {
  deleteDraftOpener = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  pendingDelete.value = true;
}

function openBulkTrash(event: Event): void {
  pushOpener(event);
  bulkTrash.value = true;
}

async function refreshLabelList(account: string): Promise<void> {
  const listed = await gmail().listLabels(account);
  if (account !== accountId.value) return;
  labels.value = listed.labels;
  if (!listed.labels.some((label) => label.id === bulkLabelId.value)) bulkLabelId.value = '';
}

async function createUserLabel(): Promise<void> {
  if (labelBusy.value) return;
  const account = accountId.value;
  labelBusy.value = true;
  labelNotice.value = '';
  try {
    const created = await gmail().createLabel({ accountId: account, name: labelName.value });
    if (account !== accountId.value) return;
    labelName.value = '';
    labelNotice.value = `Created ${created.name}.`;
    await refreshLabelList(account);
  } catch (error) {
    if (account !== accountId.value) return;
    labelNotice.value =
      error instanceof GmailIpcError ? error.message : gmailErrorMessage('internal');
  } finally {
    labelBusy.value = false;
  }
}

function startRename(label: GmailLabel): void {
  renameId.value = label.id;
  renameName.value = label.name;
}

async function renameUserLabel(label: GmailLabel): Promise<void> {
  if (labelBusy.value) return;
  const account = accountId.value;
  labelBusy.value = true;
  labelNotice.value = '';
  try {
    const renamed = await gmail().renameLabel({
      accountId: account,
      labelId: label.id,
      name: renameName.value
    });
    if (account !== accountId.value) return;
    renameId.value = null;
    labelNotice.value = `Renamed ${renamed.name}.`;
    await refreshLabelList(account);
  } catch (error) {
    if (account !== accountId.value) return;
    labelNotice.value =
      error instanceof GmailIpcError ? error.message : gmailErrorMessage('internal');
  } finally {
    labelBusy.value = false;
  }
}

async function confirmDeleteLabel(): Promise<void> {
  const label = deleteLabelTarget.value;
  deleteLabelTarget.value = null;
  if (label === null || labelBusy.value) return;
  const account = accountId.value;
  labelBusy.value = true;
  labelNotice.value = '';
  try {
    await gmail().deleteLabel({ accountId: account, labelId: label.id });
    if (account !== accountId.value) return;
    labelNotice.value = `Deleted ${label.name}.`;
    if (labelId.value === label.id && activeQuery.value === null) {
      labelsDialog.value = false;
      labelId.value = 'INBOX';
      resetPages();
      await startList();
      return;
    }
    await refreshLabelList(account);
  } catch (error) {
    if (account !== accountId.value) return;
    labelNotice.value =
      error instanceof GmailIpcError ? error.message : gmailErrorMessage('internal');
  } finally {
    labelBusy.value = false;
  }
}

function threadBusy(threadId: string): boolean {
  return actionBusy.value === threadId;
}

function refreshSearch(): void {
  resetPages();
  void startList();
}

function askTrash(threadId: string, event: Event): void {
  pushOpener(event);
  trashTarget.value = threadId;
}

function closeTrash(): void {
  trashTarget.value = null;
}

function labelApplied(labelIdValue: string): boolean {
  return messages.value.some((item) => item.labelIds.includes(labelIdValue));
}

async function runAction(
  threadId: string,
  sentence: string,
  apply: () => void,
  undo: () => void,
  call: () => Promise<unknown>,
  finish: () => void
): Promise<void> {
  if (!canChangeMail()) {
    actionNotice.value = gmailErrorMessage('insufficient-scope');
    return;
  }
  const capturedAccount = accountId.value;
  const gen = generation;
  const epoch = actionEpoch.value + 1;
  actionEpoch.value = epoch;
  actionBusy.value = threadId;
  actionNotice.value = '';
  apply();
  try {
    await call();
    if (gen !== generation || capturedAccount !== accountId.value) return;
    if (activeQuery.value !== null) searchStale.value = true;
    finish();
  } catch (error) {
    if (gen !== generation || capturedAccount !== accountId.value) return;
    if (error instanceof GmailIpcError && error.code === 'not-found') {
      threads.value = threads.value.filter((item) => item.id !== threadId);
      if (openId.value === threadId) back();
      actionNotice.value = error.message;
      return;
    }
    undo();
    actionNotice.value =
      error instanceof GmailIpcError &&
      (error.code === 'insufficient-scope' || error.code === 'needs-reauth')
        ? error.message
        : sentence;
  } finally {
    if (actionEpoch.value === epoch) actionBusy.value = null;
  }
}

function snapshotThreads(): GmailThreadSummary[] {
  return threads.value.map((item) => ({ ...item }));
}

function snapshotMessages(): GmailMessage[] {
  return messages.value.map((item) => ({ ...item, labelIds: [...item.labelIds] }));
}

function snapshotLabels(): GmailLabel[] {
  return labels.value.map((item) => ({ ...item }));
}

function changeRead(threadId: string, unread: boolean): void {
  const previousThreads = snapshotThreads();
  const previousMessages = snapshotMessages();
  const previousLabels = snapshotLabels();
  const current = threads.value.find((item) => item.id === threadId);
  void runAction(
    threadId,
    unread
      ? 'Aurora could not mark this conversation unread.'
      : 'Aurora could not mark this conversation read.',
    () => {
      threads.value = threads.value.map((item) =>
        item.id === threadId ? { ...item, unread } : item
      );
      if (openId.value === threadId) {
        messages.value = messages.value.map((item) => ({ ...item, unread }));
      }
      if (activeQuery.value === null && current !== undefined && current.unread !== unread) {
        labels.value = labels.value.map((label) => {
          if (label.id !== labelId.value || label.unreadCount === null) return label;
          return { ...label, unreadCount: Math.max(0, label.unreadCount + (unread ? 1 : -1)) };
        });
      }
    },
    () => {
      threads.value = previousThreads;
      messages.value = previousMessages;
      labels.value = previousLabels;
    },
    () =>
      unread
        ? gmail().markUnread(accountId.value, threadId)
        : gmail().markRead(accountId.value, threadId),
    () => undefined
  );
}

function archiveConversation(threadId: string): void {
  const previousThreads = snapshotThreads();
  void runAction(
    threadId,
    'Aurora could not archive this conversation.',
    () => undefined,
    () => {
      threads.value = previousThreads;
    },
    () => gmail().archiveThread(accountId.value, threadId),
    () => {
      if (activeQuery.value === null && labelId.value === 'INBOX') {
        threads.value = threads.value.filter((item) => item.id !== threadId);
        if (openId.value === threadId) back();
      }
    }
  );
}

function moveToTrash(threadId: string): void {
  const previousThreads = snapshotThreads();
  void runAction(
    threadId,
    'Aurora could not move this conversation to Trash.',
    () => undefined,
    () => {
      threads.value = previousThreads;
    },
    () => gmail().trashThread(accountId.value, threadId),
    () => {
      if (activeQuery.value === null && labelId.value !== 'TRASH') {
        threads.value = threads.value.filter((item) => item.id !== threadId);
        if (openId.value === threadId) back();
      }
    }
  );
}

function restoreConversation(threadId: string): void {
  const previousThreads = snapshotThreads();
  void runAction(
    threadId,
    'Aurora could not restore this conversation.',
    () => undefined,
    () => {
      threads.value = previousThreads;
    },
    () => gmail().untrashThread(accountId.value, threadId),
    () => {
      if (activeQuery.value === null && labelId.value === 'TRASH') {
        threads.value = threads.value.filter((item) => item.id !== threadId);
        if (openId.value === threadId) back();
      }
    }
  );
}

function confirmTrash(): void {
  const threadId = trashTarget.value;
  trashTarget.value = null;
  if (threadId !== null) moveToTrash(threadId);
}

function toggleUserLabel(label: GmailLabel): void {
  const threadId = openId.value;
  if (threadId === null) return;
  const removing = labelApplied(label.id);
  const previousMessages = snapshotMessages();
  const previousThreads = snapshotThreads();
  void runAction(
    threadId,
    removing ? 'Aurora could not remove this label.' : 'Aurora could not add this label.',
    () => {
      messages.value = messages.value.map((item) => ({
        ...item,
        labelIds: removing
          ? item.labelIds.filter((id) => id !== label.id)
          : [...item.labelIds, label.id]
      }));
    },
    () => {
      messages.value = previousMessages;
      threads.value = previousThreads;
    },
    () =>
      removing
        ? gmail().removeLabel(accountId.value, threadId, label.id)
        : gmail().addLabel(accountId.value, threadId, label.id),
    () => {
      if (activeQuery.value === null && removing && labelId.value === label.id) {
        threads.value = threads.value.filter((item) => item.id !== threadId);
        if (openId.value === threadId) back();
      }
    }
  );
}

function changeStar(message: GmailMessage): void {
  const threadId = openId.value;
  if (threadId === null) return;
  const starred = !message.starred;
  const previousMessages = snapshotMessages();
  const previousThreads = snapshotThreads();
  void runAction(
    threadId,
    starred
      ? 'Aurora could not star this message.'
      : 'Aurora could not remove the star from this message.',
    () => {
      messages.value = messages.value.map((item) =>
        item.id === message.id
          ? {
              ...item,
              starred,
              labelIds: starred
                ? [...item.labelIds, 'STARRED']
                : item.labelIds.filter((id) => id !== 'STARRED')
            }
          : item
      );
      const anyStar = messages.value.some((item) => item.starred);
      threads.value = threads.value.map((item) =>
        item.id === threadId ? { ...item, starred: anyStar } : item
      );
    },
    () => {
      messages.value = previousMessages;
      threads.value = previousThreads;
    },
    () =>
      starred
        ? gmail().starMessage(accountId.value, threadId, message.id)
        : gmail().unstarMessage(accountId.value, threadId, message.id),
    () => {
      const anyStar = messages.value.some((item) => item.starred);
      if (activeQuery.value === null && labelId.value === 'STARRED' && !anyStar) {
        threads.value = threads.value.filter((item) => item.id !== threadId);
        if (openId.value === threadId) back();
      }
    }
  );
}

function composeSnapshot(draft: MailCompose): string {
  return JSON.stringify({
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    toDraft: draft.toDraft,
    ccDraft: draft.ccDraft,
    bccDraft: draft.bccDraft,
    subject: draft.subject,
    body: draft.body,
    attachments: draft.attachments.map((file) => file.token)
  });
}

function clearSaveTimer(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function composeHasContent(draft: MailCompose): boolean {
  return (
    draft.to.length + draft.cc.length + draft.bcc.length > 0 ||
    draft.subject.length > 0 ||
    draft.body.length > 0 ||
    draft.attachments.length > 0 ||
    draft.draftId !== null
  );
}

function scheduleSave(): void {
  const draft = compose.value;
  if (
    draft === null ||
    draft.locked ||
    draft.sending ||
    draft.conflict ||
    draft.saveUnconfirmed ||
    draft.unconfirmed ||
    draft.saving ||
    !composeHasContent(draft)
  ) {
    return;
  }
  clearSaveTimer();
  const generationAtSchedule = draft.generation;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveCompose(generationAtSchedule);
  }, 2000);
}

function composeDirty(): boolean {
  const draft = compose.value;
  return draft !== null && composeSnapshot(draft) !== draft.baseline;
}

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  if (!composeDirty()) return;
  event.preventDefault();
  event.returnValue = '';
}

function composeTitle(kind: ComposeSendKind): string {
  if (kind === 'reply') return 'Reply';
  if (kind === 'reply-all') return 'Reply all';
  if (kind === 'forward') return 'Forward';
  return 'New message';
}

function beginCompose(
  draft: Omit<
    MailCompose,
    | 'generation'
    | 'baseline'
    | 'draftId'
    | 'expectedMessageId'
    | 'anchorThreadId'
    | 'attachments'
    | 'locked'
    | 'saving'
    | 'conflict'
    | 'saveUnconfirmed'
    | 'readOnlyHtml'
  > &
    Partial<
      Pick<
        MailCompose,
        | 'draftId'
        | 'expectedMessageId'
        | 'anchorThreadId'
        | 'attachments'
        | 'locked'
        | 'saving'
        | 'conflict'
        | 'saveUnconfirmed'
        | 'readOnlyHtml'
      >
    >,
  generationNumber?: number
): void {
  if (generationNumber === undefined) composeEpoch += 1;
  const next: MailCompose = {
    draftId: null,
    expectedMessageId: null,
    anchorThreadId: null,
    attachments: [],
    locked: false,
    saving: false,
    conflict: false,
    saveUnconfirmed: false,
    readOnlyHtml: null,
    ...draft,
    generation: generationNumber ?? composeEpoch,
    baseline: ''
  };
  next.baseline = composeSnapshot(next);
  compose.value = next;
  composeStatus.value = next.locked
    ? 'Aurora cannot edit this draft without losing its formatting. The Gmail draft was not changed.'
    : '';
  pendingDiscard.value = null;
  pendingDelete.value = false;
  void nextTick(() => {
    if (next.subjectLocked) composeBodyInput.value?.focus();
    else composeToInput.value?.focus();
  });
}

function releaseAttachments(draft: MailCompose): void {
  for (const file of draft.attachments) {
    void gmail()
      .dropAttachment({
        accountId: draft.accountId,
        composerGeneration: draft.generation,
        token: file.token
      })
      .catch(() => undefined);
  }
}

function closeCompose(): void {
  const draft = compose.value;
  clearSaveTimer();
  compose.value = null;
  pendingDelete.value = false;
  if (draft !== null) releaseAttachments(draft);
}

function askDiscard(next: () => void): void {
  if (!composeDirty()) {
    closeCompose();
    next();
    return;
  }
  discardOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  pendingDiscard.value = next;
}

function keepCompose(): void {
  pendingDiscard.value = null;
}

function discardCompose(): void {
  const next = pendingDiscard.value;
  pendingDiscard.value = null;
  closeCompose();
  next?.();
}

function requestCloseCompose(): void {
  if (compose.value?.sending === true) return;
  askDiscard(() => undefined);
}

function requireMailChange(): boolean {
  if (canChangeMail()) return true;
  actionNotice.value = 'Reconnect this Google account before changing mail.';
  return false;
}

function requestNewMessage(event?: Event): void {
  if (!requireMailChange()) return;
  const account = selectedAccount.value;
  if (account === undefined) return;
  const open = (): void => {
    beginCompose({
      accountId: account.id,
      from: account.email ?? '',
      kind: 'new',
      threadId: null,
      messageId: null,
      to: [],
      cc: [],
      bcc: [],
      toDraft: '',
      ccDraft: '',
      bccDraft: '',
      showCc: false,
      showBcc: false,
      subject: '',
      subjectLocked: false,
      body: '',
      sending: false,
      error: '',
      unconfirmed: false
    });
  };
  if (compose.value !== null) askDiscard(open);
  else {
    pushOpener(event);
    open();
  }
}

function requestSeed(
  kind: 'reply' | 'reply-all' | 'forward',
  item: GmailMessage,
  event?: Event
): void {
  if (!requireMailChange()) return;
  const account = selectedAccount.value;
  const threadId = openId.value;
  if (account === undefined || threadId === null) return;
  const open = async (): Promise<void> => {
    const captured = account.id;
    try {
      const seed = await gmail().composeSeed({
        accountId: captured,
        threadId,
        messageId: item.id,
        kind
      });
      if (accountId.value !== captured || openId.value !== threadId) return;
      beginCompose({
        accountId: captured,
        from: account.email ?? '',
        kind,
        threadId,
        messageId: item.id,
        to: [...seed.to],
        cc: [...seed.cc],
        bcc: [],
        toDraft: '',
        ccDraft: '',
        bccDraft: '',
        showCc: seed.cc.length > 0,
        showBcc: false,
        subject: seed.subject,
        subjectLocked: kind !== 'forward',
        body:
          kind === 'forward'
            ? forwardQuote({
                from: item.from,
                date: item.date,
                subject: item.subject,
                to: item.to,
                text: item.text
              })
            : replyQuote({ from: item.from, date: item.date, text: item.text }),
        sending: false,
        error: '',
        unconfirmed: false
      });
    } catch (error) {
      if (accountId.value !== captured) return;
      actionNotice.value =
        error instanceof GmailIpcError && error.code !== 'invalid-request'
          ? error.message
          : kind === 'forward'
            ? 'Aurora could not forward this message.'
            : 'Aurora could not reply in this conversation.';
    }
  };
  if (compose.value !== null) askDiscard(() => void open());
  else {
    pushOpener(event);
    void open();
  }
}

function draftText(field: 'to' | 'cc' | 'bcc'): string {
  const draft = compose.value;
  if (draft === null) return '';
  if (field === 'to') return draft.toDraft;
  if (field === 'cc') return draft.ccDraft;
  return draft.bccDraft;
}

function setComposeInput(
  field: 'toDraft' | 'ccDraft' | 'bccDraft' | 'subject' | 'body',
  event: Event
): void {
  const draft = compose.value;
  if (draft === null) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
  draft[field] = target.value;
  scheduleSave();
}

function setDraftText(field: 'to' | 'cc' | 'bcc', value: string): void {
  const draft = compose.value;
  if (draft === null) return;
  if (field === 'to') draft.toDraft = value;
  else if (field === 'cc') draft.ccDraft = value;
  else draft.bccDraft = value;
}

function commitAddresses(field: 'to' | 'cc' | 'bcc', raw = draftText(field)): boolean {
  const draft = compose.value;
  if (draft === null) return false;
  const pieces = raw
    .split(/[,;\n]/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
  if (pieces.length === 0) {
    setDraftText(field, '');
    return true;
  }
  if (pieces.some((piece) => !isMailboxAddress(piece))) {
    draft.error = 'Enter a valid email address.';
    setDraftText(field, raw);
    return false;
  }
  const current = field === 'to' ? draft.to : field === 'cc' ? draft.cc : draft.bcc;
  const seen = new Set(current.map((address) => address.toLowerCase()));
  const next = [...current];
  for (const piece of pieces) {
    const key = piece.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(piece);
  }
  if (field === 'to') draft.to = next;
  else if (field === 'cc') draft.cc = next;
  else draft.bcc = next;
  setDraftText(field, '');
  draft.error = '';
  scheduleSave();
  return true;
}

function removeAddress(field: 'to' | 'cc' | 'bcc', address: string): void {
  const draft = compose.value;
  if (draft === null) return;
  const next = (field === 'to' ? draft.to : field === 'cc' ? draft.cc : draft.bcc).filter(
    (item) => item !== address
  );
  if (field === 'to') draft.to = next;
  else if (field === 'cc') draft.cc = next;
  else draft.bcc = next;
  scheduleSave();
}

function pasteAddresses(field: 'to' | 'cc' | 'bcc', event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text') ?? '';
  if (!/[,;\n]/.test(text)) return;
  event.preventDefault();
  commitAddresses(field, text);
}

function viewSent(): void {
  openId.value = null;
  messages.value = [];
  labelId.value = 'SENT';
  searchText.value = '';
  activeQuery.value = null;
  resetPages();
  status.value = 'loading';
  void reloadPage();
}

async function saveCompose(generationAtSave: number): Promise<boolean> {
  const draft = compose.value;
  if (
    draft === null ||
    draft.generation !== generationAtSave ||
    draft.locked ||
    draft.conflict ||
    draft.saveUnconfirmed ||
    !composeHasContent(draft)
  ) {
    return false;
  }
  if (!commitAddresses('to') || !commitAddresses('cc') || !commitAddresses('bcc')) return false;
  draft.saving = true;
  composeStatus.value = 'Saving…';
  const accountAtSave = draft.accountId;
  const flight = gmail()
    .saveDraft({
      accountId: draft.accountId,
      draftId: draft.draftId,
      expectedMessageId: draft.expectedMessageId,
      kind: draft.kind,
      threadId: draft.threadId,
      messageId: draft.messageId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      attachmentTokens: draft.attachments.map((file) => file.token),
      replaceConfirmed: false,
      composerGeneration: draft.generation
    })
    .then((saved) => {
      if (
        compose.value === null ||
        compose.value.generation !== generationAtSave ||
        compose.value.accountId !== accountAtSave
      ) {
        return false;
      }
      compose.value.draftId = saved.draftId;
      compose.value.expectedMessageId = saved.messageId;
      if (saved.threadId !== null) compose.value.anchorThreadId = saved.threadId;
      compose.value.saving = false;
      compose.value.baseline = composeSnapshot(compose.value);
      composeStatus.value = 'Saved';
      if (activeQuery.value !== null) searchStale.value = true;
      else if (labelId.value === 'DRAFT' && openId.value === null) void reloadPage();
      return true;
    })
    .catch((error: unknown) => {
      if (compose.value === null || compose.value.generation !== generationAtSave) return false;
      compose.value.saving = false;
      const failure = error instanceof GmailIpcError ? error.code : 'internal';
      if (failure === 'draft-conflict') {
        compose.value.conflict = true;
        composeStatus.value = gmailErrorMessage('draft-conflict');
        return false;
      }
      if (failure === 'save-unconfirmed') {
        compose.value.saveUnconfirmed = true;
        composeStatus.value = gmailErrorMessage('save-unconfirmed');
        return false;
      }
      composeStatus.value = 'Not saved';
      return false;
    });
  saveFlight = flight;
  try {
    return await flight;
  } finally {
    if (saveFlight === flight) saveFlight = null;
  }
}

async function overwriteDraft(): Promise<void> {
  const draft = compose.value;
  if (draft === null || !draft.conflict) return;
  draft.conflict = false;
  draft.saving = true;
  const generationAtSave = draft.generation;
  try {
    const saved = await gmail().saveDraft({
      accountId: draft.accountId,
      draftId: draft.draftId,
      expectedMessageId: draft.expectedMessageId,
      kind: draft.kind,
      threadId: draft.threadId,
      messageId: draft.messageId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      attachmentTokens: draft.attachments.map((file) => file.token),
      replaceConfirmed: true,
      composerGeneration: draft.generation
    });
    if (compose.value === null || compose.value.generation !== generationAtSave) return;
    compose.value.draftId = saved.draftId;
    compose.value.expectedMessageId = saved.messageId;
    if (saved.threadId !== null) compose.value.anchorThreadId = saved.threadId;
    compose.value.baseline = composeSnapshot(compose.value);
    compose.value.saving = false;
    composeStatus.value = 'Saved';
    scheduleSave();
  } catch (error: unknown) {
    if (compose.value === null || compose.value.generation !== generationAtSave) return;
    compose.value.saving = false;
    compose.value.conflict = true;
    const failure = error instanceof GmailIpcError ? error.code : 'internal';
    composeStatus.value =
      failure === 'save-unconfirmed' || failure === 'draft-conflict'
        ? gmailErrorMessage(failure)
        : 'Not saved';
    if (failure === 'save-unconfirmed') compose.value.saveUnconfirmed = true;
  }
}

async function reloadDraft(): Promise<void> {
  const draft = compose.value;
  if (draft === null || draft.expectedMessageId === null) return;
  const messageId = draft.expectedMessageId;
  const threadId = draft.anchorThreadId ?? draft.threadId;
  const item = messages.value.find((message) => message.id === messageId);
  if (item !== undefined && openId.value !== null) {
    closeCompose();
    requestEdit(item);
    return;
  }
  if (threadId === null) return;
  const account = draft.accountId;
  const from = draft.from;
  closeCompose();
  composeEpoch += 1;
  const generationAtOpen = composeEpoch;
  try {
    const opened = await gmail().openDraft({
      accountId: account,
      threadId,
      messageId,
      composerGeneration: generationAtOpen
    });
    if (accountId.value !== account) return;
    beginCompose(
      {
        accountId: account,
        from,
        kind: opened.kind,
        threadId: opened.threadId,
        messageId: opened.kind === 'new' ? null : messageId,
        to: opened.to,
        cc: opened.cc,
        bcc: opened.bcc,
        toDraft: '',
        ccDraft: '',
        bccDraft: '',
        showCc: opened.cc.length > 0,
        showBcc: opened.bcc.length > 0,
        subject: opened.subject,
        subjectLocked: opened.subjectLocked,
        body: opened.body,
        sending: false,
        error: '',
        unconfirmed: false,
        draftId: opened.draftId,
        expectedMessageId: opened.messageId,
        anchorThreadId: opened.threadId ?? threadId,
        attachments: opened.attachments,
        locked: opened.locked,
        readOnlyHtml: null
      },
      generationAtOpen
    );
  } catch (error: unknown) {
    actionNotice.value =
      error instanceof GmailIpcError ? error.message : gmailErrorMessage('internal');
  }
}

function viewDrafts(): void {
  openId.value = null;
  messages.value = [];
  labelId.value = 'DRAFT';
  searchText.value = '';
  activeQuery.value = null;
  resetPages();
  status.value = 'loading';
  void reloadPage();
}

function requestEdit(item: GmailMessage, event?: Event): void {
  if (!requireMailChange() || openId.value === null) return;
  const threadId = openId.value;
  const account = selectedAccount.value;
  if (account === undefined) return;
  const open = async (): Promise<void> => {
    composeEpoch += 1;
    const generationAtOpen = composeEpoch;
    try {
      const opened = await gmail().openDraft({
        accountId: account.id,
        threadId,
        messageId: item.id,
        composerGeneration: generationAtOpen
      });
      if (accountId.value !== account.id) return;
      beginCompose(
        {
          accountId: account.id,
          from: account.email ?? '',
          kind: opened.kind,
          threadId: opened.threadId,
          messageId: opened.kind === 'new' ? null : item.id,
          to: opened.to,
          cc: opened.cc,
          bcc: opened.bcc,
          toDraft: '',
          ccDraft: '',
          bccDraft: '',
          showCc: opened.cc.length > 0,
          showBcc: opened.bcc.length > 0,
          subject: opened.subject,
          subjectLocked: opened.subjectLocked,
          body: opened.body,
          sending: false,
          error: '',
          unconfirmed: false,
          draftId: opened.draftId,
          expectedMessageId: opened.messageId,
          anchorThreadId: opened.threadId ?? threadId,
          attachments: opened.attachments,
          locked: opened.locked,
          readOnlyHtml: opened.locked ? item.html : null
        },
        generationAtOpen
      );
    } catch (error: unknown) {
      actionNotice.value =
        error instanceof GmailIpcError ? error.message : gmailErrorMessage('internal');
    }
  };
  if (compose.value !== null) askDiscard(() => void open());
  else {
    pushOpener(event);
    void open();
  }
}

async function pickFiles(): Promise<void> {
  const draft = compose.value;
  if (draft === null || draft.locked || draft.sending) return;
  try {
    const picked = await gmail().pickAttachments({
      accountId: draft.accountId,
      composerGeneration: draft.generation
    });
    if (compose.value === null || compose.value.generation !== draft.generation) return;
    compose.value.attachments = [...compose.value.attachments, ...picked.attachments];
    scheduleSave();
  } catch (error: unknown) {
    if (compose.value === null || compose.value.generation !== draft.generation) return;
    const failure = error instanceof GmailIpcError ? error.code : 'internal';
    compose.value.error =
      failure === 'too-large'
        ? 'This file is too large for Aurora to attach.'
        : error instanceof GmailIpcError
          ? error.message
          : gmailErrorMessage('internal');
  }
}

function removeFile(token: string): void {
  const draft = compose.value;
  if (draft === null || draft.locked || draft.sending) return;
  draft.attachments = draft.attachments.filter((file) => file.token !== token);
  void gmail()
    .dropAttachment({
      accountId: draft.accountId,
      composerGeneration: draft.generation,
      token
    })
    .catch(() => undefined);
  scheduleSave();
}

async function confirmDeleteDraft(): Promise<void> {
  const draft = compose.value;
  if (
    draft === null ||
    draft.draftId === null ||
    draft.expectedMessageId === null ||
    draft.sending
  ) {
    return;
  }
  draft.sending = true;
  try {
    await gmail().deleteDraft({
      accountId: draft.accountId,
      draftId: draft.draftId,
      expectedMessageId: draft.expectedMessageId
    });
    pendingDelete.value = false;
    closeCompose();
    composeStatus.value = 'Draft deleted.';
    if (labelId.value === 'DRAFT' && activeQuery.value === null && openId.value === null) {
      void reloadPage();
    }
  } catch (error: unknown) {
    if (compose.value === null) return;
    compose.value.sending = false;
    pendingDelete.value = false;
    const failure = error instanceof GmailIpcError ? error.code : 'internal';
    compose.value.error =
      failure === 'draft-conflict'
        ? gmailErrorMessage(failure)
        : 'Aurora could not delete this draft.';
    if (failure === 'draft-conflict') compose.value.conflict = true;
  }
}

async function downloadAttachment(
  messageId: string,
  attachment: GmailMessage['attachments'][number]
): Promise<void> {
  const key = `${messageId}:${attachment.partId ?? ''}:${attachment.attachmentId ?? ''}`;
  downloadKey.value = key;
  actionNotice.value = '';
  try {
    const saved = await gmail().downloadAttachment({
      accountId: accountId.value,
      messageId,
      partId: attachment.partId,
      attachmentId: attachment.attachmentId
    });
    if (saved.saved) actionNotice.value = 'Saved.';
  } catch (error: unknown) {
    actionNotice.value =
      error instanceof GmailIpcError ? error.message : gmailErrorMessage('internal');
  } finally {
    if (downloadKey.value === key) downloadKey.value = '';
  }
}

async function submitCompose(): Promise<void> {
  const draft = compose.value;
  if (draft === null || draft.sending || draft.locked) return;
  if (draft.conflict || draft.saveUnconfirmed) return;
  if (!commitAddresses('to') || !commitAddresses('cc') || !commitAddresses('bcc')) return;
  if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
    draft.error = 'Add at least one recipient.';
    return;
  }
  draft.sending = true;
  draft.error = '';
  draft.unconfirmed = false;
  clearSaveTimer();
  if (saveFlight !== null) {
    const saved = await saveFlight;
    if (!saved && (compose.value?.conflict === true || compose.value?.saveUnconfirmed === true)) {
      if (compose.value !== null) compose.value.sending = false;
      return;
    }
  }
  const current = compose.value;
  if (current === null || current.locked || current.generation !== draft.generation) return;
  if (current.attachments.length > 0 && current.draftId === null) {
    const created = await saveCompose(current.generation);
    if (!created) return;
  }
  const ready = compose.value;
  if (ready === null || ready.generation !== draft.generation) return;
  ready.sending = true;
  const generationAtSend = ready.generation;
  const accountAtSend = ready.accountId;
  const kind = ready.kind;
  try {
    const sent =
      ready.draftId === null
        ? await gmail().sendMessage({
            accountId: ready.accountId,
            kind: ready.kind,
            threadId: ready.threadId,
            messageId: ready.messageId,
            to: ready.to,
            cc: ready.cc,
            bcc: ready.bcc,
            subject: ready.subject,
            body: ready.body
          })
        : await gmail().sendDraft({
            accountId: ready.accountId,
            draftId: ready.draftId,
            expectedMessageId: ready.expectedMessageId,
            kind: ready.kind,
            threadId: ready.threadId,
            messageId: ready.messageId,
            to: ready.to,
            cc: ready.cc,
            bcc: ready.bcc,
            subject: ready.subject,
            body: ready.body,
            attachmentTokens: ready.attachments.map((file) => file.token),
            replaceConfirmed: false,
            composerGeneration: ready.generation
          });
    if (
      compose.value === null ||
      compose.value.generation !== generationAtSend ||
      compose.value.accountId !== accountAtSend
    ) {
      return;
    }
    compose.value = null;
    composeStatus.value = 'Message sent.';
    if (
      (kind === 'reply' || kind === 'reply-all') &&
      openId.value !== null &&
      (sent.threadId === null || sent.threadId === openId.value)
    ) {
      await openThread(openId.value);
      return;
    }
    if (activeQuery.value !== null) searchStale.value = true;
    else if (
      openId.value === null &&
      activeQuery.value === null &&
      (labelId.value === 'SENT' || labelId.value === 'DRAFT')
    ) {
      void reloadPage();
    }
  } catch (error) {
    if (compose.value === null || compose.value.generation !== generationAtSend) return;
    compose.value.sending = false;
    const failure = error instanceof GmailIpcError ? error.code : 'internal';
    compose.value.unconfirmed = failure === 'send-unconfirmed';
    if (failure === 'operation-in-progress') {
      compose.value.error = 'This message is already being sent.';
      return;
    }
    compose.value.error =
      failure === 'send-unconfirmed' ||
      failure === 'insufficient-scope' ||
      failure === 'needs-reauth'
        ? gmailErrorMessage(failure)
        : 'Aurora could not send this message.';
  }
}

function focusLive(selector: string): void {
  void nextTick(() => {
    void nextTick(() => {
      document.querySelector<HTMLElement>(selector)?.focus();
    });
  });
}

function focusElement(element: HTMLElement | null): void {
  void nextTick(() => {
    void nextTick(() => {
      if (element?.isConnected) element.focus();
    });
  });
}

function focusModal(name: MailModal): void {
  const selector =
    name === 'discard'
      ? '[aria-labelledby="discard-title"] button'
      : name === 'delete-draft'
        ? '[aria-labelledby="delete-draft-title"] button'
        : name === 'delete-label'
          ? '[aria-labelledby="delete-label-title"] button'
          : name === 'trash'
            ? '[aria-labelledby="trash-title"] button'
            : name === 'bulk-trash'
              ? '[aria-labelledby="bulk-trash-title"] button'
              : name === 'labels'
                ? '#new-label'
                : '';
  if (selector !== '') focusLive(selector);
}

function cancelActiveModal(): void {
  if (pendingDiscard.value !== null) {
    keepCompose();
    return;
  }
  if (pendingDelete.value) {
    pendingDelete.value = false;
    return;
  }
  if (deleteLabelTarget.value !== null) {
    deleteLabelTarget.value = null;
    return;
  }
  if (trashTarget.value !== null) {
    closeTrash();
    return;
  }
  if (bulkTrash.value) {
    bulkTrash.value = false;
    return;
  }
  if (labelsDialog.value) {
    labelsDialog.value = false;
    return;
  }
  requestCloseCompose();
}

function trapModalTab(event: KeyboardEvent): void {
  const root = document.querySelector<HTMLElement>('[data-mail-modal="active"]');
  if (root === null) return;
  const items = [
    ...root.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href]')
  ].filter((item) => !item.hasAttribute('disabled'));
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function closeLabelMenu(): void {
  labelsOpen.value = false;
  focusElement(conversationLabelsButton.value);
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (activeModal.value !== null) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelActiveModal();
      return;
    }
    if (event.key === 'Tab') trapModalTab(event);
    return;
  }
  if (event.key === 'Escape' && labelsOpen.value) {
    event.preventDefault();
    closeLabelMenu();
  }
}

function onBodyKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void submitCompose();
  }
}

watch([someVisibleSelected, selectAllBox], () => {
  if (selectAllBox.value !== null) selectAllBox.value.indeterminate = someVisibleSelected.value;
});

watch(activeModal, (next, previous) => {
  if (previous === 'discard' && next === 'compose') {
    focusElement(discardOpener);
    return;
  }
  if (previous === 'delete-draft' && next === 'compose') {
    focusElement(deleteDraftOpener);
    return;
  }
  if (previous === 'delete-label' && next === 'labels') {
    focusLive(`#delete-label-${deleteLabelReturnId ?? ''}`);
    return;
  }
  if (next === null) {
    popOpener();
    return;
  }
  if (next === 'compose') return;
  void nextTick(() => focusModal(next));
});

function onHtmlClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest('a');
  if (anchor === null) return;
  event.preventDefault();
  const href = anchor.getAttribute('href');
  if (href === null || href.length === 0) return;
  void gmail()
    .openLink(href)
    .catch((error: unknown) => {
      detail.value = error instanceof GmailIpcError ? error.message : gmailErrorMessage('internal');
    });
}

function syncBusy(): boolean {
  return syncState.value?.state === 'bootstrapping' || syncState.value?.state === 'syncing';
}

function relativeTime(iso: string, current: number): string {
  const delta = current - Date.parse(iso);
  if (!Number.isFinite(delta) || delta < 60_000) return 'just now';
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  const hours = Math.round(delta / 3_600_000);
  if (hours < 24) return formatter.format(-hours, 'hour');
  return formatter.format(-Math.round(delta / 86_400_000), 'day');
}

const syncLine = computed(() => {
  if (visibleStale.value) return '';
  const current = syncState.value;
  if (current === null) return syncStatusFailed.value ? 'Aurora could not reach Google.' : '';
  if (current.notificationsBlocked) return 'Windows is not showing Aurora notifications.';
  if (current.state === 'bootstrapping' || current.state === 'syncing')
    return 'Checking for new mail';
  if (current.state === 'offline') return 'Aurora could not reach Google.';
  if (current.state === 'needs-reauth' || current.lastSuccessAt === null) return '';
  return `Updated ${relativeTime(current.lastSuccessAt, syncNow.value)}`;
});

const notificationsOn = computed(() => syncState.value?.notifications === 'on');
const contentShown = computed(() => syncState.value?.content === 'show');

function syncFailureMessage(error: unknown): string {
  return error instanceof GmailIpcError ? error.message : gmailErrorMessage('internal');
}

function noteVisibleRefreshFailure(error: unknown): void {
  visibleStale.value = true;
  refreshMessage = syncFailureMessage(error);
  actionNotice.value = refreshMessage;
}

function noteVisibleRefreshSuccess(): void {
  visibleStale.value = false;
  if (refreshMessage !== '' && actionNotice.value === refreshMessage) actionNotice.value = '';
  refreshMessage = '';
}

async function loadSyncStatus(): Promise<void> {
  if (accountId.value === '') return;
  const account = accountId.value;
  try {
    const next = await gmail().syncStatus(account);
    if (account !== accountId.value) return;
    syncState.value = next;
    syncStatusFailed.value = false;
  } catch {
    if (account !== accountId.value) return;
    if (syncState.value === null) syncStatusFailed.value = true;
  }
}

function publishView(): void {
  const view =
    accountId.value === ''
      ? { accountId: null, labelId: null, query: null, threadId: null }
      : {
          accountId: accountId.value,
          labelId: activeQuery.value === null ? labelId.value : null,
          query: activeQuery.value,
          threadId: openId.value
        };
  void gmail()
    .reportSyncView(view)
    .catch(() => undefined);
}

async function recoverVisibleMailbox(): Promise<void> {
  if (visibleRecovery !== null) return visibleRecovery;
  let tracked: Promise<void> = Promise.resolve();
  const run = (async () => {
    const gen = generation;
    const account = accountId.value;
    try {
      const listed = await gmail().listLabels(account);
      if (gen !== generation || account !== accountId.value) return;
      labels.value = listed.labels;
      const page = await gmail().listThreads({
        accountId: account,
        labelId: activeQuery.value === null ? labelId.value : null,
        query: activeQuery.value,
        pageToken: pageTokens.value[pageIndex.value] ?? null
      });
      if (gen !== generation || account !== accountId.value) return;
      threads.value = page.threads;
      nextPageToken.value = page.nextPageToken;
      if (openId.value !== null) {
        const thread = await gmail().readThread(account, openId.value);
        if (gen !== generation || openId.value === null) return;
        messages.value = thread.messages;
      }
      noteVisibleRefreshSuccess();
    } catch (error) {
      if (gen !== generation || account !== accountId.value) return;
      noteVisibleRefreshFailure(error);
    }
  })();
  tracked = run.finally(() => {
    if (visibleRecovery === tracked) visibleRecovery = null;
  });
  visibleRecovery = tracked;
  return tracked;
}

async function applySync(event: GmailSyncChanged): Promise<void> {
  if (event.accountId !== accountId.value) return;
  await loadSyncStatus();
  if (event.accountId !== accountId.value) return;
  if (event.refresh === 'none') {
    if (visibleStale.value) await recoverVisibleMailbox();
    return;
  }
  const gen = generation;
  try {
    if (event.refresh === 'labels' || event.refresh === 'page' || event.refresh === 'thread') {
      const listed = await gmail().listLabels(accountId.value);
      if (gen !== generation || event.accountId !== accountId.value) return;
      labels.value = listed.labels;
    }
    if (event.refresh === 'page') {
      const page = await gmail().listThreads({
        accountId: accountId.value,
        labelId: activeQuery.value === null ? labelId.value : null,
        query: activeQuery.value,
        pageToken: pageTokens.value[pageIndex.value] ?? null
      });
      if (gen !== generation || event.accountId !== accountId.value) return;
      threads.value = page.threads;
      nextPageToken.value = page.nextPageToken;
      if (openId.value !== null && event.threadId === openId.value) {
        const thread = await gmail().readThread(accountId.value, openId.value);
        if (gen !== generation || openId.value === null) return;
        messages.value = thread.messages;
      }
    }
    if (event.refresh === 'thread' && event.threadId !== null && openId.value === event.threadId) {
      const thread = await gmail().readThread(accountId.value, event.threadId);
      if (gen !== generation || openId.value !== event.threadId) return;
      messages.value = thread.messages;
    }
    if (gen !== generation || event.accountId !== accountId.value) return;
    noteVisibleRefreshSuccess();
  } catch (error) {
    if (gen !== generation || event.accountId !== accountId.value) return;
    noteVisibleRefreshFailure(error);
  }
}

function onWindowFocus(): void {
  if (accountId.value === '') return;
  void gmail()
    .syncFocus(accountId.value)
    .then((next) => {
      if (accountId.value !== '') syncState.value = next;
    })
    .catch(() => undefined)
    .finally(() => {
      if (visibleStale.value && accountId.value !== '') void recoverVisibleMailbox();
    });
}

async function saveNotificationPreference(
  notifications: 'on' | 'off',
  content: 'show' | 'hide'
): Promise<void> {
  if (accountId.value === '') return;
  try {
    syncState.value = await gmail().setNotifications({
      accountId: accountId.value,
      notifications,
      content
    });
  } catch (error) {
    if (error instanceof GmailIpcError) actionNotice.value = error.message;
  }
}

function toggleNotifications(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || syncState.value === null) return;
  void saveNotificationPreference(input.checked ? 'on' : 'off', syncState.value.content);
}

function toggleContent(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || syncState.value === null) return;
  void saveNotificationPreference(syncState.value.notifications, input.checked ? 'show' : 'hide');
}

async function openNotified(target: { accountId: string; threadId: string }): Promise<void> {
  if (!isGmailId(target.threadId)) return;
  if (!accounts.value.some((item) => item.id === target.accountId && item.status === 'connected')) {
    return;
  }
  const apply = async (): Promise<void> => {
    accountId.value = target.accountId;
    searchText.value = '';
    activeQuery.value = null;
    labelId.value = 'INBOX';
    resetPages();
    await startList();
    if (accountId.value !== target.accountId) return;
    await openThread(target.threadId);
  };
  if (compose.value !== null) {
    askDiscard(() => {
      void apply();
    });
    return;
  }
  await apply();
}

function queueNotificationOpen(): void {
  const target = pendingMailOpen.value;
  if (target === null) return;
  queuedOpen = target;
  pendingMailOpen.value = null;
}

async function drainNotificationOpen(): Promise<void> {
  queueNotificationOpen();
  const target = queuedOpen;
  if (target === null || accounts.value.length === 0) return;
  queuedOpen = null;
  await openNotified(target);
}

onBeforeRouteLeave((to) => {
  if (compose.value === null || !composeDirty()) return true;
  askDiscard(() => {
    void router.push(to.fullPath);
  });
  return false;
});

onMounted(() => {
  window.addEventListener('beforeunload', warnBeforeUnload);
  window.addEventListener('keydown', onWindowKeydown);
  window.addEventListener('focus', onWindowFocus);
  stopSyncListen = gmail().listenSync((event) => {
    void applySync(event);
  });
  syncClock = window.setInterval(() => {
    syncNow.value = Date.now();
  }, 30_000);
  void google()
    .listAccounts()
    .then(async (list) => {
      accounts.value = list.accounts;
      const first = list.accounts.find((account) => account.status === 'connected');
      if (first === undefined) {
        status.value = 'ready';
        return;
      }
      accountId.value = first.id;
      await startList();
      await drainNotificationOpen();
    })
    .catch((error: unknown) => {
      fail(error);
    });
});

onUnmounted(() => {
  clearSaveTimer();
  window.removeEventListener('beforeunload', warnBeforeUnload);
  window.removeEventListener('keydown', onWindowKeydown);
  window.removeEventListener('focus', onWindowFocus);
  stopSyncListen();
  window.clearInterval(syncClock);
});

watch([accountId, labelId, activeQuery, openId], () => {
  publishView();
});

watch(accountId, () => {
  syncState.value = null;
  syncStatusFailed.value = false;
  visibleStale.value = false;
  refreshMessage = '';
  void loadSyncStatus();
});

watch(pendingMailOpen, () => {
  void drainNotificationOpen();
});
</script>

<template>
  <div class="mail-screen" :class="{ 'is-reading': openId !== null }">
    <div class="mail-content" :inert="activeModal !== null ? true : undefined">
      <h1 v-if="openId === null" class="page-title">Mail</h1>
      <StatusPanel
        v-if="connectedAccounts.length === 0 && status !== 'loading'"
        kind="empty"
        title="No connected account"
        message="Connect a Google account in Integrations before reading mail."
      />
      <template v-else>
        <div v-if="openId === null" class="mail-toolbar">
          <button class="control" type="button" @click="requestNewMessage($event)">
            <SquarePen :size="16" :stroke-width="1.75" aria-hidden="true" />
            Compose
          </button>
          <div class="account-field">
            <select
              class="field field-select"
              :value="accountId"
              aria-label="Google account"
              @change="chooseAccount"
            >
              <option
                v-for="account in accounts"
                :key="account.id"
                :value="account.id"
                :disabled="account.status !== 'connected'"
              >
                {{ accountLabel(account) }}
              </option>
            </select>
            <ChevronsUpDown class="field-icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
          </div>
          <form @submit.prevent="submitSearch">
            <div class="search-field">
              <Search class="field-icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
              <input
                v-model="searchText"
                class="field field-text"
                type="search"
                aria-label="Search Gmail"
                placeholder="Search Gmail"
                :disabled="status === 'loading'"
              />
            </div>
            <button
              class="control control-accent"
              type="submit"
              :disabled="status === 'loading'"
              :aria-busy="status === 'loading' ? 'true' : undefined"
            >
              Search
            </button>
          </form>
        </div>
        <div v-if="accountId !== ''" class="mail-sync">
          <p v-if="syncState?.state === 'needs-reauth'" role="status">
            Reconnect this Google account before changing mail.
            <RouterLink class="text-link" to="/integrations">Reconnect</RouterLink>
          </p>
          <p v-else-if="syncLine !== ''" role="status" :aria-busy="syncBusy() ? 'true' : undefined">
            {{ syncLine }}
          </p>
          <label class="choice">
            <input
              type="checkbox"
              :checked="notificationsOn"
              :disabled="syncState === null"
              aria-label="Notify me of new mail"
              @change="toggleNotifications"
            />
            Notify me of new mail
          </label>
          <label class="choice">
            <input
              type="checkbox"
              :checked="contentShown"
              :disabled="syncState === null"
              aria-label="Show sender and subject"
              @change="toggleContent"
            />
            Show sender and subject
          </label>
        </div>
        <p v-if="composeStatus" role="status">{{ composeStatus }}</p>
        <p v-if="actionNotice && openId === null" role="alert">{{ actionNotice }}</p>
        <div
          v-if="openId === null"
          class="mail-workspace"
          :class="{ 'is-folders-open': foldersExpanded }"
        >
          <div class="mail-folder-bar">
            <button
              class="control mail-folder-toggle"
              type="button"
              aria-label="Folders"
              :aria-expanded="foldersExpanded"
              @click="foldersExpanded = !foldersExpanded"
            >
              <PanelLeft :size="16" :stroke-width="1.75" aria-hidden="true" />
            </button>
            <nav class="mail-folders" aria-label="Labels">
              <button
                v-for="label in labels"
                :key="label.id"
                class="folder-button"
                type="button"
                :aria-pressed="folderSelected(label.id)"
                :disabled="status === 'loading'"
                @click="chooseLabel(label.id)"
              >
                <component
                  :is="folderIcon(label)"
                  :size="16"
                  :stroke-width="1.75"
                  aria-hidden="true"
                />
                <span class="folder-name">{{ label.name }}</span>
                <span v-if="label.unreadCount !== null" class="folder-count">{{
                  label.unreadCount
                }}</span>
              </button>
            </nav>
            <button
              v-if="canChangeMail()"
              class="control mail-labels-button"
              type="button"
              aria-label="Labels"
              :disabled="status === 'loading' || labelBusy"
              @click="openLabelDialog($event)"
            >
              <Tag :size="16" :stroke-width="1.75" aria-hidden="true" />
              <span class="mail-labels-name">Labels</span>
            </button>
          </div>
          <div class="mail-stage">
            <StatusPanel
              v-if="status === 'loading'"
              kind="loading"
              title="Loading"
              message="Loading conversations."
            />
            <template v-else-if="status === 'error'">
              <StatusPanel kind="error" title="Mail is unavailable" :message="detail" />
              <RouterLink v-if="showRecovery" class="text-link" to="/integrations">
                Integrations
              </RouterLink>
            </template>
            <template v-else>
              <p v-if="selectedAccount && selectedAccount.canModifyMail !== true" role="status">
                Reconnect this Google account before changing mail.
                <RouterLink class="text-link" to="/integrations">Reconnect</RouterLink>
              </p>
              <p v-if="actionNotice" role="alert">{{ actionNotice }}</p>
              <p v-if="searchStale" role="status">
                These search results may no longer match Gmail.
                <button class="control" type="button" @click="refreshSearch">Refresh</button>
              </p>
              <p v-if="activeQuery !== null" class="text-sm text-muted" role="status">
                Search results
              </p>
              <div v-if="canChangeMail()" class="mail-select-bar">
                <label class="mail-check">
                  <input
                    ref="selectAllBox"
                    type="checkbox"
                    :checked="allVisibleSelected"
                    :aria-checked="
                      someVisibleSelected ? 'mixed' : allVisibleSelected ? 'true' : 'false'
                    "
                    aria-label="Select all visible conversations"
                    :disabled="threads.length === 0 || bulkBusy"
                    @change="toggleAllVisible"
                  />
                </label>
                <span v-if="selectedCount > 0">{{ selectedCount }} selected</span>
                <button
                  v-if="selectedCount > 0"
                  class="control"
                  type="button"
                  :disabled="bulkBusy"
                  @click="clearSelection"
                >
                  Clear selection
                </button>
              </div>
              <div
                v-if="canChangeMail() && selectedCount > 0"
                class="mail-bulk"
                :aria-busy="bulkBusy ? 'true' : undefined"
              >
                <button
                  class="control"
                  type="button"
                  :disabled="bulkBusy"
                  @click="bulkThreads('read')"
                >
                  Mark as read
                </button>
                <button
                  class="control"
                  type="button"
                  :disabled="bulkBusy"
                  @click="bulkThreads('unread')"
                >
                  Mark as unread
                </button>
                <button
                  v-if="labelId === 'INBOX' || activeQuery !== null"
                  class="control"
                  type="button"
                  :disabled="bulkBusy"
                  @click="bulkThreads('archive')"
                >
                  Archive
                </button>
                <button
                  v-if="labelId === 'TRASH'"
                  class="control"
                  type="button"
                  :disabled="bulkBusy"
                  @click="bulkThreads('untrash')"
                >
                  Restore
                </button>
                <button
                  v-if="labelId !== 'TRASH'"
                  class="control control-danger"
                  type="button"
                  :disabled="bulkBusy"
                  @click="openBulkTrash($event)"
                >
                  Move to Trash
                </button>
                <button
                  class="control"
                  type="button"
                  :disabled="bulkBusy"
                  aria-describedby="bulk-star-note"
                  @click="bulkThreads('star')"
                >
                  Star
                </button>
                <button
                  class="control"
                  type="button"
                  :disabled="bulkBusy"
                  aria-describedby="bulk-star-note"
                  @click="bulkThreads('unstar')"
                >
                  Unstar
                </button>
                <p id="bulk-star-note" class="text-sm text-muted">
                  Star marks only the newest message in each conversation. Unstar removes the star
                  from messages that already have one, up to 50 per conversation. A conversation
                  with more starred messages is not reported as fully updated.
                </p>
                <label v-if="userLabels.length > 0" class="mail-bulk-label">
                  Label
                  <select
                    id="bulk-label"
                    v-model="bulkLabelId"
                    class="field field-select"
                    :disabled="bulkBusy"
                  >
                    <option value="">Choose a label</option>
                    <option v-for="label in userLabels" :key="label.id" :value="label.id">
                      {{ label.name }}
                    </option>
                  </select>
                </label>
                <button
                  v-if="userLabels.length > 0"
                  class="control"
                  type="button"
                  :disabled="bulkBusy || bulkLabelId.length === 0"
                  @click="bulkUserLabel('add')"
                >
                  Add
                </button>
                <button
                  v-if="userLabels.length > 0"
                  class="control"
                  type="button"
                  :disabled="bulkBusy || bulkLabelId.length === 0"
                  @click="bulkUserLabel('remove')"
                >
                  Remove
                </button>
                <p v-else class="text-sm text-muted">No labels. Open Labels to create one.</p>
              </div>
              <p v-if="bulkStatus" role="status">{{ bulkStatus }}</p>
              <StatusPanel
                v-if="threads.length === 0"
                kind="empty"
                title="No conversations"
                message="This mailbox has no conversations to show."
              />
              <div v-else class="mail-list">
                <ul class="mail-rows">
                  <li
                    v-for="thread in threads"
                    :key="thread.id"
                    class="mail-row-line"
                    :class="{ 'has-select': canChangeMail() }"
                  >
                    <label v-if="canChangeMail()" class="mail-check">
                      <input
                        type="checkbox"
                        :checked="rowSelected(thread.id)"
                        :aria-label="`Select ${thread.subject ?? '(no subject)'}`"
                        :disabled="bulkBusy"
                        @change="toggleRow(thread.id)"
                      />
                    </label>
                    <button
                      class="mail-row"
                      :class="{ 'is-unread': thread.unread }"
                      type="button"
                      @click="openThread(thread.id)"
                    >
                      <span
                        class="mail-unread"
                        :class="{ 'is-on': thread.unread }"
                        aria-hidden="true"
                      ></span>
                      <span class="mail-copy">
                        <span class="mail-line-primary">
                          <Star
                            v-if="thread.starred"
                            class="mail-star"
                            :size="16"
                            :stroke-width="1.75"
                            aria-hidden="true"
                          />
                          <span class="mail-subject">{{ thread.subject ?? '(no subject)' }}</span>
                          <span v-if="thread.snippet" class="mail-snippet">{{
                            thread.snippet
                          }}</span>
                        </span>
                        <span class="mail-line-secondary">
                          <span class="mail-sender">{{ thread.from }}</span>
                          <span class="mail-date">{{ formatDate(thread.date) }}</span>
                        </span>
                      </span>
                      <span v-if="thread.unread" class="sr-only">Unread</span>
                      <span v-if="thread.starred" class="sr-only">Starred</span>
                    </button>
                    <div
                      class="mail-row-actions"
                      :aria-busy="threadBusy(thread.id) ? 'true' : undefined"
                    >
                      <button
                        class="control"
                        type="button"
                        :aria-label="thread.unread ? 'Mark as read' : 'Mark as unread'"
                        :disabled="threadBusy(thread.id) || bulkBusy"
                        @click="changeRead(thread.id, !thread.unread)"
                      >
                        <MailOpen
                          v-if="thread.unread"
                          :size="16"
                          :stroke-width="1.75"
                          aria-hidden="true"
                        />
                        <Mail v-else :size="16" :stroke-width="1.75" aria-hidden="true" />
                      </button>
                      <button
                        v-if="labelId === 'TRASH'"
                        class="control"
                        type="button"
                        aria-label="Restore"
                        :disabled="threadBusy(thread.id) || bulkBusy"
                        @click="restoreConversation(thread.id)"
                      >
                        <RotateCcw :size="16" :stroke-width="1.75" aria-hidden="true" />
                      </button>
                      <button
                        v-else-if="labelId === 'INBOX' || activeQuery !== null"
                        class="control"
                        type="button"
                        aria-label="Archive"
                        :disabled="threadBusy(thread.id) || bulkBusy"
                        @click="archiveConversation(thread.id)"
                      >
                        <Archive :size="16" :stroke-width="1.75" aria-hidden="true" />
                      </button>
                      <button
                        v-if="labelId !== 'TRASH'"
                        class="control control-danger"
                        type="button"
                        aria-label="Move to Trash"
                        :disabled="threadBusy(thread.id) || bulkBusy"
                        @click="askTrash(thread.id, $event)"
                      >
                        <Trash2 :size="16" :stroke-width="1.75" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                </ul>
              </div>
              <div class="mail-pager">
                <button
                  class="control"
                  type="button"
                  :disabled="pageIndex === 0"
                  @click="showPrevious"
                >
                  Previous
                </button>
                <button
                  class="control"
                  type="button"
                  :disabled="nextPageToken === null"
                  @click="showNext"
                >
                  Next
                </button>
              </div>
            </template>
          </div>
        </div>
        <div v-else class="mail-stage">
          <div class="conversation-header">
            <button class="control" type="button" @click="back">
              <ChevronLeft :size="16" :stroke-width="1.75" aria-hidden="true" />
              Back
            </button>
            <button class="control" type="button" @click="requestNewMessage($event)">
              <SquarePen :size="16" :stroke-width="1.75" aria-hidden="true" />
              Compose
            </button>
            <h2 class="conversation-subject">{{ conversationSubject }}</h2>
            <p class="conversation-date">{{ formatDate(conversationDate) }}</p>
          </div>
          <div class="conversation-actions">
            <button
              class="control"
              type="button"
              :disabled="openId !== null && threadBusy(openId)"
              :aria-busy="openId !== null && threadBusy(openId) ? 'true' : undefined"
              @click="changeRead(openId ?? '', !conversationUnread)"
            >
              <MailOpen
                v-if="conversationUnread"
                :size="16"
                :stroke-width="1.75"
                aria-hidden="true"
              />
              <Mail v-else :size="16" :stroke-width="1.75" aria-hidden="true" />
              {{ conversationUnread ? 'Mark read' : 'Mark unread' }}
            </button>
            <button
              v-if="conversationInTrash"
              class="control"
              type="button"
              :disabled="openId !== null && threadBusy(openId)"
              @click="restoreConversation(openId ?? '')"
            >
              <RotateCcw :size="16" :stroke-width="1.75" aria-hidden="true" />
              Restore
            </button>
            <button
              v-else-if="conversationInInbox"
              class="control"
              type="button"
              :disabled="openId !== null && threadBusy(openId)"
              @click="archiveConversation(openId ?? '')"
            >
              <Archive :size="16" :stroke-width="1.75" aria-hidden="true" />
              Archive
            </button>
            <button
              v-if="!conversationInTrash"
              class="control control-danger"
              type="button"
              :disabled="openId !== null && threadBusy(openId)"
              @click="askTrash(openId ?? '', $event)"
            >
              <Trash2 :size="16" :stroke-width="1.75" aria-hidden="true" />
              Trash
            </button>
            <button
              ref="conversationLabelsButton"
              class="control"
              type="button"
              :aria-expanded="labelsOpen"
              @click="labelsOpen = !labelsOpen"
            >
              <Tag :size="16" :stroke-width="1.75" aria-hidden="true" />
              Labels
            </button>
          </div>
          <p v-if="selectedAccount && selectedAccount.canModifyMail !== true" role="status">
            Reconnect this Google account before changing mail.
            <RouterLink class="text-link" to="/integrations">Reconnect</RouterLink>
          </p>
          <p v-if="actionNotice && openId !== null" role="alert">{{ actionNotice }}</p>
          <div v-if="labelsOpen" class="label-menu" role="group" aria-label="Labels">
            <p v-if="userLabels.length === 0">No labels</p>
            <button
              v-for="label in userLabels"
              :key="label.id"
              class="control"
              type="button"
              :aria-pressed="labelApplied(label.id)"
              :disabled="openId !== null && threadBusy(openId)"
              @click="toggleUserLabel(label)"
              @keydown.enter.prevent="toggleUserLabel(label)"
              @keydown.space.prevent="toggleUserLabel(label)"
            >
              {{ label.name }}
            </button>
          </div>
          <StatusPanel
            v-if="status === 'loading'"
            kind="loading"
            title="Loading"
            message="Loading the conversation."
          />
          <template v-else-if="status === 'error'">
            <StatusPanel kind="error" title="Mail is unavailable" :message="detail" />
            <RouterLink v-if="showRecovery" class="text-link" to="/integrations">
              Integrations
            </RouterLink>
          </template>
          <article v-for="item in messages" v-else :key="item.id" class="mail-message">
            <div class="mail-meta">
              <p class="mail-meta-line" :class="{ 'is-open': expandedMeta[item.id] === true }">
                <span v-if="item.unread">Unread </span>
                <span>From {{ item.from }}</span>
                <span v-if="item.to"> To {{ item.to }}</span>
                <span v-if="item.cc"> Cc {{ item.cc }}</span>
                <span v-if="item.bcc"> Bcc {{ item.bcc }}</span>
              </p>
              <button
                class="control"
                type="button"
                :aria-pressed="item.starred"
                :aria-label="item.starred ? 'Remove star' : 'Star'"
                :disabled="openId !== null && threadBusy(openId)"
                @click="changeStar(item)"
              >
                <Star :size="16" :stroke-width="1.75" aria-hidden="true" />
              </button>
              <button
                v-if="item.labelIds.includes('DRAFT')"
                class="control"
                type="button"
                @click="requestEdit(item, $event)"
              >
                <File :size="16" :stroke-width="1.75" aria-hidden="true" />
                Edit draft
              </button>
              <button class="control" type="button" @click="requestSeed('reply', item, $event)">
                <Reply :size="16" :stroke-width="1.75" aria-hidden="true" />
                Reply
              </button>
              <button class="control" type="button" @click="requestSeed('reply-all', item, $event)">
                <ReplyAll :size="16" :stroke-width="1.75" aria-hidden="true" />
                Reply all
              </button>
              <button class="control" type="button" @click="requestSeed('forward', item, $event)">
                <Forward :size="16" :stroke-width="1.75" aria-hidden="true" />
                Forward
              </button>
              <button
                v-if="hasRecipients(item)"
                class="control"
                type="button"
                @click="toggleMeta(item.id)"
              >
                {{ expandedMeta[item.id] === true ? 'Hide details' : 'Show details' }}
              </button>
            </div>
            <div
              v-if="item.html"
              class="mail-reading mail-body"
              @click="onHtmlClick"
              v-html="item.html"
            />
            <p v-else-if="item.text" class="mail-reading mail-body mail-plain">{{ item.text }}</p>
            <p v-if="item.imagesOmitted" class="mail-note">
              Images in this message were not loaded.
            </p>
            <ul v-if="item.attachments.length > 0" class="mail-attachments">
              <li
                v-for="attachment in item.attachments"
                :key="attachment.fileName + attachment.size"
                class="mail-attachment"
              >
                <Paperclip :size="16" :stroke-width="1.75" aria-hidden="true" />
                {{ attachment.fileName }} · {{ attachment.mimeType }} · {{ attachment.size }}
                <button
                  v-if="attachment.attachmentId !== null || attachment.partId !== null"
                  class="control"
                  type="button"
                  :aria-busy="
                    downloadKey ===
                    `${item.id}:${attachment.partId ?? ''}:${attachment.attachmentId ?? ''}`
                      ? 'true'
                      : undefined
                  "
                  :disabled="
                    downloadKey ===
                    `${item.id}:${attachment.partId ?? ''}:${attachment.attachmentId ?? ''}`
                  "
                  @click="downloadAttachment(item.id, attachment)"
                >
                  Download
                </button>
              </li>
            </ul>
          </article>
        </div>
      </template>
    </div>
    <div
      v-if="activeModal !== null"
      class="mail-backdrop"
      tabindex="-1"
      @mousedown.prevent
      @click.prevent
    />
    <div
      v-if="bulkTrash"
      class="mail-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-trash-title"
      :data-mail-modal="activeModal === 'bulk-trash' ? 'active' : 'inactive'"
    >
      <h2 id="bulk-trash-title">Move {{ selectedCount }} conversations to Trash?</h2>
      <p>You can restore these conversations from Trash.</p>
      <button ref="cancelBulkTrashButton" class="control" type="button" @click="bulkTrash = false">
        Cancel
      </button>
      <button class="control control-danger" type="button" @click="confirmBulkTrash">
        Move to Trash
      </button>
    </div>
    <div
      v-if="labelsDialog && deleteLabelTarget === null"
      class="mail-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="labels-title"
      :data-mail-modal="activeModal === 'labels' ? 'active' : 'inactive'"
    >
      <h2 id="labels-title">Labels</h2>
      <p v-if="labelNotice" role="status">{{ labelNotice }}</p>
      <label for="new-label">Name</label>
      <input
        id="new-label"
        ref="labelNameInput"
        v-model="labelName"
        class="field field-text"
        type="text"
        maxlength="225"
        aria-label="Label name"
        :disabled="labelBusy"
      />
      <button class="control" type="button" :disabled="labelBusy" @click="createUserLabel">
        Create
      </button>
      <ul class="mail-label-editor">
        <li v-for="label in userLabels" :key="label.id">
          <span>{{ label.name }}</span>
          <template v-if="renameId === label.id">
            <input
              v-model="renameName"
              class="field field-text"
              type="text"
              maxlength="225"
              :aria-label="`New name for ${label.name}`"
              :disabled="labelBusy"
            />
            <button
              class="control"
              type="button"
              :disabled="labelBusy"
              @click="renameUserLabel(label)"
            >
              Rename
            </button>
            <button class="control" type="button" :disabled="labelBusy" @click="renameId = null">
              Cancel
            </button>
          </template>
          <template v-else>
            <button class="control" type="button" :disabled="labelBusy" @click="startRename(label)">
              Rename
            </button>
            <button
              :id="`delete-label-${label.id}`"
              class="control control-danger"
              type="button"
              :disabled="labelBusy"
              @click="askDeleteLabel(label)"
            >
              Delete
            </button>
          </template>
        </li>
      </ul>
      <button class="control" type="button" @click="labelsDialog = false">Close</button>
    </div>
    <div
      v-if="deleteLabelTarget !== null"
      class="mail-dialog mail-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-label-title"
      data-mail-modal="active"
    >
      <h2 id="delete-label-title">Delete {{ deleteLabelTarget.name }}?</h2>
      <p>Gmail will remove this label from every conversation. Messages stay in Gmail.</p>
      <button
        ref="cancelDeleteLabelButton"
        class="control"
        type="button"
        @click="deleteLabelTarget = null"
      >
        Cancel
      </button>
      <button class="control control-danger" type="button" @click="confirmDeleteLabel">
        Delete label
      </button>
    </div>
    <div
      v-if="trashTarget !== null"
      class="mail-dialog mail-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trash-title"
      data-mail-modal="active"
    >
      <h2 id="trash-title">Move to Trash?</h2>
      <p>You can restore this conversation from Trash.</p>
      <button ref="cancelTrashButton" class="control" type="button" @click="closeTrash">
        Cancel
      </button>
      <button class="control control-danger" type="button" @click="confirmTrash">
        Move to Trash
      </button>
    </div>
    <div
      v-if="compose !== null"
      class="mail-dialog mail-composer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compose-title"
      :data-mail-modal="activeModal === 'compose' ? 'active' : 'inactive'"
      :inert="activeModal === 'compose' ? undefined : true"
    >
      <h2 id="compose-title">{{ compose.locked ? 'Draft' : composeTitle(compose.kind) }}</h2>
      <p v-if="composeStatus" role="status">{{ composeStatus }}</p>
      <div class="compose-row">
        <span>From</span>
        <p>{{ compose.from }}</p>
      </div>
      <div class="compose-row">
        <label for="compose-to">To</label>
        <div class="compose-addresses">
          <span v-for="address in compose.to" :key="address" class="compose-chip">
            {{ address }}
            <button
              class="control"
              type="button"
              :aria-label="`Remove ${address}`"
              :disabled="compose.sending || compose.locked"
              @click="removeAddress('to', address)"
            >
              Remove
            </button>
          </span>
          <input
            id="compose-to"
            ref="composeToInput"
            class="field field-text"
            type="email"
            aria-label="To"
            :value="compose.toDraft"
            :disabled="compose.sending || compose.locked"
            @input="setComposeInput('toDraft', $event)"
            @keydown.enter.prevent="commitAddresses('to')"
            @blur="commitAddresses('to')"
            @paste="pasteAddresses('to', $event)"
          />
        </div>
      </div>
      <div class="compose-row">
        <button
          class="control"
          type="button"
          :disabled="compose.sending"
          @click="compose.showCc = true"
        >
          Cc
        </button>
        <button
          class="control"
          type="button"
          :disabled="compose.sending"
          @click="compose.showBcc = true"
        >
          Bcc
        </button>
      </div>
      <div v-if="compose.showCc" class="compose-row">
        <label for="compose-cc">Cc</label>
        <div class="compose-addresses">
          <span v-for="address in compose.cc" :key="address" class="compose-chip">
            {{ address }}
            <button
              class="control"
              type="button"
              :aria-label="`Remove ${address}`"
              :disabled="compose.sending || compose.locked"
              @click="removeAddress('cc', address)"
            >
              Remove
            </button>
          </span>
          <input
            id="compose-cc"
            class="field field-text"
            type="email"
            aria-label="Cc"
            :value="compose.ccDraft"
            :disabled="compose.sending || compose.locked"
            @input="setComposeInput('ccDraft', $event)"
            @keydown.enter.prevent="commitAddresses('cc')"
            @blur="commitAddresses('cc')"
            @paste="pasteAddresses('cc', $event)"
          />
        </div>
      </div>
      <div v-if="compose.showBcc" class="compose-row">
        <label for="compose-bcc">Bcc</label>
        <div class="compose-addresses">
          <span v-for="address in compose.bcc" :key="address" class="compose-chip">
            {{ address }}
            <button
              class="control"
              type="button"
              :aria-label="`Remove ${address}`"
              :disabled="compose.sending || compose.locked"
              @click="removeAddress('bcc', address)"
            >
              Remove
            </button>
          </span>
          <input
            id="compose-bcc"
            class="field field-text"
            type="email"
            aria-label="Bcc"
            :value="compose.bccDraft"
            :disabled="compose.sending || compose.locked"
            @input="setComposeInput('bccDraft', $event)"
            @keydown.enter.prevent="commitAddresses('bcc')"
            @blur="commitAddresses('bcc')"
            @paste="pasteAddresses('bcc', $event)"
          />
        </div>
      </div>
      <div class="compose-row">
        <label for="compose-subject">Subject</label>
        <input
          v-if="!compose.subjectLocked"
          id="compose-subject"
          class="field field-text"
          type="text"
          maxlength="998"
          aria-label="Subject"
          :value="compose.subject"
          :disabled="compose.sending || compose.locked"
          @input="setComposeInput('subject', $event)"
        />
        <p v-else id="compose-subject">{{ compose.subject }}</p>
      </div>
      <div
        v-if="compose.readOnlyHtml"
        class="mail-reading mail-body"
        v-html="compose.readOnlyHtml"
      />
      <textarea
        v-else
        ref="composeBodyInput"
        class="field field-text compose-body"
        aria-label="Message"
        :value="compose.body"
        :disabled="compose.sending || compose.locked"
        @input="setComposeInput('body', $event)"
        @keydown="onBodyKeydown"
      />
      <div v-if="compose.attachments.length > 0" class="compose-addresses">
        <span v-for="file in compose.attachments" :key="file.token" class="compose-chip">
          <Paperclip :size="16" :stroke-width="1.75" aria-hidden="true" />
          {{ file.fileName }} · {{ file.size }}
          <button
            class="control"
            type="button"
            :aria-label="`Remove ${file.fileName}`"
            :disabled="compose.sending || compose.locked"
            @click="removeFile(file.token)"
          >
            Remove
          </button>
        </span>
      </div>
      <p v-if="compose.error" role="alert">{{ compose.error }}</p>
      <div v-if="compose.conflict" class="compose-actions">
        <button class="control" type="button" @click="reloadDraft">Reload Gmail version</button>
        <button class="control control-danger" type="button" @click="overwriteDraft">
          Overwrite Gmail draft
        </button>
      </div>
      <div class="compose-actions">
        <button v-if="compose.unconfirmed" class="control" type="button" @click="viewSent">
          Check Sent
        </button>
        <button v-if="compose.saveUnconfirmed" class="control" type="button" @click="viewDrafts">
          Check Drafts
        </button>
        <button
          v-if="!compose.locked"
          class="control"
          type="button"
          :disabled="compose.sending"
          @click="pickFiles"
        >
          <Paperclip :size="16" :stroke-width="1.75" aria-hidden="true" />
          Attach
        </button>
        <button
          v-if="compose.draftId !== null && !compose.locked"
          class="control"
          type="button"
          :disabled="compose.sending"
          @click="askDeleteDraft($event)"
        >
          Delete draft
        </button>
        <button
          class="control"
          type="button"
          :disabled="compose.sending"
          @click="requestCloseCompose"
        >
          Close
        </button>
        <button
          v-if="!compose.locked"
          class="control control-accent"
          type="button"
          :disabled="compose.sending || compose.conflict || compose.saveUnconfirmed"
          :aria-busy="compose.sending ? 'true' : undefined"
          @click="submitCompose"
        >
          <Send :size="16" :stroke-width="1.75" aria-hidden="true" />
          Send
        </button>
      </div>
    </div>
    <div
      v-if="pendingDelete && compose !== null"
      class="mail-dialog mail-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-draft-title"
      data-mail-modal="active"
    >
      <h2 id="delete-draft-title">Delete this draft?</h2>
      <p>Gmail will permanently delete this draft. This is not Trash.</p>
      <button ref="keepDraftButton" class="control" type="button" @click="pendingDelete = false">
        Keep
      </button>
      <button class="control control-danger" type="button" @click="confirmDeleteDraft">
        Delete
      </button>
    </div>
    <div
      v-if="pendingDiscard !== null"
      class="mail-dialog mail-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="discard-title"
      data-mail-modal="active"
    >
      <h2 id="discard-title">Discard this message?</h2>
      <p v-if="compose?.draftId">Unsaved changes will be lost. The saved Gmail draft will stay.</p>
      <p v-else>The unsent message will be lost.</p>
      <button ref="keepComposeButton" class="control" type="button" @click="keepCompose">
        Keep editing
      </button>
      <button class="control control-danger" type="button" @click="discardCompose">Discard</button>
    </div>
  </div>
</template>
