import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type DatabaseSync } from 'node:sqlite';
import { type GoogleAccountSummary } from '../../shared/google-accounts.ts';
import { openAuroraDatabase } from '../persistence/database.ts';
import { OAuthFlowError } from '../oauth/errors.ts';
import { PersistenceError } from '../persistence/errors.ts';
import { GmailError } from './errors.ts';
import { createElectronNotifier, type SyncToastInput } from './notifier.ts';
import { createMailboxSync, syncIntervalMs, type MailboxSync } from './sync.ts';

const ada = '00000000-0000-4000-8000-000000000001';
const grace = '00000000-0000-4000-8000-000000000002';
const directories: string[] = [];
const databases: DatabaseSync[] = [];

after(() => {
  for (const database of databases) database.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function seedAccount(file: DatabaseSync, id: string, email: string): void {
  const clientId = '00000000-0000-4000-8000-000000000010';
  const existing = file.prepare('SELECT id FROM oauth_clients WHERE id = ?').get(clientId);
  if (existing === undefined) {
    file
      .prepare(
        `INSERT INTO oauth_clients (id, provider, client_id, created_at, updated_at)
         VALUES (?, 'google', 'client.apps.googleusercontent.com', ?, ?)`
      )
      .run(clientId, '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z');
  }
  file
    .prepare(
      `INSERT INTO connected_accounts (
         id, provider, provider_account_id, display_name, email, status, oauth_client_id,
         granted_scopes, created_at, updated_at
       ) VALUES (?, 'google', ?, ?, ?, 'connected', ?, ?, ?, ?)`
    )
    .run(
      id,
      id,
      email,
      email,
      clientId,
      'openid email profile https://www.googleapis.com/auth/gmail.modify',
      '2026-11-09T12:00:00.000Z',
      '2026-11-09T12:00:00.000Z'
    );
}

function openTemp(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), 'aurora-sync-'));
  directories.push(directory);
  const opened = openAuroraDatabase(join(directory, 'aurora.sqlite'));
  databases.push(opened);
  return opened;
}

function summary(
  id: string,
  email: string,
  status: GoogleAccountSummary['status'] = 'connected'
): GoogleAccountSummary {
  return { id, email, displayName: email, status, canModifyMail: true };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function cursor(file: DatabaseSync, accountId = ada): string | null {
  const row = file
    .prepare('SELECT history_id FROM mailbox_sync WHERE account_id = ?')
    .get(accountId) as { history_id: string } | undefined;
  return row?.history_id ?? null;
}

function notified(file: DatabaseSync, accountId = ada): string[] {
  return (
    file
      .prepare('SELECT message_id FROM notified_messages WHERE account_id = ? ORDER BY message_id')
      .all(accountId) as Array<{ message_id: string }>
  ).map((row) => row.message_id);
}

function refreshed(state: { events: Array<{ payload: unknown }> }): string | null {
  let found: string | null = null;
  for (const event of state.events) {
    const payload = event.payload;
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'refresh' in payload &&
      typeof payload.refresh === 'string' &&
      payload.refresh !== 'none'
    ) {
      found = payload.refresh;
    }
  }
  return found;
}

function metadata(id: string, from: string, subject: string, labelIds: string[] | null): unknown {
  return {
    id,
    threadId: 'threadsame',
    ...(labelIds === null ? {} : { labelIds }),
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject }
      ]
    }
  };
}

function added(recordId: string, messageId: string, labelIds: string[]): unknown {
  return {
    id: recordId,
    messagesAdded: [{ message: { id: messageId, threadId: 'threadsame', labelIds } }]
  };
}

interface Box {
  file: DatabaseSync;
  sync: MailboxSync;
  calls: Array<{ accountId: string; url: string }>;
  toasts: SyncToastInput[];
  events: Array<{ channel: string; payload: unknown }>;
  accounts: GoogleAccountSummary[];
  bulk: Set<string>;
  clock: Date;
  delays: number[];
  answer: (accountId: string, url: string) => unknown;
}

function box(answer?: Box['answer']): Box {
  const file = openTemp();
  seedAccount(file, ada, 'ada@example.com');
  const calls: Box['calls'] = [];
  const toasts: SyncToastInput[] = [];
  const events: Box['events'] = [];
  const accounts = [summary(ada, 'ada@example.com')];
  const bulk = new Set<string>();
  const delays: number[] = [];
  const state = {
    file,
    calls,
    toasts,
    events,
    accounts,
    bulk,
    clock: new Date('2026-11-09T12:00:00.000Z'),
    delays,
    answer:
      answer ??
      ((_accountId: string, url: string) => {
        if (url.endsWith('/profile')) return { historyId: '100' };
        return { historyId: '100' };
      }),
    sync: undefined as unknown as MailboxSync
  };
  state.sync = createMailboxSync({
    database: file,
    listAccounts: () => state.accounts,
    bulkBusy: (accountId) => state.bulk.has(accountId),
    now: () => state.clock,
    schedule: {
      set(delay) {
        delays.push(delay);
        return () => undefined;
      }
    },
    notify: { show: (input) => toasts.push(input) },
    emit: (channel, payload) => events.push({ channel, payload }),
    read(accountId, url) {
      calls.push({ accountId, url });
      return Promise.resolve(state.answer(accountId, url));
    }
  });
  return state;
}

function advance(state: Box, seconds: number): void {
  state.clock = new Date(state.clock.getTime() + seconds * 1000);
}

describe('mailbox sync', () => {
  it('stores a profile cursor and does not notify existing mail', async () => {
    const state = box();
    state.sync.focus(ada);
    await tick();
    assert.equal(cursor(state.file), '100');
    assert.equal(state.toasts.length, 0);
    assert.equal(
      state.calls.some((call) => call.url.includes('/threads')),
      false
    );
    assert.equal(state.calls[0]?.url.endsWith('/profile'), true);
  });

  it('uses the stored cursor and does not list threads when history is empty', async () => {
    const state = box();
    state.sync.focus(ada);
    await tick();
    state.calls.length = 0;
    advance(state, 31);
    state.sync.focus(ada);
    await tick();
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0]?.url.includes('startHistoryId=100'), true);
    assert.equal(state.calls[0]?.url.includes('/threads'), false);
  });

  it('notifies a new inbox message once and opens it from the toast', async () => {
    const state = box((_accountId, url) => {
      if (url.includes('/messages/')) {
        return metadata('messageone', 'Grace <grace@example.com>', 'Hello', ['INBOX']);
      }
      return { historyId: '110', history: [added('110', 'messageone', ['INBOX'])] };
    });
    state.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    state.sync.reportView({ accountId: ada, labelId: 'INBOX', query: null, threadId: null });
    state.sync.focus(ada);
    await tick();
    assert.equal(state.toasts.length, 1);
    assert.equal(state.toasts[0]?.title, 'Grace <grace@example.com>');
    assert.equal(state.toasts[0]?.body, 'Hello');
    assert.deepEqual(notified(state.file), ['messageone']);
    state.toasts[0]?.onClick();
    assert.equal(state.events.at(-1)?.channel, 'gmail:notification-open');
    assert.deepEqual(state.events.at(-1)?.payload, { accountId: ada, threadId: 'threadsame' });
    state.toasts.length = 0;
    advance(state, 31);
    state.sync.focus(ada);
    await tick();
    assert.equal(state.toasts.length, 0);
  });

  it('does not notify spam, sent mail, owner mail, incomplete metadata, or a move into Inbox', async () => {
    const state = box((_accountId, url) => {
      if (url.includes('/messages/messageown')) {
        return metadata('messageown', 'Ada <ada@example.com>', 'Mine', ['INBOX']);
      }
      if (url.includes('/messages/messagegap')) {
        return metadata('messagegap', 'Grace <grace@example.com>', 'Gap', null);
      }
      if (url.includes('/messages/')) {
        return metadata('messageone', 'Grace <grace@example.com>', 'Hello', ['INBOX']);
      }
      return {
        historyId: '140',
        history: [
          added('111', 'messagea', ['SPAM']),
          added('112', 'messageb', ['TRASH']),
          added('113', 'messagec', ['DRAFT']),
          added('114', 'messaged', ['SENT']),
          added('115', 'messagee', ['CHAT']),
          {
            id: '116',
            messagesAdded: [
              { message: { id: 'messageown', threadId: 'threadsame', labelIds: ['INBOX'] } }
            ]
          },
          {
            id: '117',
            messagesAdded: [
              { message: { id: 'messagegap', threadId: 'threadsame', labelIds: ['INBOX'] } }
            ]
          },
          {
            id: '118',
            labelsAdded: [
              {
                message: { id: 'messageold', threadId: 'threadold', labelIds: ['INBOX'] },
                labelIds: ['INBOX']
              }
            ]
          }
        ]
      };
    });
    state.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    state.sync.focus(ada);
    await tick();
    assert.equal(state.toasts.length, 0);
    assert.deepEqual(notified(state.file), []);
  });

  it('summarizes more than three new messages and hides content when asked', async () => {
    const state = box((_accountId, url) => {
      const id = url.split('/messages/')[1]?.split('?')[0];
      if (id !== undefined)
        return metadata(id, `Person <${id}@example.com>`, `Subject ${id}`, ['INBOX']);
      return {
        historyId: '150',
        history: [
          {
            id: '151',
            messagesAdded: [{ message: { id: 'm1', threadId: 'threadsame', labelIds: ['INBOX'] } }]
          },
          {
            id: '152',
            messagesAdded: [{ message: { id: 'm2', threadId: 'threadsame', labelIds: ['INBOX'] } }]
          },
          {
            id: '153',
            messagesAdded: [{ message: { id: 'm3', threadId: 'threadsame', labelIds: ['INBOX'] } }]
          },
          {
            id: '154',
            messagesAdded: [{ message: { id: 'm4', threadId: 'threadsame', labelIds: ['INBOX'] } }]
          }
        ]
      };
    });
    state.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    state.sync.setPreferences({ accountId: ada, notifications: 'on', content: 'hide' });
    state.sync.focus(ada);
    await tick();
    assert.equal(state.toasts.length, 4);
    assert.equal(state.toasts[0]?.title, 'New email received');
    assert.equal(state.toasts[0]?.body, 'New email received');
    assert.equal(state.toasts[3]?.body, '1 more new messages');
    assert.equal(
      state.toasts.some((toast) => toast.title.includes('@')),
      false
    );
    assert.deepEqual(notified(state.file), ['m1', 'm2', 'm3', 'm4']);
  });

  it('keeps synchronizing when notifications are off and does not announce the backlog', async () => {
    const state = box((_accountId, url) => {
      if (url.includes('/messages/')) {
        return metadata('messageone', 'Grace <grace@example.com>', 'Hello', ['INBOX']);
      }
      return { historyId: '160', history: [added('160', 'messageone', ['INBOX'])] };
    });
    state.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    state.sync.setPreferences({ accountId: ada, notifications: 'off', content: 'show' });
    state.sync.focus(ada);
    await tick();
    assert.equal(state.toasts.length, 0);
    assert.equal(cursor(state.file), '160');
    assert.deepEqual(notified(state.file), ['messageone']);
    state.sync.setPreferences({ accountId: ada, notifications: 'on', content: 'show' });
    advance(state, 31);
    state.sync.focus(ada);
    await tick();
    assert.equal(state.toasts.length, 0);
  });

  it('replaces an expired cursor without notifying and refreshes the open view', async () => {
    const state = box((_accountId, url) => {
      if (url.endsWith('/profile')) return { historyId: '900' };
      throw new GmailError('not-found', 404);
    });
    state.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    state.sync.reportView({ accountId: ada, labelId: 'INBOX', query: null, threadId: null });
    state.sync.focus(ada);
    await tick();
    assert.equal(cursor(state.file), '900');
    assert.equal(state.toasts.length, 0);
    assert.equal(
      state.events.some((event) => {
        const payload = event.payload;
        return (
          typeof payload === 'object' &&
          payload !== null &&
          'refresh' in payload &&
          payload.refresh === 'page'
        );
      }),
      true
    );
  });

  it('leaves the cursor unchanged when the network fails', async () => {
    const state = box(() => {
      throw new GmailError('network');
    });
    state.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    state.sync.focus(ada);
    await tick();
    assert.equal(cursor(state.file), '100');
    assert.equal(state.sync.status(ada).state, 'offline');
  });

  it('stops one account after invalid_grant and continues the other', async () => {
    const state = box((accountId, url) => {
      if (accountId === ada) throw new GmailError('needs-reauth');
      if (url.endsWith('/profile')) return { historyId: '50' };
      return { historyId: '50' };
    });
    state.accounts.push(summary(grace, 'grace@example.com'));
    seedAccount(state.file, grace, 'grace@example.com');
    state.sync.start();
    await tick();
    assert.equal(state.sync.status(ada).state, 'needs-reauth');
    assert.equal(cursor(state.file, grace), '50');
    assert.equal(
      state.calls.some(
        (call) => call.accountId === grace && call.url.includes('startHistoryId=100')
      ),
      false
    );
  });

  it('ignores a second sync while the first is in flight', async () => {
    let release: (value: unknown) => void = () => undefined;
    const state = box(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    state.sync.focus(ada);
    state.sync.focus(ada);
    await tick();
    assert.equal(state.calls.length, 1);
    release({ historyId: '100' });
    await tick();
    assert.equal(state.calls.length, 1);
  });

  it('records a pending sync during bulk work and runs it when bulk finishes', async () => {
    const state = box();
    state.bulk.add(ada);
    state.sync.focus(ada);
    await tick();
    assert.equal(state.calls.length, 0);
    assert.equal(state.sync.status(ada).pending, true);
    assert.equal(state.sync.status(ada).state, 'skipped');
    state.bulk.delete(ada);
    state.sync.afterBulk(ada);
    await tick();
    assert.equal(state.calls.length, 1);
    assert.equal(cursor(state.file), '100');
  });

  it('does not write a cursor after shutdown', async () => {
    let release: (value: unknown) => void = () => undefined;
    const state = box(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    state.sync.focus(ada);
    await tick();
    state.sync.shutdown();
    release({ historyId: '100' });
    await tick();
    assert.equal(cursor(state.file), null);
  });

  it('does not sync while suspended and syncs once on resume', async () => {
    const state = box();
    state.sync.suspend();
    state.sync.start();
    await tick();
    assert.equal(state.calls.length, 0);
    state.sync.resume();
    await tick();
    assert.equal(state.calls.length, 1);
    assert.equal(state.delays.includes(syncIntervalMs), true);
  });

  it('follows at most five history pages and keeps the last applied record', async () => {
    let page = 0;
    const state = box((_accountId, url) => {
      if (!url.includes('/history')) return { historyId: '1' };
      page += 1;
      return {
        historyId: '999',
        nextPageToken: `page-${page}`,
        history: [
          {
            id: String(page),
            messagesDeleted: [{ message: { id: `m${page}`, threadId: 'threadsame' } }]
          }
        ]
      };
    });
    state.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '1', '2026-11-09T11:00:00.000Z');
    state.sync.reportView({ accountId: ada, labelId: null, query: 'from:grace', threadId: null });
    state.sync.focus(ada);
    await tick();
    assert.equal(state.calls.length, 5);
    assert.equal(cursor(state.file), '5');
    assert.equal(state.toasts.length, 0);
    assert.equal(
      state.events.some((event) => {
        const payload = event.payload;
        return (
          typeof payload === 'object' &&
          payload !== null &&
          'refresh' in payload &&
          payload.refresh === 'page'
        );
      }),
      true
    );
  });

  it('refreshes conservatively when history has no specific change', async () => {
    const state = box(() => ({
      historyId: '130',
      history: [{ id: '130', messages: [{ id: 'messageone', threadId: 'threadsame' }] }]
    }));
    state.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    state.sync.reportView({
      accountId: ada,
      labelId: 'INBOX',
      query: null,
      threadId: 'threadsame'
    });
    state.sync.focus(ada);
    await tick();
    assert.equal(state.toasts.length, 0);
    assert.equal(
      state.events.some((event) => {
        const payload = event.payload;
        return (
          typeof payload === 'object' &&
          payload !== null &&
          'refresh' in payload &&
          payload.refresh === 'thread'
        );
      }),
      true
    );
  });

  it('rejects an unknown account before a read', async () => {
    const state = box();
    assert.throws(
      () => state.sync.status(grace),
      (error: unknown) => error instanceof GmailError
    );
    assert.equal(state.calls.length, 0);
  });

  it('refreshes the open folder for a label change and only the label list otherwise', async () => {
    const history = {
      historyId: '120',
      history: [
        {
          id: '120',
          labelsRemoved: [
            {
              message: { id: 'messageone', threadId: 'threadother', labelIds: ['INBOX'] },
              labelIds: ['UNREAD']
            }
          ]
        }
      ]
    };
    const inbox = box(() => history);
    inbox.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    inbox.sync.reportView({ accountId: ada, labelId: 'INBOX', query: null, threadId: null });
    inbox.sync.focus(ada);
    await tick();
    assert.equal(refreshed(inbox), 'page');
    const elsewhere = box(() => history);
    elsewhere.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    elsewhere.sync.reportView({
      accountId: ada,
      labelId: 'Label_1',
      query: null,
      threadId: 'threadsame'
    });
    elsewhere.sync.focus(ada);
    await tick();
    assert.equal(refreshed(elsewhere), 'labels');
  });

  it('does not advance the cursor when metadata cannot be read', async () => {
    const offline = box((_accountId, url) => {
      if (url.includes('/messages/')) throw new GmailError('network');
      return { historyId: '110', history: [added('110', 'messageone', ['INBOX'])] };
    });
    offline.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    offline.sync.focus(ada);
    await tick();
    assert.equal(cursor(offline.file), '100');
    assert.equal(offline.sync.status(ada).state, 'offline');
    const held = box((_accountId, url) => {
      if (url.includes('/messages/')) return { id: 'someoneelse' };
      return { historyId: '110', history: [added('110', 'messageone', ['INBOX'])] };
    });
    held.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    held.sync.focus(ada);
    await tick();
    assert.equal(cursor(held.file), '100');
    assert.equal(held.sync.status(ada).state, 'idle');
    assert.equal(held.toasts.length, 0);
  });

  it('maps quota, scope, oauth, and persistence failures without moving the cursor', async () => {
    const limited = box(() => {
      throw new GmailError('rate-limited');
    });
    limited.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    limited.sync.focus(ada);
    await tick();
    assert.equal(cursor(limited.file), '100');
    assert.equal(limited.sync.status(ada).state, 'idle');
    const denied = box(() => {
      throw new GmailError('permission-denied', 403, 'insufficientPermissions');
    });
    denied.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    denied.sync.focus(ada);
    await tick();
    assert.equal(denied.sync.status(ada).state, 'needs-reauth');
    denied.calls.length = 0;
    advance(denied, 31);
    denied.sync.focus(ada);
    await tick();
    assert.equal(denied.calls.length, 0);
    const busy = box(() => {
      throw new OAuthFlowError('operation-in-progress');
    });
    busy.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    busy.sync.focus(ada);
    await tick();
    assert.equal(busy.sync.status(ada).state, 'skipped');
    const revoked = box(() => {
      throw new PersistenceError('decrypt-failed');
    });
    revoked.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    revoked.sync.focus(ada);
    await tick();
    assert.equal(revoked.sync.status(ada).state, 'needs-reauth');
    const broken = box(() => {
      throw new PersistenceError('constraint');
    });
    broken.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    broken.sync.focus(ada);
    await tick();
    assert.equal(broken.sync.status(ada).state, 'idle');
  });

  it('skips a revoked account, ignores a recent focus, and resets a reconnected account', async () => {
    const state = box();
    state.accounts[0] = { ...summary(ada, 'ada@example.com'), status: 'needs_reauth' };
    state.sync.start();
    await tick();
    assert.equal(state.calls.length, 0);
    assert.equal(state.sync.status(ada).state, 'needs-reauth');
    state.accounts[0] = summary(ada, 'ada@example.com');
    state.sync.focus(ada);
    await tick();
    assert.equal(cursor(state.file), '100');
    const calls = state.calls.length;
    state.sync.focus(ada);
    await tick();
    assert.equal(state.calls.length, calls);
    state.sync.accountConnected(ada);
    await tick();
    assert.equal(cursor(state.file), '100');
    assert.equal(state.toasts.length, 0);
  });

  it('clears the open view on disconnect and keeps a pending sync across suspend', async () => {
    const state = box(() => ({
      historyId: '120',
      history: [
        {
          id: '120',
          labelsAdded: [
            {
              message: { id: 'messageone', threadId: 'threadsame', labelIds: ['INBOX'] },
              labelIds: ['INBOX']
            }
          ]
        }
      ]
    }));
    state.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    state.sync.reportView({ accountId: ada, labelId: 'INBOX', query: null, threadId: null });
    state.sync.accountDisconnected(ada);
    state.sync.focus(ada);
    await tick();
    assert.equal(refreshed(state), null);
    assert.equal(state.toasts.length, 0);
    const pending = box();
    pending.bulk.add(ada);
    pending.sync.focus(ada);
    await tick();
    pending.sync.suspend();
    pending.sync.afterBulk(ada);
    assert.equal(pending.calls.length, 0);
    assert.equal(pending.sync.status(ada).pending, true);
    pending.bulk.delete(ada);
    pending.sync.resume();
    await tick();
    assert.equal(pending.calls.length, 1);
  });

  it('keeps the cursor when a history page is empty or unreadable', async () => {
    const empty = box(() => ({ historyId: '500', nextPageToken: 'more', history: [] }));
    empty.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    empty.sync.focus(ada);
    await tick();
    assert.equal(cursor(empty.file), '100');
    assert.equal(empty.sync.status(ada).state, 'idle');
    const broken = box(() => ({ historyId: 'abc' }));
    broken.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    broken.sync.focus(ada);
    await tick();
    assert.equal(cursor(broken.file), '100');
    assert.equal(broken.sync.status(ada).state, 'idle');
    const profile = box(() => []);
    profile.sync.focus(ada);
    await tick();
    assert.equal(cursor(profile.file), null);
  });

  it('prefixes a second account, records a blocked toast, and ignores a stale click', async () => {
    const state = box((_accountId, url) => {
      if (url.includes('/messages/')) {
        return metadata(
          'messageone',
          'Grace <grace@example.com>',
          `Hello\u0007 ${'x'.repeat(200)}`,
          ['INBOX']
        );
      }
      return { historyId: '110', history: [added('110', 'messageone', ['INBOX'])] };
    });
    seedAccount(state.file, grace, 'grace@example.com');
    state.accounts.push(summary(grace, 'grace@example.com'));
    state.file
      .prepare('INSERT INTO mailbox_sync (account_id, history_id, updated_at) VALUES (?, ?, ?)')
      .run(ada, '100', '2026-11-09T11:00:00.000Z');
    state.sync.focus(ada);
    await tick();
    assert.equal(state.toasts[0]?.title.startsWith('ada@example.com'), true);
    assert.equal(state.toasts[0]?.body.includes('\u0007'), false);
    assert.equal(state.toasts[0]?.body.length <= 120, true);
    state.toasts[0]?.onFailed();
    assert.equal(state.sync.status(ada).notificationsBlocked, true);
    state.accounts.length = 0;
    state.events.length = 0;
    state.toasts[0]?.onClick();
    assert.equal(
      state.events.some((event) => event.channel === 'gmail:notification-open'),
      false
    );
  });

  it('arms one timer, ignores a second start, and does not resume after shutdown', async () => {
    const state = box();
    state.sync.start();
    state.sync.start();
    assert.equal(state.delays.length, 1);
    assert.equal(state.delays[0], syncIntervalMs);
    await tick();
    state.sync.shutdown();
    state.sync.resume();
    state.sync.focus(ada);
    await tick();
    assert.equal(state.delays.length, 1);
  });
});

describe('electron notifier', () => {
  it('sets the Windows app id once, focuses on click, and reports failure', () => {
    const ids: string[] = [];
    let focused = 0;
    let failed = 0;
    let clicked = 0;
    const notifier = createElectronNotifier({
      platform: 'win32',
      setAppUserModelId: (id) => ids.push(id),
      focus: () => {
        focused += 1;
      },
      create: () => ({
        show() {
          return undefined;
        },
        on(event, listener) {
          if (event === 'click') listener();
          if (event === 'failed') listener();
        }
      })
    });
    notifier.show({
      title: 'Ada',
      body: 'Hello',
      onClick: () => {
        clicked += 1;
      },
      onFailed: () => {
        failed += 1;
      }
    });
    notifier.show({
      title: 'Ada',
      body: 'Again',
      onClick: () => undefined,
      onFailed: () => {
        failed += 1;
      }
    });
    assert.deepEqual(ids, ['com.rubenosaka.aurora']);
    assert.equal(focused, 2);
    assert.equal(clicked, 1);
    assert.equal(failed, 2);
  });
});
