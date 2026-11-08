<script setup lang="ts">
import { CircleAlert, Inbox, LoaderCircle } from '@lucide/vue';

defineProps<{
  kind: 'loading' | 'empty' | 'error';
  title: string;
  message: string;
}>();
</script>

<template>
  <section
    class="status-panel"
    :aria-busy="kind === 'loading' ? 'true' : undefined"
    :role="kind === 'error' ? 'alert' : kind === 'empty' ? 'status' : undefined"
  >
    <LoaderCircle
      v-if="kind === 'loading'"
      class="status-icon"
      :size="20"
      :stroke-width="1.75"
      aria-hidden="true"
    />
    <Inbox
      v-else-if="kind === 'empty'"
      class="status-icon"
      :size="20"
      :stroke-width="1.75"
      aria-hidden="true"
    />
    <CircleAlert v-else class="status-icon" :size="20" :stroke-width="1.75" aria-hidden="true" />
    <div>
      <h2 class="text-sm font-medium text-text">{{ title }}</h2>
      <p class="mt-2 text-sm" :class="kind === 'error' ? 'text-danger' : 'text-muted'">
        {{ message }}
      </p>
    </div>
  </section>
</template>
