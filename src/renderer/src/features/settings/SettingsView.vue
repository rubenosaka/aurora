<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  GoogleIpcError,
  googleErrorMessage,
  type GoogleApi
} from '../../../../shared/google-accounts.ts';
import { createRendererAppApi } from '../../aurora-client.ts';
import ThemeControl from '../../components/ThemeControl.vue';

const props = defineProps<{ googleApi?: GoogleApi }>();
const clientId = ref('');
const clientSecret = ref('');
const secretConfigured = ref(false);
const status = ref<'loading' | 'ready'>('loading');
const message = ref('');
const messageKind = ref<'ok' | 'error'>('ok');

function api(): GoogleApi {
  return props.googleApi ?? createRendererAppApi(window.aurora).google;
}

function showError(error: unknown): void {
  messageKind.value = 'error';
  message.value = error instanceof GoogleIpcError ? error.message : googleErrorMessage('internal');
}

onMounted(() => {
  void api()
    .getClientId()
    .then((value) => {
      clientId.value = value.clientId ?? '';
      secretConfigured.value = value.secretConfigured;
      status.value = 'ready';
    })
    .catch((error: unknown) => {
      showError(error);
      status.value = 'ready';
    });
});

function save(): void {
  message.value = '';
  const enteredSecret = clientSecret.value.trim();
  void api()
    .saveClientId(clientId.value.trim(), enteredSecret.length > 0 ? enteredSecret : null)
    .then((value) => {
      clientId.value = value.clientId;
      secretConfigured.value = value.secretConfigured;
      clientSecret.value = '';
      messageKind.value = 'ok';
      message.value = enteredSecret.length > 0 ? 'Client secret saved.' : 'Client ID saved.';
    })
    .catch((error: unknown) => {
      showError(error);
    });
}
</script>

<template>
  <h1 class="text-2xl font-medium tracking-tight text-text">Settings</h1>
  <div class="mt-6 flex flex-col gap-6">
    <ThemeControl />
    <form class="rounded-lg border border-border bg-surface px-5 py-4" @submit.prevent="save">
      <h2 class="text-sm font-medium text-text">Google OAuth Client ID</h2>
      <label class="mt-3 block text-sm text-muted" for="google-client-id">
        Desktop client ID
        <input
          id="google-client-id"
          v-model="clientId"
          class="mt-2 h-10 w-full rounded-md border border-border bg-canvas px-3 text-sm text-text outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent"
          autocomplete="off"
          spellcheck="false"
          :disabled="status === 'loading'"
        />
      </label>
      <label class="mt-3 block text-sm text-muted" for="google-client-secret">
        Desktop client secret
        <input
          id="google-client-secret"
          v-model="clientSecret"
          class="mt-2 h-10 w-full rounded-md border border-border bg-canvas px-3 text-sm text-text outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :disabled="status === 'loading'"
        />
      </label>
      <p class="mt-2 text-sm text-muted">
        {{
          secretConfigured
            ? 'A client secret is saved. Leave the field blank to keep it.'
            : 'No client secret is saved.'
        }}
      </p>
      <button
        class="mt-4 h-10 rounded-md bg-accent px-4 text-sm text-accent-text outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        type="submit"
        :disabled="status === 'loading'"
      >
        Save
      </button>
      <p
        v-if="message"
        class="mt-3 text-sm"
        :class="messageKind === 'error' ? 'text-danger' : 'text-muted'"
        :role="messageKind === 'error' ? 'alert' : 'status'"
      >
        {{ message }}
      </p>
    </form>
  </div>
</template>
