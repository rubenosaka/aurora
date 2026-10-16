import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { setThemePreference } from '../features/settings/theme-runtime.ts';
import ThemeControl from './ThemeControl.vue';

describe('ThemeControl', () => {
  beforeEach(() => {
    localStorage.clear();
    setThemePreference('system');
  });

  it('uses one native radio group and applies the selected theme', async () => {
    const wrapper = mount(ThemeControl);
    const radios = wrapper.findAll('input[type="radio"]');
    expect(radios).toHaveLength(3);
    expect(new Set(radios.map((radio) => radio.attributes('name')))).toEqual(
      new Set(['aurora-theme'])
    );
    await radios[1]?.trigger('change');
    expect(localStorage.getItem('aurora.theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(wrapper.get('input[value="dark"]').element).toBeInstanceOf(HTMLInputElement);
  });
});
