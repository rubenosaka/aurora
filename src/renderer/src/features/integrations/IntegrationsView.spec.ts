import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import {
  disconnectedLocalMessage,
  type GoogleAccountSummary,
  type GoogleApi
} from '../../../../shared/google-accounts.ts';
import IntegrationsView from './IntegrationsView.vue';

const account: GoogleAccountSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'ada@example.com',
  displayName: 'Ada',
  status: 'connected',
  canModifyMail: true
};

function api(overrides: Partial<GoogleApi> = {}): GoogleApi {
  return {
    getClientId: async () => ({ clientId: null, secretConfigured: false }),
    saveClientId: async (clientId) => ({ clientId, secretConfigured: false }),
    listAccounts: async () => ({ accounts: [] }),
    connect: async () => account,
    reconnect: async () => account,
    cancel: async () => ({ cancelled: true }),
    disconnect: async () => ({ outcome: 'disconnected-local' }),
    ...overrides
  };
}

describe('IntegrationsView', () => {
  it('asks for a client id before an account can be connected', async () => {
    const wrapper = mount(IntegrationsView, { props: { googleApi: api() } });
    await flushPromises();
    expect(wrapper.text()).toContain('Add a Google OAuth Client ID in Settings');
    const connect = wrapper.get('button');
    expect(connect.text()).toBe('Connect');
    expect((connect.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists accounts and reports a local-only disconnect', async () => {
    let disconnected = '';
    const wrapper = mount(IntegrationsView, {
      props: {
        googleApi: api({
          getClientId: async () => ({
            clientId: 'desktop-client.apps.googleusercontent.com',
            secretConfigured: false
          }),
          listAccounts: async () => ({ accounts: [account] }),
          disconnect: async (accountId) => {
            disconnected = accountId;
            return { outcome: 'disconnected-local' };
          }
        })
      }
    });
    await flushPromises();
    expect(wrapper.text()).toContain('ada@example.com');
    expect(wrapper.text()).toContain('Reconnect');
    expect(wrapper.text()).toContain('Disconnect');
    await wrapper.get('button[class*="text-danger"]').trigger('click');
    await flushPromises();
    expect(disconnected).toBe(account.id);
    expect(wrapper.text()).toContain(disconnectedLocalMessage);
    expect(wrapper.text().includes('refresh-token')).toBe(false);
  });

  it('shows cancel while a connection is in progress', async () => {
    let resolveConnect: ((value: GoogleAccountSummary) => void) | undefined;
    const accounts: GoogleAccountSummary[] = [];
    const wrapper = mount(IntegrationsView, {
      props: {
        googleApi: api({
          getClientId: async () => ({
            clientId: 'desktop-client.apps.googleusercontent.com',
            secretConfigured: false
          }),
          listAccounts: async () => ({ accounts: [...accounts] }),
          connect: () =>
            new Promise((resolve) => {
              resolveConnect = (value) => {
                accounts.push(value);
                resolve(value);
              };
            })
        })
      }
    });
    await flushPromises();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Cancel');
    resolveConnect?.(account);
    await flushPromises();
    expect(wrapper.text()).toContain('ada@example.com');
  });
});
