<script setup lang="ts">
import {
  AlertOctagon,
  Archive,
  ChevronLeft,
  ChevronsUpDown,
  File,
  Flag,
  Inbox,
  Mail,
  MailOpen,
  PanelLeft,
  Paperclip,
  RotateCcw,
  Search,
  Send,
  Star,
  Tag,
  Trash2
} from '@lucide/vue';
import { computed, nextTick, onMounted, ref, watch, type Component } from 'vue';
import { RouterLink } from 'vue-router';
import {
  GmailIpcError,
  gmailErrorMessage,
  type GmailApi,
  type GmailErrorCode,
  type GmailLabel,
  type GmailMessage,
  type GmailThreadSummary
} from '../../../../shared/gmail.ts';
import {
  GoogleIpcError,
  type GoogleAccountSummary,
  type GoogleApi
} from '../../../../shared/google-accounts.ts';
import { createRendererAppApi } from '../../aurora-client.ts';
import StatusPanel from '../../components/StatusPanel.vue';
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

const props = defineProps<{ googleApi?: GoogleApi; gmailApi?: GmailApi }>();
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
let generation = 0;
let trashOpener: HTMLElement | null = null;

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
  accountId.value = value;
  searchText.value = '';
  activeQuery.value = null;
  labelId.value = 'INBOX';
  resetPages();
  void startList();
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

function threadBusy(threadId: string): boolean {
  return actionBusy.value === threadId;
}

function refreshSearch(): void {
  resetPages();
  void startList();
}

function askTrash(threadId: string, event: Event): void {
  trashOpener = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  trashTarget.value = threadId;
}

function closeTrash(): void {
  trashTarget.value = null;
  trashOpener?.focus();
  trashOpener = null;
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

watch(trashTarget, (value) => {
  if (value === null) return;
  void nextTick(() => {
    cancelTrashButton.value?.focus();
  });
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

onMounted(() => {
  void google()
    .listAccounts()
    .then((list) => {
      accounts.value = list.accounts;
      const first = list.accounts.find((account) => account.status === 'connected');
      if (first === undefined) {
        status.value = 'ready';
        return;
      }
      accountId.value = first.id;
      return startList();
    })
    .catch((error: unknown) => {
      fail(error);
    });
});
</script>

<template>
  <div class="mail-screen" :class="{ 'is-reading': openId !== null }">
    <h1 v-if="openId === null" class="page-title">Mail</h1>
    <StatusPanel
      v-if="connectedAccounts.length === 0 && status !== 'loading'"
      kind="empty"
      title="No connected account"
      message="Connect a Google account in Integrations before reading mail."
    />
    <template v-else>
      <div v-if="openId === null" class="mail-toolbar">
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
            <StatusPanel
              v-if="threads.length === 0"
              kind="empty"
              title="No conversations"
              message="This mailbox has no conversations to show."
            />
            <div v-else class="mail-list">
              <ul class="mail-rows">
                <li v-for="thread in threads" :key="thread.id" class="mail-row-line">
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
                        <span v-if="thread.snippet" class="mail-snippet">{{ thread.snippet }}</span>
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
                      :disabled="threadBusy(thread.id)"
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
                      :disabled="threadBusy(thread.id)"
                      @click="restoreConversation(thread.id)"
                    >
                      <RotateCcw :size="16" :stroke-width="1.75" aria-hidden="true" />
                    </button>
                    <button
                      v-else-if="labelId === 'INBOX' || activeQuery !== null"
                      class="control"
                      type="button"
                      aria-label="Archive"
                      :disabled="threadBusy(thread.id)"
                      @click="archiveConversation(thread.id)"
                    >
                      <Archive :size="16" :stroke-width="1.75" aria-hidden="true" />
                    </button>
                    <button
                      v-if="labelId !== 'TRASH'"
                      class="control control-danger"
                      type="button"
                      aria-label="Move to Trash"
                      :disabled="threadBusy(thread.id)"
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
            class="control"
            type="button"
            aria-haspopup="listbox"
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
        <div v-if="labelsOpen" class="label-menu" role="listbox" aria-label="Labels">
          <p v-if="userLabels.length === 0">No labels</p>
          <button
            v-for="label in userLabels"
            :key="label.id"
            class="control"
            type="button"
            role="option"
            :aria-pressed="labelApplied(label.id)"
            :disabled="openId !== null && threadBusy(openId)"
            @click="toggleUserLabel(label)"
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
          <p v-if="item.imagesOmitted" class="mail-note">Images in this message were not loaded.</p>
          <ul v-if="item.attachments.length > 0" class="mail-attachments">
            <li
              v-for="attachment in item.attachments"
              :key="attachment.fileName + attachment.size"
              class="mail-attachment"
            >
              <Paperclip :size="16" :stroke-width="1.75" aria-hidden="true" />
              {{ attachment.fileName }} · {{ attachment.mimeType }} · {{ attachment.size }}
            </li>
          </ul>
        </article>
      </div>
    </template>
    <div
      v-if="trashTarget !== null"
      class="mail-dialog"
      role="dialog"
      aria-labelledby="trash-title"
      @keydown.esc="closeTrash"
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
  </div>
</template>
