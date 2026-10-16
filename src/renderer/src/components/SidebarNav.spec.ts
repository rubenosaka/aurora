import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createAppRouter } from '../app/router.ts';
import SidebarNav from './SidebarNav.vue';

describe('SidebarNav', () => {
  it('marks the active route and shows a visible focus style', async () => {
    const router = createAppRouter();
    await router.push('/integrations');
    const wrapper = mount(SidebarNav, { global: { plugins: [router] } });
    const current = wrapper.get('[aria-current="page"]');
    expect(current.text()).toContain('Integrations');
    expect(current.attributes('href')).toBe('#/integrations');
    expect(current.classes().join(' ')).toContain('focus-visible:outline-solid');
    expect(wrapper.findAll('a')).toHaveLength(3);
  });
});
