<script setup lang="ts">
import {
  AlertOctagon,
  ChevronLeft,
  ChevronsUpDown,
  File,
  Flag,
  Inbox,
  Paperclip,
  Search,
  Send,
  Star,
  Tag,
  Trash2
} from '@lucide/vue';
import { computed, onMounted, ref, type Component } from 'vue';
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
let generation = 0;

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
    errorCode.value === 'gmail-rejected'
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
      <div v-if="openId === null" class="mail-folders" role="list" aria-label="Labels">
        <button
          v-for="label in labels"
          :key="label.id"
          class="folder-button"
          type="button"
          :aria-pressed="folderSelected(label.id)"
          :disabled="status === 'loading'"
          @click="chooseLabel(label.id)"
        >
          <component :is="folderIcon(label)" :size="16" :stroke-width="1.75" aria-hidden="true" />
          <span class="folder-name">{{ label.name }}</span>
          <span v-if="label.unreadCount !== null" class="folder-count">{{
            label.unreadCount
          }}</span>
        </button>
      </div>
      <div v-if="openId !== null" class="mail-stage">
        <div class="conversation-header">
          <button class="control" type="button" @click="back">
            <ChevronLeft :size="16" :stroke-width="1.75" aria-hidden="true" />
            Back
          </button>
          <h2 class="conversation-subject">{{ conversationSubject }}</h2>
          <p class="conversation-date">{{ formatDate(conversationDate) }}</p>
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
      <div v-else class="mail-stage">
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
          <p v-if="activeQuery !== null" class="text-sm text-muted" role="status">Search results</p>
          <StatusPanel
            v-if="threads.length === 0"
            kind="empty"
            title="No conversations"
            message="This mailbox has no conversations to show."
          />
          <ul v-else class="mail-rows">
            <li v-for="thread in threads" :key="thread.id">
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
                <span class="mail-sender">{{ thread.from }}</span>
                <span class="mail-subject-line">
                  <span class="mail-subject">{{ thread.subject ?? '(no subject)' }}</span>
                  <span v-if="thread.snippet" class="mail-snippet">{{ thread.snippet }}</span>
                </span>
                <span class="mail-date">{{ formatDate(thread.date) }}</span>
                <span v-if="thread.unread" class="sr-only">Unread</span>
              </button>
            </li>
          </ul>
          <div class="mt-4 flex gap-2">
            <button class="control" type="button" :disabled="pageIndex === 0" @click="showPrevious">
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
    </template>
  </div>
</template>
