import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import IntegrationsView from './IntegrationsView.vue';

describe('IntegrationsView', () => {
  it('renders the generic empty state', () => {
    const wrapper = mount(IntegrationsView);
    expect(wrapper.text()).toContain('Integrations will appear here.');
    expect(wrapper.find('[role="status"]').exists()).toBe(true);
    expect(wrapper.find('button').exists()).toBe(false);
  });
});
