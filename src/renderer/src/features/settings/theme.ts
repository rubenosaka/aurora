export const themeStorageKey = 'aurora.theme';

export const themePreferences = ['light', 'dark', 'system'] as const;

export type ThemePreference = (typeof themePreferences)[number];

export type ResolvedTheme = 'light' | 'dark';

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemIsDark ? 'dark' : 'light';
  return preference;
}

export function readThemePreference(storage: ThemeStorage): ThemePreference {
  try {
    const stored = storage.getItem(themeStorageKey);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemePreference(storage: ThemeStorage, preference: ThemePreference): void {
  storage.setItem(themeStorageKey, preference);
}

export function applyResolvedTheme(
  root: { dataset: { theme?: string } },
  theme: ResolvedTheme
): void {
  root.dataset.theme = theme;
}
