<script setup lang="ts">
import { RouterView } from 'vue-router';
import SidebarNav from '../components/SidebarNav.vue';
</script>

<template>
  <div class="flex h-full min-h-0 bg-canvas text-text">
    <SidebarNav />
    <main class="min-w-0 flex-1 overflow-auto">
      <div class="mx-auto w-full max-w-[720px] px-8 py-8">
        <RouterView />
      </div>
    </main>
  </div>
</template>
