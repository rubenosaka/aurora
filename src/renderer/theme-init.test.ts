import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { themeStorageKey } from './src/features/settings/theme.ts';

const script = readFileSync(new URL('./public/theme-init.js', import.meta.url), 'utf8');

function boot(stored: string | undefined, systemIsDark: boolean, fail = false): string | undefined {
  const dataset: { theme?: string } = {};
  const storage = {
    getItem(key: string) {
      if (fail) throw new Error('denied');
      return key === themeStorageKey ? (stored ?? null) : null;
    }
  };
  runInNewContext(script, {
    localStorage: storage,
    window: { matchMedia: () => ({ matches: systemIsDark }) },
    document: { documentElement: { dataset } }
  });
  return dataset.theme;
}

describe('theme-init', () => {
  it('applies light, dark, and system before the module bundle', () => {
    assert.equal(boot('light', true), 'light');
    assert.equal(boot('dark', false), 'dark');
    assert.equal(boot('system', true), 'dark');
    assert.equal(boot('system', false), 'light');
    assert.equal(boot(undefined, false), 'light');
    assert.equal(boot('sepia', true), 'dark');
  });

  it('falls back to system when storage throws', () => {
    assert.equal(boot(undefined, true, true), 'dark');
  });

  it('uses the same storage key as the theme module', () => {
    assert.equal(script.includes(themeStorageKey), true);
  });
});
