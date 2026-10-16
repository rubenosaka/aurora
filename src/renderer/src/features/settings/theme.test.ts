import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyResolvedTheme,
  readThemePreference,
  resolveTheme,
  themeStorageKey,
  writeThemePreference,
  type ThemeStorage
} from './theme.ts';

function memoryStorage(initial?: string): ThemeStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(themeStorageKey, initial);
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

describe('theme preference', () => {
  it('resolves light, dark, and system', () => {
    assert.equal(resolveTheme('light', true), 'light');
    assert.equal(resolveTheme('dark', false), 'dark');
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
  });

  it('reads only light, dark, and system', () => {
    assert.equal(readThemePreference(memoryStorage()), 'system');
    assert.equal(readThemePreference(memoryStorage('dark')), 'dark');
    assert.equal(readThemePreference(memoryStorage('sepia')), 'system');
  });

  it('falls back to system when storage throws', () => {
    const storage: ThemeStorage = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {}
    };
    assert.equal(readThemePreference(storage), 'system');
  });

  it('writes the preference and applies the resolved theme', () => {
    const storage = memoryStorage();
    writeThemePreference(storage, 'dark');
    assert.equal(storage.values.get(themeStorageKey), 'dark');
    const root: { dataset: { theme?: string } } = { dataset: {} };
    applyResolvedTheme(root, 'dark');
    assert.equal(root.dataset.theme, 'dark');
  });
});
