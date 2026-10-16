import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StatusPanel from './StatusPanel.vue';

describe('StatusPanel', () => {
  it('marks loading as busy', () => {
    const wrapper = mount(StatusPanel, {
      props: { kind: 'loading', title: 'Loading', message: 'Loading application information.' }
    });
    expect(wrapper.attributes('aria-busy')).toBe('true');
    expect(wrapper.attributes('role')).toBeUndefined();
  });

  it('exposes an empty state', () => {
    const wrapper = mount(StatusPanel, {
      props: { kind: 'empty', title: 'No integrations', message: 'Integrations will appear here.' }
    });
    expect(wrapper.attributes('role')).toBe('status');
    expect(wrapper.attributes('aria-busy')).toBeUndefined();
  });

  it('exposes an error alert', () => {
    const wrapper = mount(StatusPanel, {
      props: { kind: 'error', title: 'Unavailable', message: 'Request failed.' }
    });
    expect(wrapper.attributes('role')).toBe('alert');
    expect(wrapper.text()).toContain('Request failed.');
  });
});
