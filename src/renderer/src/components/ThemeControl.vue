<script setup lang="ts">
import { setThemePreference, themePreference } from '../features/settings/theme-runtime.ts';
import { themePreferences, type ThemePreference } from '../features/settings/theme.ts';

const labels: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System'
};
</script>

<template>
  <fieldset class="rounded-lg border border-border bg-surface px-5 py-4">
    <legend class="px-1 text-sm font-medium text-text">Theme</legend>
    <div class="mt-3 flex flex-col gap-2">
      <label
        v-for="preference in themePreferences"
        :key="preference"
        class="flex h-10 items-center gap-3 rounded-md px-2 text-sm text-text"
      >
        <input
          class="size-4 accent-accent outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent"
          type="radio"
          name="aurora-theme"
          :value="preference"
          :checked="themePreference === preference"
          @change="setThemePreference(preference)"
        />
        {{ labels[preference] }}
      </label>
    </div>
  </fieldset>
</template>
