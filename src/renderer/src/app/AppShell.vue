<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import SidebarNav from '../components/SidebarNav.vue';

const route = useRoute();
const columnClass = computed(() =>
  route.name === 'mail'
    ? 'flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden px-8 py-8'
    : 'mx-auto w-full min-w-0 max-w-[720px] px-8 py-8'
);
</script>

<template>
  <div class="flex h-full min-h-0 bg-canvas text-text">
    <SidebarNav />
    <main
      class="shell-main min-w-0 flex-1"
      :class="route.name === 'mail' ? 'min-h-0 overflow-hidden' : 'overflow-auto'"
    >
      <div :class="columnClass">
        <RouterView />
      </div>
    </main>
  </div>
</template>
