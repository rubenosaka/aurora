<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  GoogleIpcError,
  disconnectedLocalMessage,
  googleErrorMessage,
  revokedMessage,
  type GoogleAccountSummary,
  type GoogleApi
} from '../../../../shared/google-accounts.ts';
import { createRendererAppApi } from '../../aurora-client.ts';
import StatusPanel from '../../components/StatusPanel.vue';

const props = defineProps<{ googleApi?: GoogleApi }>();
const status = ref<'loading' | 'ready' | 'error'>('loading');
const clientConfigured = ref(false);
const accounts = ref<GoogleAccountSummary[]>([]);
const busy = ref(false);
const authorizing = ref(false);
const message = ref('');
const messageKind = ref<'ok' | 'error'>('ok');

function api(): GoogleApi {
  return props.googleApi ?? createRendererAppApi(window.aurora).google;
}

function showError(error: unknown): void {
  messageKind.value = 'error';
  message.value = error instanceof GoogleIpcError ? error.message : googleErrorMessage('internal');
}

async function reload(): Promise<void> {
  const client = await api().getClientId();
  clientConfigured.value = client.clientId !== null;
  accounts.value = clientConfigured.value ? (await api().listAccounts()).accounts : [];
}

onMounted(() => {
  void reload()
    .then(() => {
      status.value = 'ready';
    })
    .catch((error: unknown) => {
      showError(error);
      status.value = 'error';
    });
});

function run(kind: 'flow' | 'account', work: () => Promise<void>): void {
  busy.value = true;
  authorizing.value = kind === 'flow';
  message.value = '';
  void work()
    .catch((error: unknown) => {
      showError(error);
    })
    .finally(() => {
      busy.value = false;
      authorizing.value = false;
    });
}

function connect(): void {
  run('flow', async () => {
    await api().connect();
    await reload();
  });
}

function reconnect(accountId: string): void {
  run('flow', async () => {
    await api().reconnect(accountId);
    await reload();
  });
}

function cancel(): void {
  void api()
    .cancel()
    .catch((error: unknown) => {
      showError(error);
    });
}

function disconnect(accountId: string): void {
  run('account', async () => {
    const result = await api().disconnect(accountId);
    messageKind.value = 'ok';
    message.value = result.outcome === 'revoked' ? revokedMessage : disconnectedLocalMessage;
    await reload();
  });
}

function accountLabel(account: GoogleAccountSummary): string {
  return account.email ?? account.displayName ?? 'Google account';
}

function statusLabel(account: GoogleAccountSummary): string {
  return account.status === 'connected' ? 'Connected' : 'Needs sign-in';
}
</script>

<template>
  <h1 class="text-2xl font-medium tracking-tight text-text">Integrations</h1>
  <div class="mt-6 flex flex-col gap-4">
    <StatusPanel
      v-if="status === 'loading'"
      kind="loading"
      title="Loading"
      message="Loading Google accounts."
    />
    <StatusPanel
      v-else-if="status === 'error'"
      kind="error"
      title="Google accounts are unavailable"
      :message="message"
    />
    <template v-else>
      <StatusPanel
        v-if="!clientConfigured"
        kind="empty"
        title="Google is not configured"
        message="Add a Google OAuth Client ID in Settings before connecting an account."
      />
      <div class="flex gap-3">
        <button
          class="h-10 rounded-md bg-accent px-4 text-sm text-accent-text outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          type="button"
          :disabled="!clientConfigured || busy"
          @click="connect"
        >
          Connect
        </button>
        <button
          v-if="authorizing"
          class="h-10 rounded-md border border-border bg-surface px-4 text-sm text-text outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent"
          type="button"
          @click="cancel"
        >
          Cancel
        </button>
      </div>
      <p v-if="clientConfigured && accounts.length === 0" class="text-sm text-muted" role="status">
        No Google accounts are connected.
      </p>
      <ul v-if="accounts.length > 0" class="flex flex-col gap-3">
        <li
          v-for="account in accounts"
          :key="account.id"
          class="rounded-lg border border-border bg-surface px-5 py-4"
        >
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p class="text-sm font-medium text-text">{{ accountLabel(account) }}</p>
              <p class="mt-1 text-sm text-muted">{{ statusLabel(account) }}</p>
            </div>
            <div class="flex gap-2">
              <button
                class="h-10 rounded-md border border-border px-3 text-sm text-text outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
                type="button"
                :disabled="busy"
                @click="reconnect(account.id)"
              >
                Reconnect
              </button>
              <button
                class="h-10 rounded-md border border-border px-3 text-sm text-danger outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
                type="button"
                :disabled="busy"
                @click="disconnect(account.id)"
              >
                Disconnect
              </button>
            </div>
          </div>
        </li>
      </ul>
      <p
        v-if="message && status === 'ready'"
        class="text-sm"
        :class="messageKind === 'error' ? 'text-danger' : 'text-muted'"
        :role="messageKind === 'error' ? 'alert' : 'status'"
      >
        {{ message }}
      </p>
    </template>
  </div>
</template>
