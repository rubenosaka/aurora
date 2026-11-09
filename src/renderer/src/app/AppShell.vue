<script setup lang="ts">
import { computed } from 'vue';
import { onMounted, onUnmounted } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import SidebarNav from '../components/SidebarNav.vue';
import { createRendererAppApi } from '../aurora-client.ts';
import { pendingMailOpen } from '../features/mail/mail-open.ts';

const route = useRoute();
const router = useRouter();
const columnClass = computed(() =>
  route.name === 'mail'
    ? 'flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden px-8 py-8'
    : 'mx-auto w-full min-w-0 max-w-[720px] px-8 py-8'
);

onMounted(() => {
  if (!('aurora' in window) || window.aurora === undefined) return;
  const stop = createRendererAppApi(window.aurora).gmail.listenOpen((event) => {
    pendingMailOpen.value = event;
    void router.push('/mail');
  });
  onUnmounted(stop);
});
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
