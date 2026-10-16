<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { AuroraIpcError, type AppInfo } from '../../../../shared/app-info.ts';
import { createRendererAppApi } from '../../aurora-client.ts';
import StatusPanel from '../../components/StatusPanel.vue';

const status = ref<'loading' | 'ready' | 'error'>('loading');
const info = ref<AppInfo | null>(null);
const errorMessage = ref('Request failed.');

onMounted(() => {
  void createRendererAppApi(window.aurora)
    .app.getInfo()
    .then((value) => {
      info.value = value;
      status.value = 'ready';
    })
    .catch((error: unknown) => {
      errorMessage.value = error instanceof AuroraIpcError ? error.message : 'Request failed.';
      status.value = 'error';
    });
});
</script>

<template>
  <h1 class="text-2xl font-medium tracking-tight text-text">Dashboard</h1>
  <div class="mt-6">
    <StatusPanel
      v-if="status === 'loading'"
      kind="loading"
      title="Loading"
      message="Loading application information."
    />
    <StatusPanel
      v-else-if="status === 'error'"
      kind="error"
      title="Application information is unavailable"
      :message="errorMessage"
    />
    <dl v-else-if="info" class="grid gap-4">
      <div class="rounded-lg border border-border bg-surface px-5 py-4">
        <dt class="text-sm text-muted">Name</dt>
        <dd class="mt-1 text-base text-text">{{ info.name }}</dd>
      </div>
      <div class="rounded-lg border border-border bg-surface px-5 py-4">
        <dt class="text-sm text-muted">Version</dt>
        <dd class="mt-1 text-base text-text">{{ info.version }}</dd>
      </div>
      <div class="rounded-lg border border-border bg-surface px-5 py-4">
        <dt class="text-sm text-muted">Platform</dt>
        <dd class="mt-1 text-base text-text">{{ info.platform }}</dd>
      </div>
    </dl>
  </div>
</template>
