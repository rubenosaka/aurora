import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { AuroraIpcError, type AppInfo, type IpcResult } from '../../../../shared/app-info.ts';
import { type GmailBridge } from '../../../../shared/gmail.ts';
import { type GoogleBridge } from '../../../../shared/google-accounts.ts';
import DashboardView from './DashboardView.vue';

const info: AppInfo = { name: 'aurora', version: '0.0.0', platform: 'win32' };

function google(): GoogleBridge {
  return {
    getClientId: async () => ({ ok: false, error: { code: 'internal' } }),
    saveClientId: async () => ({ ok: false, error: { code: 'internal' } }),
    listAccounts: async () => ({ ok: false, error: { code: 'internal' } }),
    connect: async () => ({ ok: false, error: { code: 'internal' } }),
    reconnect: async () => ({ ok: false, error: { code: 'internal' } }),
    cancel: async () => ({ ok: false, error: { code: 'internal' } }),
    disconnect: async () => ({ ok: false, error: { code: 'internal' } })
  };
}

function gmail(): GmailBridge {
  return {
    listLabels: async () => ({ ok: false, error: { code: 'internal' } }),
    listThreads: async () => ({ ok: false, error: { code: 'internal' } }),
    readThread: async () => ({ ok: false, error: { code: 'internal' } }),
    openLink: async () => ({ ok: false, error: { code: 'internal' } }),
    markRead: async () => ({ ok: false, error: { code: 'internal' } }),
    markUnread: async () => ({ ok: false, error: { code: 'internal' } }),
    archiveThread: async () => ({ ok: false, error: { code: 'internal' } }),
    trashThread: async () => ({ ok: false, error: { code: 'internal' } }),
    untrashThread: async () => ({ ok: false, error: { code: 'internal' } }),
    addLabel: async () => ({ ok: false, error: { code: 'internal' } }),
    removeLabel: async () => ({ ok: false, error: { code: 'internal' } }),
    starMessage: async () => ({ ok: false, error: { code: 'internal' } }),
    unstarMessage: async () => ({ ok: false, error: { code: 'internal' } })
  };
}

function bridge(getInfo: () => Promise<IpcResult<AppInfo>>): void {
  window.aurora = { app: { getInfo }, google: google(), gmail: gmail() };
}

describe('DashboardView', () => {
  it('shows application information after loading', async () => {
    let resolveInfo: ((value: IpcResult<AppInfo>) => void) | undefined;
    bridge(
      () =>
        new Promise((resolve) => {
          resolveInfo = resolve;
        })
    );
    const wrapper = mount(DashboardView);
    await flushPromises();
    expect(wrapper.text()).toContain('Loading application information.');
    resolveInfo?.({ ok: true, value: info });
    await flushPromises();
    expect(wrapper.text()).toContain('aurora');
    expect(wrapper.text()).toContain('0.0.0');
    expect(wrapper.text()).toContain('win32');
    expect(wrapper.find('dl').exists()).toBe(true);
  });

  it('shows the safe error message and hides transport details', async () => {
    bridge(async () => {
      throw new Error('C:\\secret\\path');
    });
    const rejected = mount(DashboardView);
    await flushPromises();
    expect(rejected.text()).toContain('Request failed.');
    expect(rejected.text().includes('secret')).toBe(false);

    bridge(async () => ({ ok: false, error: { code: 'unauthorized' } }));
    const unauthorized = mount(DashboardView);
    await flushPromises();
    expect(unauthorized.text()).toContain(new AuroraIpcError('unauthorized').message);
    expect(unauthorized.text().includes('unauthorized')).toBe(false);
  });
});
