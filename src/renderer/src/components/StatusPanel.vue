<script setup lang="ts">
defineProps<{
  kind: 'loading' | 'empty' | 'error';
  title: string;
  message: string;
}>();
</script>

<template>
  <section
    class="rounded-lg border border-border bg-surface px-5 py-8"
    :aria-busy="kind === 'loading' ? 'true' : undefined"
    :role="kind === 'error' ? 'alert' : kind === 'empty' ? 'status' : undefined"
  >
    <h2 class="text-base font-medium text-text">{{ title }}</h2>
    <p class="mt-2 text-sm" :class="kind === 'error' ? 'text-danger' : 'text-muted'">
      {{ message }}
    </p>
  </section>
</template>
