import { ref } from 'vue';
import {
  applyResolvedTheme,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ThemePreference
} from './theme.ts';

export const themePreference = ref<ThemePreference>('system');

const systemIsDark = ref(false);
let media: MediaQueryList | null = null;

function paint(): void {
  applyResolvedTheme(
    document.documentElement,
    resolveTheme(themePreference.value, systemIsDark.value)
  );
}

function onSystemTheme(event: MediaQueryListEvent): void {
  systemIsDark.value = event.matches;
  if (themePreference.value === 'system') paint();
}

export function startTheme(): void {
  themePreference.value = readThemePreference(localStorage);
  media = window.matchMedia('(prefers-color-scheme: dark)');
  systemIsDark.value = media.matches;
  media.addEventListener('change', onSystemTheme);
  paint();
}

export function setThemePreference(preference: ThemePreference): void {
  themePreference.value = preference;
  writeThemePreference(localStorage, preference);
  paint();
}
