import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { GoogleIpcError, type GoogleApi } from '../../../../shared/google-accounts.ts';
import SettingsView from './SettingsView.vue';

function api(overrides: Partial<GoogleApi> = {}): GoogleApi {
  return {
    getClientId: async () => ({
      clientId: 'desktop-client.apps.googleusercontent.com',
      secretConfigured: false
    }),
    saveClientId: async (clientId) => ({ clientId, secretConfigured: false }),
    listAccounts: async () => ({ accounts: [] }),
    connect: async () => {
      throw new GoogleIpcError('internal');
    },
    reconnect: async () => {
      throw new GoogleIpcError('internal');
    },
    cancel: async () => ({ cancelled: true }),
    disconnect: async () => ({ outcome: 'revoked' }),
    ...overrides
  };
}

describe('SettingsView', () => {
  it('loads and saves the Google client id beside the theme', async () => {
    let saved = '';
    const wrapper = mount(SettingsView, {
      props: {
        googleApi: api({
          saveClientId: async (clientId, clientSecret) => {
            saved = clientId;
            expect(clientSecret).toBeNull();
            return { clientId, secretConfigured: false };
          }
        })
      }
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Theme');
    const input = wrapper.get('#google-client-id');
    expect((input.element as HTMLInputElement).value).toBe(
      'desktop-client.apps.googleusercontent.com'
    );
    await input.setValue('  other-client.apps.googleusercontent.com  ');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(saved).toBe('other-client.apps.googleusercontent.com');
    expect(wrapper.text()).toContain('Client ID saved.');
    expect(wrapper.text()).toContain('No client secret is saved.');
    expect((wrapper.get('#google-client-secret').element as HTMLInputElement).value).toBe('');
  });

  it('submits a new client secret and never renders the saved value', async () => {
    let submitted: string | null = 'unset';
    const wrapper = mount(SettingsView, {
      props: {
        googleApi: api({
          getClientId: async () => ({
            clientId: 'desktop-client.apps.googleusercontent.com',
            secretConfigured: true
          }),
          saveClientId: async (clientId, clientSecret) => {
            submitted = clientSecret;
            return { clientId, secretConfigured: true };
          }
        })
      }
    });
    await flushPromises();
    expect(wrapper.text()).toContain('A client secret is saved.');
    expect(wrapper.text().includes('client-secret-value')).toBe(false);
    await wrapper.get('#google-client-secret').setValue(' client-secret-value ');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(submitted).toBe('client-secret-value');
    expect((wrapper.get('#google-client-secret').element as HTMLInputElement).value).toBe('');
    expect(wrapper.text()).toContain('Client secret saved.');
    expect(wrapper.text().includes('client-secret-value')).toBe(false);
  });

  it('shows the fixed client-in-use message', async () => {
    const wrapper = mount(SettingsView, {
      props: {
        googleApi: api({
          saveClientId: async () => {
            throw new GoogleIpcError('client-in-use');
          }
        })
      }
    });
    await flushPromises();
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Disconnect the connected Google accounts');
    expect(wrapper.text().includes('refresh-token')).toBe(false);
  });
});
