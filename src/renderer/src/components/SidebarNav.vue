<script setup lang="ts">
import { Blocks, LayoutDashboard, Mail, Settings } from '@lucide/vue';
import { shellRoutes, type ShellRouteName } from '../app/routes.ts';

const icons: Record<ShellRouteName, object> = {
  dashboard: LayoutDashboard,
  mail: Mail,
  integrations: Blocks,
  settings: Settings
};
</script>

<template>
  <aside
    class="flex h-full w-16 shrink-0 flex-col border-r border-border bg-sidebar shell:w-[232px]"
  >
    <p class="wordmark">
      <span class="wordmark-bar" aria-hidden="true"></span>
      Aurora
    </p>
    <nav aria-label="Primary" class="flex flex-col gap-1 px-2 py-4">
      <RouterLink v-for="route in shellRoutes" :key="route.name" :to="route.path" class="nav-link">
        <component
          :is="icons[route.name]"
          :size="16"
          :stroke-width="1.75"
          class="shrink-0"
          aria-hidden="true"
        />
        <span class="sr-only shell:not-sr-only">{{ route.title }}</span>
      </RouterLink>
    </nav>
  </aside>
</template>
