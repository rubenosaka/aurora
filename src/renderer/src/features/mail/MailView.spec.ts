import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { GmailIpcError, type GmailApi, type GmailThreadList } from '../../../../shared/gmail.ts';
import { type GoogleAccountSummary, type GoogleApi } from '../../../../shared/google-accounts.ts';
import MailView from './MailView.vue';

const ada: GoogleAccountSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'ada@example.com',
  displayName: 'Ada',
  status: 'connected',
  canModifyMail: true
};

const grace: GoogleAccountSummary = {
  id: '00000000-0000-4000-8000-000000000002',
  email: 'grace@example.com',
  displayName: 'Grace',
  status: 'connected',
  canModifyMail: true
};

function mailActions(): Pick<
  GmailApi,
  | 'markRead'
  | 'markUnread'
  | 'archiveThread'
  | 'trashThread'
  | 'untrashThread'
  | 'addLabel'
  | 'removeLabel'
  | 'starMessage'
  | 'unstarMessage'
> {
  return {
    markRead: async () => ({ threadId: 'threadsame', unread: false }),
    markUnread: async () => ({ threadId: 'threadsame', unread: true }),
    archiveThread: async () => ({ threadId: 'threadsame' }),
    trashThread: async () => ({ threadId: 'threadsame' }),
    untrashThread: async () => ({ threadId: 'threadsame' }),
    addLabel: async () => ({ threadId: 'threadsame', labelId: 'Label_1' }),
    removeLabel: async () => ({ threadId: 'threadsame', labelId: 'Label_1' }),
    starMessage: async () => ({ threadId: 'threadsame', messageId: 'messageone', starred: true }),
    unstarMessage: async () => ({ threadId: 'threadsame', messageId: 'messageone', starred: false })
  };
}

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
      ...mailActions(),
      listLabels: async () => labels,
      listThreads: async () => ({
        threads: [
          {
            id: 'threadsame',
            subject: 'Hello',
            from: 'Ada',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Hi',
            unread: true,
            starred: false
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
            starred: false,
            labelIds: ['INBOX', 'UNREAD'],
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
      ...mailActions(),
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
          unread: false,
          starred: false
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
      ...mailActions(),
      listLabels: async () => labels,
      listThreads: async () => ({
        threads: [
          {
            id: 'threadsame',
            subject: 'Hello',
            from: 'Ada',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Hi',
            unread: true,
            starred: false
          },
          {
            id: 'threadread',
            subject: 'Read',
            from: 'Bea',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Seen',
            unread: false,
            starred: false
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
    const row = wrapper.get('ul li button.mail-row');
    expect(row.element.tagName).toBe('BUTTON');
    expect((row.element as HTMLButtonElement).tabIndex).toBe(0);
    expect(row.classes()).toContain('is-unread');
    expect(row.text()).toContain('Unread');
    expect(row.find('.mail-unread.is-on').exists()).toBe(true);
    const read = wrapper.findAll('ul li button.mail-row')[1];
    expect(read?.classes().includes('is-unread')).toBe(false);
    expect(read?.text().includes('Unread')).toBe(false);
    expect(read?.find('.mail-unread.is-on').exists()).toBe(false);
    await row.trigger('keydown.enter');
    await row.trigger('click');
    await flushPromises();
    expect(wrapper.find('input[aria-label="Search Gmail"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Labels"]').exists()).toBe(false);
    expect(wrapper.get('button').text()).toContain('Back');
    expect(wrapper.find('nav[aria-label="Labels"]').exists()).toBe(false);
  });

  it('lays the folder sidebar beside a two-line row', async () => {
    const gmailApi: GmailApi = {
      ...mailActions(),
      listLabels: async () => ({
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system', unreadCount: 1 },
          { id: 'SENT', name: 'SENT', type: 'system', unreadCount: null },
          { id: 'Label_1', name: 'Trips', type: 'user', unreadCount: null }
        ]
      }),
      listThreads: async () => ({
        threads: [
          {
            id: 'threadsame',
            subject: 'Hello',
            from: 'Ada',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Hi there',
            unread: true,
            starred: false
          }
        ],
        nextPageToken: null
      }),
      readThread: async () => ({ id: 'threadsame', messages: [] }),
      openLink: async () => ({ opened: true })
    };
    const wrapper = mount(MailView, {
      props: { googleApi: accountsApi([ada]), gmailApi }
    });
    await flushPromises();
    const folders = wrapper.get('nav.mail-folders');
    expect(folders.findAll('.folder-name').map((button) => button.text())).toEqual([
      'INBOX',
      'SENT',
      'Trips'
    ]);
    const line = wrapper.get('.mail-row-line');
    expect(line.get('.mail-line-primary').text()).toContain('Hello');
    expect(line.get('.mail-line-primary').text()).toContain('Hi there');
    expect(line.get('.mail-sender').text()).toBe('Ada');
    expect(line.get('.mail-date').text().length).toBeGreaterThan(0);
    const actions = line.get('.mail-row-actions');
    expect(actions.element.parentElement).toBe(line.element);
    expect(actions.element.closest('button')).toBeNull();
    expect(line.get('.mail-row').element.contains(actions.element)).toBe(false);
    const toggle = wrapper.get('[aria-label="Folders"]');
    expect(toggle.element.tagName).toBe('BUTTON');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(toggle.classes()).toContain('control');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('.mail-workspace').classes()).toContain('is-folders-open');
    await wrapper.get('nav.mail-folders button').trigger('click');
    expect(wrapper.get('.mail-workspace').classes()).not.toContain('is-folders-open');
  });

  it('selects a folder and keeps the active state after the pointer leaves', async () => {
    const queries: Array<string | null> = [];
    const gmailApi: GmailApi = {
      ...mailActions(),
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
      ...mailActions(),
      listLabels: async () => labels,
      listThreads: async () => ({
        threads: [
          {
            id: 'threadsame',
            subject: 'Table',
            from: 'Ada',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Rows',
            unread: false,
            starred: false
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
            starred: false,
            labelIds: [],
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

  it('archives from the keyboard, rolls back a failed change, and asks before Trash', async () => {
    let failArchive = false;
    const calls: string[] = [];
    const gmailApi: GmailApi = {
      ...mailActions(),
      listLabels: async () => labels,
      listThreads: async () => ({
        threads: [
          {
            id: 'threadsame',
            subject: 'Hello',
            from: 'Ada',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Hi',
            unread: true,
            starred: true
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
            starred: false,
            labelIds: ['INBOX', 'UNREAD'],
            text: 'Hello',
            html: null,
            imagesOmitted: false,
            attachments: []
          }
        ]
      }),
      openLink: async () => ({ opened: true }),
      archiveThread: async () => {
        calls.push('archive');
        if (failArchive) throw new GmailIpcError('network');
        return { threadId: 'threadsame' };
      },
      trashThread: async () => {
        calls.push('trash');
        return { threadId: 'threadsame' };
      },
      starMessage: async () => {
        calls.push('star');
        return { threadId: 'threadsame', messageId: 'messageone', starred: true };
      }
    };
    const wrapper = mount(MailView, {
      props: { googleApi: accountsApi([ada]), gmailApi },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    });
    await flushPromises();
    const archive = wrapper.get('[aria-label="Archive"]');
    expect(archive.element.parentElement?.tagName).not.toBe('BUTTON');
    expect(archive.element.tagName).toBe('BUTTON');
    failArchive = true;
    await archive.trigger('keydown.enter');
    await archive.trigger('click');
    await flushPromises();
    expect(calls).toEqual(['archive']);
    expect(wrapper.text()).toContain('could not archive');
    expect(wrapper.find('.mail-row').exists()).toBe(true);
    failArchive = false;
    await wrapper.get('[aria-label="Archive"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.mail-row').exists()).toBe(false);
    const listed = mount(MailView, {
      props: { googleApi: accountsApi([ada]), gmailApi },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    });
    await flushPromises();
    await listed.get('[aria-label="Move to Trash"]').trigger('click');
    expect(listed.get('[role="dialog"]').text()).toContain('Move to Trash?');
    await listed.get('[role="dialog"] button').trigger('keydown.esc');
    expect(calls.includes('trash')).toBe(false);
    await listed.get('.mail-row').trigger('click');
    await flushPromises();
    await listed.get('[aria-label="Star"]').trigger('click');
    await flushPromises();
    expect(calls).toContain('star');
    const readonly = mount(MailView, {
      props: {
        googleApi: accountsApi([{ ...ada, canModifyMail: false }]),
        gmailApi
      },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    });
    await flushPromises();
    const before = calls.length;
    await readonly.get('[aria-label="Mark as read"]').trigger('click');
    await flushPromises();
    expect(calls.length).toBe(before);
    expect(readonly.text()).toContain('Reconnect');
  });

  it('keeps a search row and offers a refresh after a change', async () => {
    const queries: Array<string | null> = [];
    const gmailApi: GmailApi = {
      ...mailActions(),
      listLabels: async () => labels,
      listThreads: async (query) => {
        queries.push(query.query);
        return {
          threads: [
            {
              id: 'threadsame',
              subject: 'Hello',
              from: 'Ada',
              date: '2026-11-02T12:00:00.000Z',
              snippet: 'Hi',
              unread: true,
              starred: false
            }
          ],
          nextPageToken: null
        };
      },
      readThread: async () => ({ id: 'threadsame', messages: [] }),
      openLink: async () => ({ opened: true })
    };
    const wrapper = mount(MailView, {
      props: { googleApi: accountsApi([ada]), gmailApi },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    });
    await flushPromises();
    await wrapper.get('[aria-label="Search Gmail"]').setValue('from:ada@example.com');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    await wrapper.get('[aria-label="Archive"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.mail-row').exists()).toBe(true);
    expect(wrapper.text()).toContain('may no longer match');
    const refresh = wrapper.findAll('button').find((button) => button.text() === 'Refresh');
    await refresh?.trigger('click');
    await flushPromises();
    expect(queries.at(-1)).toBe('from:ada@example.com');
  });
});
