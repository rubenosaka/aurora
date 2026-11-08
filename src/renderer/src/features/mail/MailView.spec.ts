import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { GmailIpcError, type GmailApi, type GmailThreadList } from '../../../../shared/gmail.ts';
import { type GoogleAccountSummary, type GoogleApi } from '../../../../shared/google-accounts.ts';
import MailView from './MailView.vue';

const ada: GoogleAccountSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'ada@example.com',
  displayName: 'Ada',
  status: 'connected'
};

const grace: GoogleAccountSummary = {
  id: '00000000-0000-4000-8000-000000000002',
  email: 'grace@example.com',
  displayName: 'Grace',
  status: 'connected'
};

const labels = {
  labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' as const, unreadCount: 1 }]
};

function accountsApi(list: GoogleAccountSummary[]): GoogleApi {
  return {
    getClientId: async () => ({ clientId: null, secretConfigured: false }),
    saveClientId: async () => ({
      clientId: 'desktop-client.apps.googleusercontent.com',
      secretConfigured: false
    }),
    listAccounts: async () => ({ accounts: list }),
    connect: async () => list[0] ?? ada,
    reconnect: async () => list[0] ?? ada,
    cancel: async () => ({ cancelled: true }),
    disconnect: async () => ({ outcome: 'revoked' })
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MailView', () => {
  it('opens a link only after a click', async () => {
    const opened: string[] = [];
    const gmailApi: GmailApi = {
      listLabels: async () => labels,
      listThreads: async () => ({
        threads: [
          {
            id: 'threadsame',
            subject: 'Hello',
            from: 'Ada',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Hi',
            unread: true
          }
        ],
        nextPageToken: null
      }),
      readThread: async () => ({
        id: 'threadsame',
        messages: [
          {
            id: 'messageone',
            from: 'Ada',
            to: null,
            cc: null,
            bcc: null,
            subject: 'Hello',
            date: '2026-11-02T12:00:00.000Z',
            unread: true,
            text: null,
            html: '<a href="https://example.com/letter">Letter</a>',
            imagesOmitted: false,
            attachments: []
          }
        ]
      }),
      openLink: async (url) => {
        opened.push(url);
        return { opened: true };
      }
    };
    const googleApi: GoogleApi = {
      getClientId: async () => ({ clientId: null, secretConfigured: false }),
      saveClientId: async () => ({
        clientId: 'desktop-client.apps.googleusercontent.com',
        secretConfigured: false
      }),
      listAccounts: async () => ({ accounts: [ada] }),
      connect: async () => ada,
      reconnect: async () => ada,
      cancel: async () => ({ cancelled: true }),
      disconnect: async () => ({ outcome: 'revoked' })
    };
    const wrapper = mount(MailView, {
      props: { googleApi, gmailApi },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    });
    await flushPromises();
    expect(opened).toEqual([]);
    await wrapper.get('ul li button').trigger('click');
    await flushPromises();
    const letter = wrapper.find('a[href="https://example.com/letter"]');
    expect(letter.exists()).toBe(true);
    await letter.trigger('click');
    expect(opened).toEqual(['https://example.com/letter']);
  });

  it('ignores a late error from the previous account', async () => {
    const first = deferred<GmailThreadList>();
    const second = deferred<GmailThreadList>();
    const calls: string[] = [];
    const gmailApi: GmailApi = {
      listLabels: async () => labels,
      listThreads: (query) => {
        calls.push(query.accountId);
        return calls.length === 1 ? first.promise : second.promise;
      },
      readThread: async () => ({ id: 'threadsame', messages: [] }),
      openLink: async () => ({ opened: true })
    };
    const googleApi: GoogleApi = {
      getClientId: async () => ({ clientId: null, secretConfigured: false }),
      saveClientId: async () => ({
        clientId: 'desktop-client.apps.googleusercontent.com',
        secretConfigured: false
      }),
      listAccounts: async () => ({ accounts: [ada, grace] }),
      connect: async () => ada,
      reconnect: async () => ada,
      cancel: async () => ({ cancelled: true }),
      disconnect: async () => ({ outcome: 'revoked' })
    };
    const wrapper = mount(MailView, {
      props: { googleApi, gmailApi },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    });
    await flushPromises();
    await wrapper.get('select').setValue(grace.id);
    await flushPromises();
    first.reject(new GmailIpcError('needs-reauth'));
    await flushPromises();
    expect(wrapper.text().includes('can no longer be used')).toBe(false);
    second.resolve({
      threads: [
        {
          id: 'threadgrace',
          subject: 'From Grace',
          from: 'Grace',
          date: '2026-11-02T12:00:00.000Z',
          snippet: null,
          unread: false
        }
      ],
      nextPageToken: null
    });
    await flushPromises();
    expect(wrapper.text()).toContain('From Grace');
    expect(wrapper.text().includes('can no longer be used')).toBe(false);
  });

  it('activates a full row from the keyboard and keeps unread distinct', async () => {
    const gmailApi: GmailApi = {
      listLabels: async () => labels,
      listThreads: async () => ({
        threads: [
          {
            id: 'threadsame',
            subject: 'Hello',
            from: 'Ada',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Hi',
            unread: true
          },
          {
            id: 'threadread',
            subject: 'Read',
            from: 'Bea',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Seen',
            unread: false
          }
        ],
        nextPageToken: null
      }),
      readThread: async () => ({ id: 'threadsame', messages: [] }),
      openLink: async () => ({ opened: true })
    };
    const wrapper = mount(MailView, {
      props: { googleApi: accountsApi([ada]), gmailApi },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    });
    await flushPromises();
    const row = wrapper.get('ul li button');
    expect(row.element.tagName).toBe('BUTTON');
    expect((row.element as HTMLButtonElement).tabIndex).toBe(0);
    expect(row.classes()).toContain('is-unread');
    expect(row.text()).toContain('Unread');
    expect(row.find('.mail-unread.is-on').exists()).toBe(true);
    const read = wrapper.findAll('ul li button')[1];
    expect(read?.classes().includes('is-unread')).toBe(false);
    expect(read?.text().includes('Unread')).toBe(false);
    expect(read?.find('.mail-unread.is-on').exists()).toBe(false);
    await row.trigger('keydown.enter');
    await row.trigger('click');
    await flushPromises();
    expect(wrapper.find('input[aria-label="Search Gmail"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Labels"]').exists()).toBe(false);
    expect(wrapper.get('button').text()).toContain('Back');
  });

  it('selects a folder and keeps the active state after the pointer leaves', async () => {
    const queries: Array<string | null> = [];
    const gmailApi: GmailApi = {
      listLabels: async () => ({
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system', unreadCount: 2 },
          { id: 'Label_1', name: 'Trips', type: 'user', unreadCount: null }
        ]
      }),
      listThreads: (query) => {
        queries.push(query.labelId);
        return Promise.resolve({ threads: [], nextPageToken: null });
      },
      readThread: async () => ({ id: 'threadsame', messages: [] }),
      openLink: async () => ({ opened: true })
    };
    const wrapper = mount(MailView, {
      props: { googleApi: accountsApi([ada]), gmailApi }
    });
    await flushPromises();
    const folders = wrapper.findAll('[aria-label="Labels"] button');
    expect(folders[0]?.attributes('aria-pressed')).toBe('true');
    expect(folders[1]?.attributes('aria-pressed')).toBe('false');
    await folders[1]?.trigger('click');
    await flushPromises();
    expect(queries.at(-1)).toBe('Label_1');
    const next = wrapper.findAll('[aria-label="Labels"] button');
    expect(next[1]?.attributes('aria-pressed')).toBe('true');
    expect(next[0]?.attributes('aria-pressed')).toBe('false');
  });

  it('keeps a sanitized table inside the reading column', async () => {
    const gmailApi: GmailApi = {
      listLabels: async () => labels,
      listThreads: async () => ({
        threads: [
          {
            id: 'threadsame',
            subject: 'Table',
            from: 'Ada',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Rows',
            unread: false
          }
        ],
        nextPageToken: null
      }),
      readThread: async () => ({
        id: 'threadsame',
        messages: [
          {
            id: 'messageone',
            from: 'Ada',
            to: 'Bea',
            cc: null,
            bcc: null,
            subject: 'Table',
            date: '2026-11-02T12:00:00.000Z',
            unread: false,
            text: null,
            html: '<table><tr><td>Cell</td></tr></table><p>Note</p>',
            imagesOmitted: false,
            attachments: []
          }
        ]
      }),
      openLink: async () => ({ opened: true })
    };
    const wrapper = mount(MailView, {
      props: { googleApi: accountsApi([ada]), gmailApi },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    });
    await flushPromises();
    await wrapper.get('ul li button').trigger('click');
    await flushPromises();
    const body = wrapper.get('.mail-body');
    expect(body.find('table').exists()).toBe(true);
    expect(body.find('tr').exists()).toBe(true);
    expect(body.find('td').text()).toBe('Cell');
    expect(body.find('p').text()).toBe('Note');
    expect(wrapper.get('.mail-reading').classes()).toContain('mail-body');
  });
});
