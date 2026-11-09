import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmailIpcError, type GmailApi, type GmailThreadList } from '../../../../shared/gmail.ts';
import { type GoogleAccountSummary, type GoogleApi } from '../../../../shared/google-accounts.ts';
import { createAppRouter } from '../../app/router.ts';
import { pendingMailOpen } from './mail-open.ts';
import MailView from './MailView.vue';

const closeMail: Array<() => void> = [];

function mountMail(options?: Parameters<typeof mount>[1]) {
  const wrapper = mount(MailView, {
    ...options,
    global: {
      ...options?.global,
      plugins: [createAppRouter(), ...(options?.global?.plugins ?? [])]
    }
  });
  closeMail.push(() => {
    wrapper.unmount();
  });
  return wrapper;
}

afterEach(() => {
  for (const close of closeMail) close();
  closeMail.length = 0;
  pendingMailOpen.value = null;
});

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
  | 'composeSeed'
  | 'sendMessage'
  | 'saveDraft'
  | 'openDraft'
  | 'deleteDraft'
  | 'sendDraft'
  | 'pickAttachments'
  | 'dropAttachment'
  | 'downloadAttachment'
  | 'bulkThreads'
  | 'bulkLabel'
  | 'createLabel'
  | 'renameLabel'
  | 'deleteLabel'
  | 'syncStatus'
  | 'setNotifications'
  | 'reportSyncView'
  | 'syncFocus'
  | 'listenSync'
  | 'listenOpen'
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
    unstarMessage: async () => ({
      threadId: 'threadsame',
      messageId: 'messageone',
      starred: false
    }),
    composeSeed: async () => ({ to: ['bob@example.com'], cc: [], subject: 'Re: Hello' }),
    sendMessage: async () => ({ id: 'messagesent', threadId: 'threadsame' }),
    saveDraft: async () => ({
      draftId: 'draftone',
      messageId: 'messagedraft',
      threadId: null
    }),
    openDraft: async () => ({
      locked: false,
      draftId: 'draftone',
      messageId: 'messageone',
      threadId: null,
      kind: 'new' as const,
      to: [],
      cc: [],
      bcc: [],
      subject: 'Saved',
      body: 'Hello',
      subjectLocked: false,
      attachments: []
    }),
    deleteDraft: async () => ({ deleted: true as const }),
    sendDraft: async () => ({ id: 'messagesent', threadId: 'threadsame' }),
    pickAttachments: async () => ({ attachments: [] }),
    dropAttachment: async () => ({ dropped: true as const }),
    downloadAttachment: async () => ({ saved: true }),
    bulkThreads: async () => ({
      succeeded: ['threadsame'],
      failed: [],
      unconfirmed: [],
      notAttempted: []
    }),
    bulkLabel: async () => ({
      succeeded: ['threadsame'],
      failed: [],
      unconfirmed: [],
      notAttempted: []
    }),
    createLabel: async () => ({ id: 'Label_1', name: 'Trips' }),
    renameLabel: async () => ({ id: 'Label_1', name: 'Travel' }),
    deleteLabel: async () => ({ id: 'Label_1' }),
    syncStatus: async () => ({
      state: 'idle' as const,
      lastSuccessAt: '2026-11-09T10:00:00.000Z',
      notifications: 'on' as const,
      content: 'show' as const,
      pending: false,
      notificationsBlocked: false
    }),
    setNotifications: async (preference) => ({
      state: 'idle' as const,
      lastSuccessAt: '2026-11-09T10:00:00.000Z',
      notifications: preference.notifications,
      content: preference.content,
      pending: false,
      notificationsBlocked: false
    }),
    reportSyncView: async () => ({ accepted: true as const }),
    syncFocus: async () => ({
      state: 'idle' as const,
      lastSuccessAt: '2026-11-09T10:00:00.000Z',
      notifications: 'on' as const,
      content: 'show' as const,
      pending: false,
      notificationsBlocked: false
    }),
    listenSync: () => () => undefined,
    listenOpen: () => () => undefined
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
    const wrapper = mountMail({
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
    const wrapper = mountMail({
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
    const wrapper = mountMail({
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
    const wrapper = mountMail({
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
    const wrapper = mountMail({
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
    const wrapper = mountMail({
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
    const wrapper = mountMail({
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
    const listed = mountMail({
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
    const readonly = mountMail({
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
    const wrapper = mountMail({
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

  it('sends once, keeps the text when the outcome is unknown, and asks before discard', async () => {
    let sends = 0;
    const queries: Array<string | null> = [];
    let releaseSend: (() => void) | undefined;
    const gmailApi: GmailApi = {
      ...mailActions(),
      listLabels: async () => ({
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system', unreadCount: 1 },
          { id: 'SENT', name: 'SENT', type: 'system', unreadCount: 0 }
        ]
      }),
      listThreads: async (query) => {
        queries.push(query.labelId);
        return { threads: [], nextPageToken: null };
      },
      readThread: async () => ({ id: 'threadsame', messages: [] }),
      openLink: async () => ({ opened: true }),
      sendMessage: () => {
        sends += 1;
        if (sends === 1) {
          return new Promise(() => undefined);
        }
        releaseSend = () => undefined;
        return Promise.reject(new GmailIpcError('send-unconfirmed'));
      }
    };
    const wrapper = mountMail({
      props: { googleApi: accountsApi([ada, grace]), gmailApi }
    });
    await flushPromises();
    await wrapper.get('button').trigger('click');
    const composer = wrapper.get('[aria-labelledby="compose-title"]');
    expect(composer.text()).toContain('ada@example.com');
    await composer.get('[aria-label="To"]').setValue('bob@example.com');
    await composer.get('[aria-label="To"]').trigger('keydown', { key: 'Enter' });
    await composer.get('[aria-label="Message"]').setValue('Hello');
    await composer
      .get('[aria-label="Message"]')
      .trigger('keydown', { key: 'Enter', ctrlKey: true });
    composer.get('button[aria-busy="true"], button:disabled');
    const send = composer.findAll('button').find((button) => button.text().includes('Send'));
    await send?.trigger('click');
    expect(sends).toBe(1);
    releaseSend?.();
    wrapper.unmount();

    const failed: GmailApi = {
      ...gmailApi,
      sendMessage: async () => {
        throw new GmailIpcError('send-unconfirmed');
      }
    };
    const again = mountMail({ props: { googleApi: accountsApi([ada, grace]), gmailApi: failed } });
    await flushPromises();
    await again.get('button').trigger('click');
    const dialog = again.get('[aria-labelledby="compose-title"]');
    await dialog.get('[aria-label="To"]').setValue('bob@example.com');
    await dialog.get('[aria-label="To"]').trigger('keydown', { key: 'Enter' });
    await dialog.get('[aria-label="Message"]').setValue('Keep this');
    await dialog
      .findAll('button')
      .find((button) => button.text().includes('Send'))
      ?.trigger('click');
    await flushPromises();
    expect(dialog.get('[aria-label="Message"]').element).toHaveProperty('value', 'Keep this');
    expect(dialog.text()).toContain('Check Sent');
    const check = dialog.findAll('button').find((button) => button.text() === 'Check Sent');
    await check?.trigger('click');
    await flushPromises();
    expect(again.find('[aria-labelledby="compose-title"]').exists()).toBe(true);
    expect(queries).toContain('SENT');
    await dialog
      .findAll('button')
      .find((button) => button.text() === 'Close')
      ?.trigger('click');
    expect(again.text()).toContain('Discard this message?');
    await again
      .findAll('button')
      .find((button) => button.text() === 'Keep editing')
      ?.trigger('click');
    expect(again.get('[aria-label="Message"]').element).toHaveProperty('value', 'Keep this');
    await again
      .findAll('button')
      .find((button) => button.text() === 'Close')
      ?.trigger('click');
    await again
      .findAll('button')
      .find((button) => button.text() === 'Discard')
      ?.trigger('click');
    expect(again.find('[aria-labelledby="compose-title"]').exists()).toBe(false);

    const switched = mountMail({
      props: { googleApi: accountsApi([ada, grace]), gmailApi: failed }
    });
    await flushPromises();
    await switched.get('button').trigger('click');
    await switched.get('[aria-label="Message"]').setValue('Draft');
    await switched.get('[aria-label="Google account"]').setValue(grace.id);
    expect(switched.text()).toContain('Discard this message?');
    expect(switched.get('[aria-label="Google account"]').element).toHaveProperty('value', ada.id);
    await switched
      .findAll('button')
      .find((button) => button.text() === 'Keep editing')
      ?.trigger('click');
    expect(switched.get('[aria-label="Message"]').element).toHaveProperty('value', 'Draft');
  });

  it('reaches reply actions from the keyboard and does not open compose for a read-only account', async () => {
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
            from: 'Bob <bob@example.com>',
            to: 'ada@example.com',
            cc: null,
            bcc: null,
            subject: 'Hello',
            date: '2026-11-02T12:00:00.000Z',
            unread: false,
            starred: false,
            labelIds: ['INBOX'],
            text: 'Line',
            html: null,
            imagesOmitted: false,
            attachments: []
          }
        ]
      }),
      openLink: async () => ({ opened: true })
    };
    const wrapper = mountMail({ props: { googleApi: accountsApi([ada]), gmailApi } });
    await flushPromises();
    await wrapper.get('.mail-row').trigger('click');
    await flushPromises();
    expect(wrapper.get('button').text()).toContain('Back');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Reply')
      ?.trigger('click');
    await flushPromises();
    const composer = wrapper.get('[aria-labelledby="compose-title"]');
    expect(composer.text()).toContain('Reply');
    expect(composer.text()).toContain('bob@example.com');
    expect(composer.get('[aria-label="Message"]').element).toHaveProperty(
      'value',
      expect.stringContaining('> Line')
    );
    expect(composer.find('textarea').exists()).toBe(true);
    const readonly = mountMail({
      props: {
        googleApi: accountsApi([{ ...ada, canModifyMail: false }]),
        gmailApi
      }
    });
    await flushPromises();
    await readonly.get('button').trigger('click');
    expect(readonly.find('[aria-labelledby="compose-title"]').exists()).toBe(false);
    expect(readonly.text()).toContain('Reconnect this Google account before changing mail.');
  });

  it('autosaves once after two quiet seconds and does not delete on close', async () => {
    vi.useFakeTimers();
    try {
      const saves: Array<{ draftId: string | null; body: string }> = [];
      let deletes = 0;
      const gmailApi: GmailApi = {
        ...mailActions(),
        listLabels: async () => labels,
        listThreads: async () => ({ threads: [], nextPageToken: null }),
        readThread: async () => ({ id: 'threadsame', messages: [] }),
        openLink: async () => ({ opened: true }),
        saveDraft: async (request) => {
          saves.push({ draftId: request.draftId, body: request.body });
          return { draftId: 'draftone', messageId: 'messageone', threadId: 'threaddraft' };
        },
        deleteDraft: async () => {
          deletes += 1;
          return { deleted: true };
        }
      };
      const wrapper = mountMail({ props: { googleApi: accountsApi([ada]), gmailApi } });
      await flushPromises();
      await wrapper.get('button').trigger('click');
      const composer = wrapper.get('[aria-labelledby="compose-title"]');
      await composer.get('[aria-label="Message"]').setValue('Hello');
      await vi.advanceTimersByTimeAsync(1999);
      expect(saves).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await flushPromises();
      expect(saves).toEqual([{ draftId: null, body: 'Hello' }]);
      expect(composer.text()).toContain('Saved');
      await composer.get('[aria-label="Message"]').setValue('Hello!');
      await vi.advanceTimersByTimeAsync(500);
      await composer.get('[aria-label="Message"]').setValue('Hello again');
      await vi.advanceTimersByTimeAsync(1999);
      expect(saves).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await flushPromises();
      expect(saves[1]).toEqual({ draftId: 'draftone', body: 'Hello again' });
      await composer
        .findAll('button')
        .find((button) => button.text() === 'Close')
        ?.trigger('click');
      expect(wrapper.find('[aria-labelledby="compose-title"]').exists()).toBe(false);
      expect(deletes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create another draft after an unconfirmed create', async () => {
    vi.useFakeTimers();
    try {
      let saves = 0;
      const gmailApi: GmailApi = {
        ...mailActions(),
        listLabels: async () => labels,
        listThreads: async () => ({ threads: [], nextPageToken: null }),
        readThread: async () => ({ id: 'threadsame', messages: [] }),
        openLink: async () => ({ opened: true }),
        saveDraft: async () => {
          saves += 1;
          throw new GmailIpcError('save-unconfirmed');
        }
      };
      const wrapper = mountMail({ props: { googleApi: accountsApi([ada]), gmailApi } });
      await flushPromises();
      await wrapper.get('button').trigger('click');
      const composer = wrapper.get('[aria-labelledby="compose-title"]');
      await composer.get('[aria-label="Message"]').setValue('Hello');
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      expect(saves).toBe(1);
      expect(composer.text()).toContain('Check Drafts');
      await composer.get('[aria-label="Message"]').setValue('Hello again');
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();
      expect(saves).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops autosave on a conflict and overwrites only from the explicit action', async () => {
    vi.useFakeTimers();
    try {
      const confirmed: boolean[] = [];
      let conflict = false;
      const opens: string[] = [];
      const gmailApi: GmailApi = {
        ...mailActions(),
        listLabels: async () => labels,
        listThreads: async () => ({ threads: [], nextPageToken: null }),
        readThread: async () => ({ id: 'threadsame', messages: [] }),
        openLink: async () => ({ opened: true }),
        saveDraft: async (request) => {
          confirmed.push(request.replaceConfirmed);
          if (conflict && request.replaceConfirmed !== true)
            throw new GmailIpcError('draft-conflict');
          return {
            draftId: 'draftone',
            messageId: request.replaceConfirmed ? 'messagetwo' : 'messageone',
            threadId: 'threaddraft'
          };
        },
        openDraft: async (request) => {
          opens.push(request.threadId);
          return {
            locked: false,
            draftId: 'draftone',
            messageId: 'messageremote',
            threadId: null,
            kind: 'new' as const,
            to: ['bob@example.com'],
            cc: [],
            bcc: [],
            subject: 'Remote',
            body: 'From Gmail',
            subjectLocked: false,
            attachments: []
          };
        }
      };
      const wrapper = mountMail({ props: { googleApi: accountsApi([ada]), gmailApi } });
      await flushPromises();
      await wrapper.get('button').trigger('click');
      const composer = wrapper.get('[aria-labelledby="compose-title"]');
      await composer.get('[aria-label="Message"]').setValue('Local');
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      conflict = true;
      await composer.get('[aria-label="Message"]').setValue('Local edit');
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      expect(composer.text()).toContain('This draft changed in Gmail');
      const before = confirmed.length;
      await composer.get('[aria-label="Message"]').setValue('Still local');
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      expect(confirmed).toHaveLength(before);
      await composer
        .findAll('button')
        .find((button) => button.text() === 'Overwrite Gmail draft')
        ?.trigger('click');
      await flushPromises();
      expect(confirmed.at(-1)).toBe(true);
      conflict = true;
      await composer.get('[aria-label="Message"]').setValue('Edited after overwrite');
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      await composer
        .findAll('button')
        .find((button) => button.text() === 'Reload Gmail version')
        ?.trigger('click');
      await flushPromises();
      expect(opens).toEqual(['threaddraft']);
      expect(wrapper.get('[aria-label="Message"]').element).toHaveProperty('value', 'From Gmail');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an HTML draft read-only and asks before a permanent delete', async () => {
    let saves = 0;
    let deletes = 0;
    const gmailApi: GmailApi = {
      ...mailActions(),
      listLabels: async () => labels,
      listThreads: async () => ({
        threads: [
          {
            id: 'threaddraft',
            subject: 'Rich',
            from: 'Ada',
            date: '2026-11-02T12:00:00.000Z',
            snippet: 'Hi',
            unread: false,
            starred: false
          }
        ],
        nextPageToken: null
      }),
      readThread: async () => ({
        id: 'threaddraft',
        messages: [
          {
            id: 'messageone',
            from: 'Ada',
            to: 'bob@example.com',
            cc: null,
            bcc: null,
            subject: 'Rich',
            date: '2026-11-02T12:00:00.000Z',
            unread: false,
            starred: false,
            labelIds: ['DRAFT'],
            text: 'Hi',
            html: '<p>Hi</p>',
            imagesOmitted: false,
            attachments: [
              {
                fileName: 'notes.txt',
                mimeType: 'text/plain',
                size: 5,
                partId: '1',
                attachmentId: 'attachone'
              }
            ]
          }
        ]
      }),
      openLink: async () => ({ opened: true }),
      openDraft: async () => ({
        locked: true,
        draftId: 'draftone',
        messageId: 'messageone',
        threadId: null,
        kind: 'new' as const,
        to: ['bob@example.com'],
        cc: [],
        bcc: [],
        subject: 'Rich',
        body: 'Hi',
        subjectLocked: false,
        attachments: []
      }),
      saveDraft: async () => {
        saves += 1;
        return { draftId: 'draftone', messageId: 'messageone', threadId: null };
      },
      deleteDraft: async () => {
        deletes += 1;
        return { deleted: true };
      },
      downloadAttachment: async () => ({ saved: true })
    };
    const wrapper = mountMail({ props: { googleApi: accountsApi([ada]), gmailApi } });
    await flushPromises();
    await wrapper.get('.mail-row').trigger('click');
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Download')
      ?.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Saved.');
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Edit draft'))
      ?.trigger('click');
    await flushPromises();
    const locked = wrapper.get('[aria-labelledby="compose-title"]');
    expect(locked.text()).toContain('cannot edit this draft');
    expect(locked.find('textarea').exists()).toBe(false);
    expect(locked.findAll('button').some((button) => button.text().includes('Send'))).toBe(false);
    expect(locked.findAll('button').some((button) => button.text() === 'Delete draft')).toBe(false);
    expect(saves).toBe(0);
    wrapper.unmount();

    const editable: GmailApi = {
      ...gmailApi,
      openDraft: async () => ({
        locked: false,
        draftId: 'draftone',
        messageId: 'messageone',
        threadId: 'threaddraft',
        kind: 'new' as const,
        to: ['bob@example.com'],
        cc: [],
        bcc: [],
        subject: 'Plain',
        body: 'Hello',
        subjectLocked: false,
        attachments: []
      })
    };
    const again = mountMail({ props: { googleApi: accountsApi([ada]), gmailApi: editable } });
    await flushPromises();
    await again.get('.mail-row').trigger('click');
    await flushPromises();
    await again
      .findAll('button')
      .find((button) => button.text().includes('Edit draft'))
      ?.trigger('click');
    await flushPromises();
    const composer = again.get('[aria-labelledby="compose-title"]');
    await composer
      .findAll('button')
      .find((button) => button.text() === 'Delete draft')
      ?.trigger('click');
    expect(again.text()).toContain('Gmail will permanently delete this draft. This is not Trash.');
    await again
      .findAll('button')
      .find((button) => button.text() === 'Keep')
      ?.trigger('click');
    expect(deletes).toBe(0);
    expect(again.find('[aria-labelledby="compose-title"]').exists()).toBe(true);
    await composer
      .findAll('button')
      .find((button) => button.text() === 'Delete draft')
      ?.trigger('click');
    await again
      .findAll('button')
      .find((button) => button.text() === 'Delete')
      ?.trigger('click');
    await flushPromises();
    expect(deletes).toBe(1);
    expect(again.find('[aria-labelledby="compose-title"]').exists()).toBe(false);
  });

  it('selects only the visible page and reports a partial bulk result', async () => {
    const threads = [
      {
        id: 'threadone',
        subject: 'Hello',
        from: 'Ada',
        date: '2026-11-02T12:00:00.000Z',
        snippet: 'Hi',
        unread: true,
        starred: false
      },
      {
        id: 'threadtwo',
        subject: 'Next',
        from: 'Grace',
        date: '2026-11-02T12:00:00.000Z',
        snippet: 'There',
        unread: false,
        starred: true
      }
    ];
    let page = 0;
    const bulkCalls: string[][] = [];
    let releaseBulk:
      | ((value: {
          succeeded: string[];
          failed: { threadId: string; code: 'not-found' }[];
          unconfirmed: string[];
          notAttempted: string[];
        }) => void)
      | undefined;
    const gmailApi: GmailApi = {
      ...mailActions(),
      listLabels: async () => ({
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system', unreadCount: 1 },
          { id: 'Label_1', name: 'Trips', type: 'user', unreadCount: 0 }
        ]
      }),
      listThreads: async () => ({
        threads: page === 0 ? threads : threads.slice(1),
        nextPageToken: page === 0 ? 'page-2' : null
      }),
      readThread: async () => ({ id: 'threadone', messages: [] }),
      openLink: async () => ({ opened: true }),
      bulkThreads: (request) => {
        bulkCalls.push(request.threadIds);
        return new Promise((resolve) => {
          releaseBulk = resolve;
        });
      },
      createLabel: async () => ({ id: 'Label_2', name: 'Travel' })
    };
    const wrapper = mountMail({ props: { googleApi: accountsApi([ada, grace]), gmailApi } });
    await flushPromises();
    expect(wrapper.find('[aria-label="Select all visible conversations"]').exists()).toBe(true);
    const hello = wrapper.get('[aria-label="Select Hello"]');
    expect(hello.element.closest('.mail-row')).toBeNull();
    await hello.setValue(true);
    expect(wrapper.text()).toContain('1 selected');
    expect(
      (wrapper.get('[aria-label="Select all visible conversations"]').element as HTMLInputElement)
        .indeterminate
    ).toBe(true);
    await wrapper.get('[aria-label="Select all visible conversations"]').setValue(true);
    expect(wrapper.text()).toContain('2 selected');
    expect(wrapper.text()).toContain('Star marks only the newest message');
    page = 1;
    const next = wrapper.findAll('button').find((button) => button.text() === 'Next');
    await next?.trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('selected');
    await wrapper.get('[aria-label="Select Next"]').setValue(true);
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Mark as read')
      ?.trigger('click');
    expect(bulkCalls).toEqual([['threadtwo']]);
    const account = wrapper.get('[aria-label="Google account"]');
    await account.setValue(grace.id);
    releaseBulk?.({
      succeeded: ['threadtwo'],
      failed: [],
      unconfirmed: [],
      notAttempted: []
    });
    await flushPromises();
    expect(wrapper.text()).not.toContain('Updated 1 conversations.');
    wrapper.unmount();

    const readonly: GmailApi = {
      ...gmailApi,
      bulkThreads: async () => ({
        succeeded: [],
        failed: [],
        unconfirmed: [],
        notAttempted: []
      })
    };
    const quiet = mountMail({
      props: {
        googleApi: accountsApi([{ ...ada, canModifyMail: false }]),
        gmailApi: readonly
      }
    });
    await flushPromises();
    expect(quiet.find('button[aria-label="Labels"]').exists()).toBe(false);
    expect(quiet.find('[aria-label="Select all visible conversations"]').exists()).toBe(false);
  });

  it('shows sync status, keeps another account still, and opens a notification', async () => {
    const reads: string[] = [];
    const preferences: string[] = [];
    let syncListener: ((event: unknown) => void) | undefined;
    const gmailApi: GmailApi = {
      ...mailActions(),
      listLabels: async () => labels,
      listThreads: async () => ({ threads: [], nextPageToken: null }),
      readThread: async (_accountId, threadId) => {
        reads.push(threadId);
        return { id: threadId, messages: [] };
      },
      openLink: async () => ({ opened: true }),
      syncStatus: async () => ({
        state: 'idle' as const,
        lastSuccessAt: '2026-11-09T10:00:00.000Z',
        notifications: 'on' as const,
        content: 'show' as const,
        pending: false,
        notificationsBlocked: false
      }),
      setNotifications: async (preference) => {
        preferences.push(preference.content);
        return {
          state: 'idle' as const,
          lastSuccessAt: '2026-11-09T10:00:00.000Z',
          notifications: preference.notifications,
          content: preference.content,
          pending: false,
          notificationsBlocked: false
        };
      },
      listenSync: (listener) => {
        syncListener = listener as (event: unknown) => void;
        return () => undefined;
      }
    };
    const wrapper = mountMail({
      props: {
        googleApi: {
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
        },
        gmailApi
      }
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Updated');
    expect(wrapper.text()).toContain('Notify me of new mail');
    await wrapper.get('[aria-label="Show sender and subject"]').setValue(false);
    await flushPromises();
    expect(preferences).toEqual(['hide']);
    syncListener?.({
      accountId: grace.id,
      refresh: 'page',
      threadId: null
    });
    await flushPromises();
    expect(reads).toEqual([]);
    pendingMailOpen.value = { accountId: ada.id, threadId: 'threadsame' };
    await flushPromises();
    expect(reads).toEqual(['threadsame']);
    pendingMailOpen.value = null;
  });
});
