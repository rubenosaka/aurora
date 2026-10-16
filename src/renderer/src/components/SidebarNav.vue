<script setup lang="ts">
import { Blocks, LayoutDashboard, Settings } from '@lucide/vue';
import { shellRoutes, type ShellRouteName } from '../app/routes.ts';

const icons: Record<ShellRouteName, object> = {
  dashboard: LayoutDashboard,
  integrations: Blocks,
  settings: Settings
};
</script>

<template>
  <aside
    class="flex h-full w-16 shrink-0 flex-col border-r border-border bg-sidebar shell:w-[232px]"
  >
    <p class="sr-only px-4 pt-5 text-sm font-medium text-text shell:not-sr-only">Aurora</p>
    <nav aria-label="Primary" class="flex flex-col gap-1 px-2 py-4">
      <RouterLink
        v-for="route in shellRoutes"
        :key="route.name"
        :to="route.path"
        class="flex h-10 items-center gap-3 rounded-md px-3 text-sm text-text outline-none hover:bg-surface focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent [&.router-link-exact-active]:bg-accent [&.router-link-exact-active]:text-accent-text"
      >
        <component :is="icons[route.name]" class="size-4 shrink-0" aria-hidden="true" />
        <span class="sr-only shell:not-sr-only">{{ route.title }}</span>
      </RouterLink>
    </nav>
  </aside>
</template>
