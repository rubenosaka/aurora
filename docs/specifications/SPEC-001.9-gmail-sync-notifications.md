# SPEC-001.9 — Gmail Sync and Notifications

## Status

Implemented and manually accepted by the project owner. Individual manual scenarios were not recorded one by one. SPEC-001.8 is implemented and manually accepted. Parent specifications: [SPEC-001.1-persistence.md](SPEC-001.1-persistence.md), [SPEC-001.2-gmail-oauth.md](SPEC-001.2-gmail-oauth.md), [SPEC-001.3-gmail-reader.md](SPEC-001.3-gmail-reader.md), [SPEC-001.4-gmail-actions.md](SPEC-001.4-gmail-actions.md), [SPEC-001.5-aurora-visual-system.md](SPEC-001.5-aurora-visual-system.md), [SPEC-001.6-gmail-compose.md](SPEC-001.6-gmail-compose.md), [SPEC-001.7-gmail-drafts-attachments.md](SPEC-001.7-gmail-drafts-attachments.md), and [SPEC-001.8-gmail-bulk-actions-labels.md](SPEC-001.8-gmail-bulk-actions-labels.md).

This specification adds incremental mailbox synchronization and Windows toast notifications while Aurora's process is running. It does not replace the reader, actions, composer, drafts, or bulk actions. The decisions in [Accepted decisions](#16-accepted-decisions) are implemented. SPEC-001.10 does not start. None of the manual checks below is marked passed.

## 1. Goals and exclusions

### Goals

- Keep connected mailboxes current while Aurora is open, including when the window is minimized.
- Learn about new mail, read and unread changes, archive, Trash, removal, and label changes without downloading the mailbox.
- Show a Windows toast only for a message Aurora can confidently treat as newly received Inbox mail. The toast shows the sender and the subject, or a generic sentence when content is hidden.
- Avoid a second toast for the same message, and avoid toasting mail that was already in the mailbox when Aurora first learned the cursor.
- Keep one synchronization job per account, survive sleep and offline periods, and stay inside the Gmail quota.
- Keep credentials in the main process. Isolate accounts. Store only a history cursor and a short notification deduplication list.

### Exclusions

- No Google Cloud Pub/Sub, no `users.watch`, and no `users.stop`. The person does not create a topic, a subscription, or a public HTTPS endpoint.
- No Windows service, no tray icon, and no process that keeps running after the window closes. On Windows, closing the window still quits Aurora.
- No persistent message cache and no message bodies in SQLite. Gmail remains the store for mail.
- No full-mailbox walk on a timer. A quiet tick does not call `threads.list`.
- No custom notification window. Aurora uses Electron's `Notification`.
- No new OAuth scope, no `include_granted_scopes`, and no `https://mail.google.com/`.
- No generic Gmail proxy. The renderer cannot name `history.list`, pass a `historyId`, or ask main to show an arbitrary toast.
- No change to compose, draft writes, bulk mutations, or the visual system outside the sync status and the notification preferences.
- SPEC-001.10 does not start.

## 2. Current architecture

SPEC-001.1 stores one SQLite file per environment. Before this feature the schema version was 2. This feature raises it to 3. `schema_migrations` records applied versions. A migration runs in `BEGIN IMMEDIATE` and rolls back on failure. A database newer than this application is rejected and left in place. `app_settings` is a key-value table and is unused by mail. `connected_accounts.granted_scopes` is text. Refresh tokens and the client secret are `safeStorage` ciphertext in `credential_secrets`. Access tokens are not stored.

SPEC-001.2 connects Google accounts in the main process with Authorization Code and PKCE. `googleScopes` is `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/gmail.modify`. An account created before that scope still has the historical read-only grant until the person reconnects. Access tokens live in a main-process map keyed by the Aurora account UUID. `userId` is always `me`. Token-endpoint `invalid_grant` sets `needs_reauth` and deletes that refresh-token row. A network failure during refresh keeps the token. Disconnect deletes the account row. `will-quit` shuts the OAuth service down before the database closes.

The Gmail client calls `https://gmail.googleapis.com/gmail/v1/users/me` with `fetch`. The timeout is 10 seconds. A read retries once on HTTP 429, 500, or 503. A thrown `fetch` is `network` and is not retried. HTTP 401 refreshes the access token and retries that call once. There is no `history.list` and no `getProfile` caller today. Draft conflict checks use a message `historyId` only in main memory, and that value is not an IPC field.

The reader lists 20 threads per page. Search replaces the folder filter. A generation counter drops a stale list, thread, or bulk result. Mail reloads only when the person changes account, folder, search, or page, asks for Refresh, or finishes a successful bulk change. Nothing polls. `window-all-closed` quits on Windows. The window is created at 1120 by 740, shown on `ready-to-show`, and has no `powerMonitor` handler. `electron-builder` `appId` is `com.rubenosaka.aurora`. The running process does not call `app.setAppUserModelId`.

Bulk work holds one operation per account and reserves each selected thread. A second bulk, or a single-thread write on a reserved thread, is `operation-in-progress`. Sync must not start a Gmail write and must not steal those reservations.

Official quota figures used here are from the Gmail usage-limits page after the 1 May 2026 update. Per user per minute the limit is 6,000 units. Per project per minute it is 1,200,000. A project that called the API between November 2025 and April 2026 may still be on its previous quota. Aurora treats HTTP 429 the same in either case.

| Method                                | Units | Already allowed by `gmail.modify` or `gmail.readonly` |
| ------------------------------------- | ----- | ----------------------------------------------------- |
| `getProfile`                          | 1     | Yes                                                   |
| `history.list`                        | 2     | Yes                                                   |
| `messages.get` with `format=metadata` | 20    | Yes                                                   |
| `labels.list`                         | 1     | Yes                                                   |
| `threads.list`                        | 10    | Yes                                                   |
| `threads.get` with `format=metadata`  | 40    | Yes                                                   |
| `users.watch`                         | 100   | Not used                                              |

`history.list` accepts `gmail.readonly`, `gmail.modify`, `gmail.metadata`, or `https://mail.google.com/`. Both the current scope and the historical read-only grant can call it. `gmail.metadata` is not requested.

## 3. Recommended synchronization model

Three options were compared.

Periodic listing walks `threads.list` and then metadata for every visible folder. A quiet Inbox page is about 810 units before any other folder. It cannot see a change in a folder the person is not viewing, and it still misses the moment a message arrived if Aurora only reloads the open page. It is simple and too expensive for a timer.

Gmail push uses `users.watch` and a Cloud Pub/Sub topic. Gmail publishes a small notice, and the client then calls `history.list`. The watch expires within 7 days and must be renewed. The topic must already exist, Gmail's push service account must be allowed to publish, and something must receive the push. Aurora is a desktop process on a private network. A push design needs a server the person does not have. This specification does not use it.

Partial synchronization uses `history.list` with a stored `startHistoryId`. A quiet tick is one call and 2 units. The response names the messages that were added, deleted, or relabeled. Google documents that a `historyId` is typically valid for at least a week and sometimes only a few hours. An unknown or expired id returns HTTP 404, and the client must take a fresh cursor. That is the model Aurora should use.

The timer lives in the main process and runs only while the process is alive. The interval is 120 seconds. Accounts are visited one after another, not in parallel. On resume from sleep, Aurora syncs the connected accounts once and then waits the normal interval. When Mail regains window focus, Aurora syncs the selected account only if more than 30 seconds have elapsed since that account's last success. An elapsed time of exactly 30 seconds does not sync. Focus does not sync on every click.

A quiet tick does not reload Mail. The renderer reports the open account, folder, search query, and conversation. Main chooses `none`, `labels`, `page`, or `thread`. If the delta cannot reliably tell whether the visible mailbox is affected, main asks for a conservative refresh of the open conversation, or of the open page when no conversation is open. The refresh updates the list in place and does not close the open conversation. It does not walk every folder and it does not prefetch pages the person has not opened.

## 4. Gmail API endpoints

Main may call only these additional URLs, with `userId` `me`:

- `GET /profile` to read `historyId` when an account has no cursor, or after HTTP 404.
- `GET /history?startHistoryId={id}&maxResults=100` for the delta. `historyTypes` is omitted so additions, deletions, and label changes all return. `labelId` is omitted so Trash, archive, and user labels are not filtered out.
- `GET /messages/{id}?format=metadata` with `metadataHeaders=From` and `metadataHeaders=Subject`, and only for a message that is a candidate for a toast.
- The existing `GET /labels`, thread list, and thread read are issued by the renderer after `gmail:sync-changed`, and only for the refresh main selected.

`users.watch`, `users.stop`, `messages.list` as a mailbox walk, and every write method stay out of the synchronizer. The synchronizer never calls `threads.modify`, `messages.modify`, `drafts.update`, or `drafts.send`.

`getProfile` is accepted only when `historyId` is 1 to 32 decimal digits. `history.list` is accepted only when its top-level `historyId` matches that grammar, each history record `id` matches it, and each message `id` and `threadId` match the existing Gmail id grammar. An extra field is ignored only when the parser copies the allowlisted fields into a new object. A raw Gmail body never crosses IPC.

`maxResults` stays 100, under the documented maximum of 500. At most 5 pages are followed in one tick. If `nextPageToken` remains, the stored cursor becomes the id of the last history record that was fully applied, not the mailbox `historyId` at the end of an unfinished chain. The page token is not stored. The next tick continues from that record id. If a page is empty and `nextPageToken` is absent, the stored cursor becomes the response `historyId`.

## 5. Synchronization state machine

Each connected account has one state in the main process:

| State           | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `idle`          | A cursor is stored and no sync is running                           |
| `bootstrapping` | No usable cursor. `getProfile` is in flight                         |
| `syncing`       | `history.list` pages are in flight                                  |
| `offline`       | The last attempt threw `network`. The cursor is unchanged           |
| `needs-reauth`  | The refresh token can no longer be used                             |
| `skipped`       | This tick found a bulk job or an OAuth phase and did not call Gmail |

Transitions:

- Process start, account `connected`, no cursor: `bootstrapping`, then `idle`. No toast.
- Process start, account `connected`, cursor present: `syncing`, then `idle` or `offline`.
- Timer, `idle` or `offline`: `syncing`.
- HTTP 404 on `history.list`: discard the cursor, `bootstrapping`, then `idle`. This cycle does not toast.
- `network`: `offline`. The next timer tries again. The cursor stays.
- HTTP 429 after the existing one retry: leave the cursor at the last fully applied record, go `idle`, and wait the normal interval. Do not tight-loop.
- Token-endpoint `invalid_grant`: `needs-reauth`. Stop syncing that account until a successful reconnect.
- HTTP 403 `insufficientPermissions`: stop syncing that account and surface the existing reconnect sentence. Do not delete the refresh token.
- Disconnect: the account row disappears and the cursor and deduplication rows go with it.
- Shutdown: abort the timer and in-flight reads. A page that was not fully applied does not advance the cursor.

A second timer firing for an account already in `bootstrapping` or `syncing` is ignored. Accounts do not share a cursor. The same Gmail address connected as two Aurora accounts, if that were possible, would still use two credentials. The schema unique key is the provider account id, so Aurora has one row per Google account.

Sync does not take `busyThreads`. If that account has a bulk reservation, the tick records `skipped` and a pending follow-up, and does not call Gmail. When the bulk operation finishes, Aurora runs that follow-up immediately. It does not wait for the next 120 second tick. A single-thread write does not block sync. Sync does not block a write. One job runs per account. A second request for an account that is already syncing joins that job. A finished job is forgotten so the next request can start. Shutdown sets a stopped flag, clears the timer, and a late persist writes nothing. The cursor does not advance after an ambiguous network failure.

## 6. Persistence requirements

Schema version becomes 3. The current opener treats version 0 as a fresh file and applies `migrationSql` once, stamped at the current version. Version 1 only adds `granted_scopes` and is also stamped at the current version. That shortcut must not be copied blindly: a version 1 file upgraded with only the `ALTER` would be stamped 3 and would lack the sync tables.

The implementation therefore does all of the following in one change:

- `migrationSql` includes the two tables below and the `gmail.notifications` insert, and a fresh file is stamped 3.
- Version 1 applies the existing `granted_scopes` alteration and the version-3 SQL in the same transaction, then stamps 3.
- Version 2 applies only the version-3 SQL and stamps 3.
- Version 4 or higher stays `unsupported-schema` and is not written.

The version-3 SQL is:

```sql
CREATE TABLE mailbox_sync (
  account_id TEXT PRIMARY KEY REFERENCES connected_accounts (id) ON DELETE CASCADE,
  history_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    length(history_id) BETWEEN 1 AND 32 AND
    history_id GLOB '[0-9]*' AND
    history_id NOT GLOB '*[^0-9]*'
  )
) STRICT;

CREATE TABLE notified_messages (
  account_id TEXT NOT NULL REFERENCES connected_accounts (id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  notified_at TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id),
  CHECK (length(message_id) BETWEEN 1 AND 128)
) STRICT;

INSERT INTO app_settings (key, value, updated_at)
SELECT 'gmail.notifications', 'on', '<stamp>'
WHERE NOT EXISTS (
  SELECT 1 FROM app_settings WHERE key = 'gmail.notifications'
);
INSERT INTO app_settings (key, value, updated_at)
SELECT 'gmail.notification_content', 'show', '<stamp>'
WHERE NOT EXISTS (
  SELECT 1 FROM app_settings WHERE key = 'gmail.notification_content'
);
```

The timestamp substituted for `<stamp>` is the same UTC timestamp written to `schema_migrations.applied_at`, and only after that string matches the existing date grammar. `database.exec` does not bind parameters, so the statement must not contain `?`. `history_id` is decimal digits only, enforced by the `CHECK` and again in the application before insert. `notified_messages.message_id` uses the existing Gmail id grammar. No message body, snippet, header, token, or page token is stored.

`gmail.notifications` is `on` or `off`. `gmail.notification_content` is `show` or `hide`. Both inserts above are the defaults.

After a successful tick, delete deduplication rows for that account whose `notified_at` is older than 14 days, and delete the oldest rows if more than 1,000 remain. The delete is in the same transaction as the cursor update.

The cursor advances only after every record in the applied prefix has updated the deduplication table for the toasts that were shown or deliberately suppressed. A crash mid-page leaves the old cursor. The replay can meet the primary key and must not show a second toast.

Rollback is the existing migration behavior. If the version-3 SQL fails, `applyMigration` rolls the transaction back. A version 2 file stays at version 2, a version 1 file stays at version 1, and a fresh file stays unversioned. There is no down migration. Uninstall still does not delete application data, which is the current NSIS setting.

Access tokens stay in the memory map. The history id is not a credential, but it is not sent to the renderer.

## 7. Notification behavior

A toast is an Electron `Notification` created in the main process. Before the first toast on `win32`, main calls `app.setAppUserModelId('com.rubenosaka.aurora')`, the same id as `electron-builder`. The same call also runs at `whenReady` on `win32`. No package is added. Aurora does not draw its own notification surface.

A candidate is only a `messagesAdded` message. A `labelsAdded` entry that adds `INBOX` is a move of mail that already existed, and it is not a candidate. Before a toast, Aurora confirms the message belongs to Inbox and is not mail the account owner sent. The metadata call is `format=metadata` with `From` and `Subject` only. Aurora notifies only when all of the following are true:

- The history record is `messagesAdded`, not a label change by itself.
- Metadata `labelIds` include `INBOX`.
- Metadata `labelIds` do not include `SPAM`, `TRASH`, `DRAFT`, `SENT`, or `CHAT`.
- `From` parses to a mailbox, and that mailbox is not the account email, compared case-insensitively.
- The message id is not already in `notified_messages` for that account.
- The metadata is complete enough to make those checks. A missing label list, a missing `From`, or a `From` that does not parse means Aurora does not notify.

If the history record already includes label ids that exclude the message, Aurora skips the metadata fetch and does not notify. If the metadata call returns 404, the message is gone and is not toasted, and the cursor may advance. If it returns `network`, the cursor does not advance past that record. Any other incomplete or non-transport metadata failure also does not notify. If Aurora cannot confidently establish that the message was newly received, it does not notify.

The first bootstrap, and the bootstrap after HTTP 404, stores the new `historyId` and skips toasts for that cycle. The 404 recovery also refreshes the open view. Mail that already existed is therefore not announced. A later delta can announce mail that arrived while Aurora was closed, because the stored cursor is older than those history records.

When content is `show`, the toast title is the sender, clipped to 120 characters, with control characters removed. The body is the subject, clipped the same way, or `(no subject)`. The title is prefixed with that account's email when more than one account is connected, so two mailboxes are not mixed, and the prefix is also clipped. When content is `hide`, the title and the body are `New email received`. The toast does not contain a snippet, a body, a token, a history id, or a Gmail id.

At most 3 individual toasts are shown per account per cycle. Further candidates in that cycle become one summary toast. When content is `show`, its title is the account email, or `New mail` when only one account is connected, and its body is `{n} more new messages`. When content is `hide`, the summary uses the same generic title and that count in the body. Those extra message ids are still inserted into `notified_messages`. Clicking the summary opens the first extra message's conversation. The next cycle does not repeat stored ids.

A message id already present for that account is not toasted again. Eligible ids are inserted even when notifications are off, before any toast is shown, so turning notifications back on does not dump a backlog. Disconnect deletes the rows. A later connect or reconnect bumps an epoch, deletes any old cursor and notified ids, bootstraps a new cursor, and does not toast existing mail.

The preference `gmail.notifications` applies to every account. `off` still syncs and still refreshes Mail. It shows no toast. `gmail.notification_content` is independent: `hide` still notifies, with the generic sentence.

If Windows refuses the toast, Electron's `failed` event is observed. Aurora still records the message id, surfaces one status line `Windows is not showing Aurora notifications.`, and does not retry that id. Aurora does not open Windows settings itself.

Clicking a toast focuses the existing window, restoring it if it was minimized, and sends one allowlisted payload, `{ accountId, threadId }`, to the renderer only when the account is still connected and both ids parse. Mail selects that account, clears search, opens Inbox, and opens that conversation. It does not show the toast text as mail content. Closing the window on Windows quits the process, so there is no toast to click after Aurora has exited.

## 8. Lifecycle handling

| Event                         | Behavior                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Startup                       | Open the database, migrate to version 3, then bootstrap or sync each `connected` account sequentially                    |
| Minimized window              | The timer keeps running                                                                                                  |
| Window closed on Windows      | The process quits. The timer stops. No background sync remains                                                           |
| `powerMonitor` `suspend`      | Note the suspension. Do not start a new sync                                                                             |
| `powerMonitor` `resume`       | Sync connected accounts once, then resume the 120 second interval                                                        |
| Offline                       | `offline`, cursor unchanged, next interval retries                                                                       |
| Online again                  | The next interval or resume syncs. There is no separate network API                                                      |
| Access token expired          | The existing 401 path refreshes once                                                                                     |
| Refresh token revoked         | That account becomes `needs-reauth` and is skipped until reconnect                                                       |
| Connect or reconnect succeeds | Drop that account's access token as today, delete any old cursor, bootstrap a new cursor, and do not toast existing mail |
| Disconnect                    | Delete the account. Cascades remove the cursor and deduplication rows                                                    |
| Shutdown                      | `will-quit` stops the timer, ignores late results, then runs the existing OAuth shutdown and database close              |

Sleep does not of itself advance the cursor. A timer that fires late after a long freeze is coalesced into one sync, not one sync per missed interval.

An open composer is not edited by sync. A visible Drafts page may reload. The composer keeps its text. The existing conflict check still runs on the next save.

## 9. IPC contracts

New invoke channels, exact keys, no extra fields:

```ts
interface GmailSyncStatusRequest {
  accountId: string;
}

interface GmailSyncStatus {
  state: 'idle' | 'bootstrapping' | 'syncing' | 'offline' | 'needs-reauth' | 'skipped';
  lastSuccessAt: string | null;
  notifications: 'on' | 'off';
  content: 'show' | 'hide';
  pending: boolean;
  notificationsBlocked: boolean;
}

interface GmailNotificationPreference {
  accountId: string;
  notifications: 'on' | 'off';
  content: 'show' | 'hide';
}

interface GmailSyncView {
  accountId: string | null;
  labelId: string | null;
  query: string | null;
  threadId: string | null;
}

interface GmailSyncFocus {
  accountId: string;
}
```

- `gmail:sync-status` accepts `GmailSyncStatusRequest` and returns `GmailSyncStatus`.
- `gmail:notifications-set` accepts `GmailNotificationPreference` and returns the same status shape. It writes `app_settings` and does not call Gmail. The account id is checked and is not used to store a per-account preference. Both settings are global.
- `gmail:sync-view` accepts `GmailSyncView`. `accountId` null requires the other fields null and clears the reported view. A non-null account reports the open folder, search, and conversation. It returns `{ accepted: true }`.
- `gmail:sync-focus` accepts `GmailSyncFocus` and returns `GmailSyncStatus`. Mail calls it when the window regains focus.

`lastSuccessAt` is a UTC timestamp matching the existing date grammar, or null before the first successful cursor store. `state` for an unknown or disconnected account is `needs-reauth` only when that account's status is `needs_reauth`. An unknown id is `invalid-request`.

Main pushes two events. The preload exposes them as named subscriptions and does not expose `ipcRenderer`.

```ts
interface GmailSyncChanged {
  accountId: string;
  refresh: 'none' | 'labels' | 'page' | 'thread';
  threadId: string | null;
}

interface GmailNotificationOpen {
  accountId: string;
  threadId: string;
}
```

`gmail:sync-changed` is sent after a tick. `refresh` is `none` when nothing on screen must move. `labels` means the folder counts should reload. `page` means the current list page should reload in place. `thread` means the open conversation should reload, and `threadId` is required. The renderer applies the event only when `accountId` is still the selected account and the generation is still current. `gmail:notification-open` is sent from the toast click. The renderer validates the thread id before opening it.

The renderer cannot supply a history id, a message id to announce, a title, a body, a URL, or an HTTP method. Sync status does not include tokens, history ids, or message contents. If the synchronizer is not running, a valid request returns `unavailable`.

## 10. UI design

Mail keeps the SPEC-001.5 layout. A status row under the toolbar, `role="status"`, stays visible while a conversation is open and is bound to the selected account:

- `bootstrapping` or `syncing`: `Checking for new mail`
- `idle` with `lastSuccessAt`: `Updated {relative time}`, or `just now` when the success is under 60 seconds
- `offline`: `Aurora could not reach Google.`
- `needs-reauth`: the existing reconnect sentence and the Integrations link
- `skipped`: the previous success line stays. A skipped tick is not an error
- `notificationsBlocked`: `Windows is not showing Aurora notifications.`

The line does not use a blocking panel and does not disable search or the account select. `aria-busy` is true only while the selected account is `bootstrapping` or `syncing`. The relative time uses `Intl.RelativeTimeFormat` and does not show a raw history id.

Two checkboxes use the existing `.choice` control. `Notify me of new mail` writes `gmail.notifications`. `Show sender and subject` writes `gmail.notification_content`. Both preferences are global and are available for every connected account. Turning notifications off does not stop synchronization. Hiding content still notifies, with `New email received`. Read-only grants still sync and can still be notified. They still cannot mutate mail.

When `gmail:sync-changed` arrives for another account, the open list does not reload. Switching to that account loads it through the existing list path, which then shows the current Gmail state. The status line switches with the account.

No new sidebar, no new route, and no change to the folder rail.

## 11. Security

- Refresh tokens and the client secret stay in `safeStorage` ciphertext. Access tokens stay in the main-process map.
- The history cursor and the deduplication ids are not secrets, and they are still main-process data. IPC does not return them.
- Each new invoke checks the authorized sender and the exact payload before any database write or `fetch`.
- Push events are built in main from parsed Gmail ids. The renderer cannot choose the toast text.
- A sync for account A never uses account B's token. Toast clicks carry the Aurora account id, and Mail loads that account only.
- The synchronizer does not accept an HTTP method, a URL, or a raw label list.
- OAuth scopes do not change. A read-only historical grant can sync. It still cannot bulk-edit, which remains `insufficient-scope` before a write.
- Schema version 3 does not add a plaintext credential column.
- Logs and error sentences do not include response bodies, Authorization headers, or history ids.

## 12. Failure recovery

| Situation                              | Behavior                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| No cursor yet                          | `getProfile`, store `historyId`, do not toast                                                                   |
| HTTP 404 on `history.list`             | Replace the cursor from `getProfile`, reload the open view if this account is selected, do not toast this cycle |
| Timeout or dropped connection          | `offline`, cursor unchanged, no automatic immediate retry                                                       |
| HTTP 429 after the one existing retry  | Stop the chain, keep the last applied cursor, wait for the next interval                                        |
| HTTP 500 or 503                        | One retry inside that call, as the reader already does                                                          |
| `invalid_grant`                        | `needs-reauth` for that account only                                                                            |
| HTTP 403 insufficient scope            | Stop that account, keep the refresh token                                                                       |
| More than 5 history pages              | Apply the prefix, store the last applied record id, continue next tick                                          |
| Metadata timeout for one new message   | Do not advance past that record                                                                                 |
| Duplicate message id                   | No second toast                                                                                                 |
| Bulk already running                   | Skip the cycle, record pending, and sync that account when the bulk operation finishes                          |
| Account switch during a visible reload | The existing generation check drops the stale page                                                              |
| Migration failure                      | Transaction rollback, database remains version 2, startup shows the existing persistence message and quits      |
| Windows suppresses toasts              | Record the id, show the one status line, do not retry                                                           |

Aurora does not describe a skipped or partial tick as a completed view of the mailbox. The status time moves only when a cursor store succeeds.

## 13. Automated testing

- A connected account with no row in `mailbox_sync` calls `getProfile`, stores the digits, and creates no `Notification`.
- A stored cursor calls `history.list` with that `startHistoryId` and does not call `threads.list` when the history array is empty.
- `messagesAdded` with `INBOX` fetches metadata and shows one toast whose title and body are the clipped From and Subject. The message id is inserted once.
- The same history replayed does not show a second toast.
- Mail that exists only before the bootstrap cursor produces no toast.
- `labelsRemoved` containing `INBOX`, `labelsAdded` containing `TRASH`, `labelsAdded` or `labelsRemoved` containing `UNREAD`, and `messagesDeleted` mark the open page dirty and do not toast.
- A message added with `SPAM`, `TRASH`, `DRAFT`, `SENT`, or `CHAT` does not toast.
- A message whose `From` is the account owner does not toast.
- Incomplete metadata does not toast.
- `labelsAdded` containing `INBOX` without `messagesAdded` does not toast.
- Four new Inbox messages produce three individual toasts and one summary toast, and all four ids are stored.
- `content` `hide` shows `New email received` and does not include the sender address.
- `notifications` `off` syncs, advances the cursor, records the id, and does not construct a `Notification`. Turning notifications back on does not toast that id.
- A thrown `fetch` leaves the cursor unchanged and the next success continues from it.
- HTTP 404 replaces the old cursor with a new `getProfile` id, refreshes the open view, and does not toast.
- HTTP 401 follows the existing refresh-once path. `invalid_grant` stops that account only. The other account continues.
- Account A's token is not sent on account B's history URL.
- A second request while the first is in flight performs no second `history.list` for that account.
- A bulk reservation skips the cycle and records pending. Releasing the bulk runs one follow-up.
- `shutdown` during `history.list` does not write a cursor for an unfinished page.
- `suspend` does not start a sync. `resume` starts one.
- Five history pages stop at the last fully applied record and do not store the unfinished response id.
- A history record with only the generic `messages` array refreshes the open conversation and does not toast.
- Extra IPC fields, a non-UUID account id, and a notification value other than `on` or `off` are `invalid-request` before `fetch`.
- A sync event for account B does not reload account A's list. A notification open selects the account and reads that thread.
- Schema version 2 migrates to 3 and keeps the account, scopes, and ciphertext. A failed migration stays at 2 with no sync tables. Version 4 is rejected.
- The existing reader, action, compose, draft, and bulk tests stay green. Coverage thresholds stay at lines 90, branches 80, and functions 90.

## 14. Manual acceptance criteria

These checks are pending. None is marked passed.

1. Open Mail and leave it on Inbox. A new message that arrives in Gmail appears without pressing Refresh, and the status line shows a recent update time.
2. Mark that message read in Gmail web. The open Aurora list follows. Archive it, move it to Trash, and restore it. The open folder follows when that folder is affected. Other folders are not each reloaded by hand.
3. Add and remove a user label in Gmail web. The folder list and, when that folder is open, the rows follow.
4. The first launch after this feature does not toast the messages already in Inbox.
5. A message that arrives after that launch shows one Windows toast with the sender and the subject, and not the message body. Hide sender and subject. The next toast says `New email received` and does not name the sender.
6. The same message does not produce a second toast after a restart. Mail the person sent, and an existing message moved into Inbox, do not toast.
7. Turn notifications off. New mail still refreshes the list and does not toast. Turn them on. Older mail does not arrive as a burst of toasts.
8. Disconnect the network. The status says Aurora could not reach Google. Reconnect. A later sync succeeds and does not skip the changes that happened offline.
9. Sleep the computer and wake it. Aurora syncs without a toast for mail that was already announced.
10. Two accounts. A new message in the account that is not on screen does not replace the list. Its toast, if enabled, is attributable to that account. The other account's mail is unchanged.
11. Revoke the Google grant. That account asks for reconnect. The other account keeps syncing.
12. Close the window. Aurora quits. No sync continues in the background.
13. Start a bulk action. The overlapping sync cycle does not call Gmail. When the bulk action finishes, one follow-up sync runs without waiting for the next 120 second interval.

## 15. Implementation stages

The stages below were the implementation order. They are complete in this change. SPEC-001.10 does not start.

1. Schema version 3, the cursor and deduplication tables, and both notification settings, with migration and rollback tests.
2. Main-process bootstrap and `history.list`, including 404 reset, offline, quota, overlap, pending follow-up after bulk, and shutdown.
3. Mail status line, notification preferences, and the current-page or open-thread refresh from `gmail:sync-changed`, including the conservative fallback.
4. Electron toasts, the AppUserModelId, Inbox-only eligibility, deduplication, content privacy, and the click-to-open path.
5. Sleep, resume, focus, and the existing typecheck, lint, test, coverage, build, and package pipeline.

## 16. Accepted decisions

These decisions are implemented.

1. Synchronization is `history.list` on a 120 second timer inside the running Electron process. Pub/Sub and `users.watch` are out. Closing the window stops sync. There is no Windows service and no tray.
2. Schema version is 3, with `mailbox_sync`, `notified_messages`, and two global `app_settings` keys. Message bodies are not stored. The migration is forward-only and rolls back if it fails. Existing accounts, credentials, and drafts stay.
3. The first cursor comes from `getProfile` and does not toast existing mail. HTTP 404 replaces the cursor the same way, refreshes the open view, and does not toast that cycle.
4. A toast requires `messagesAdded` plus complete metadata that places the message in Inbox, excludes Spam, Trash, Drafts, Sent, and Chat, and excludes mail sent by the account owner. A move into Inbox does not toast. Incomplete metadata does not toast. At most three individual toasts per account per cycle, then one summary toast. Deduplication is kept for 14 days, at most 1,000 ids per account.
5. Notifications default to on. Content defaults to showing the sender and the subject. Hiding content shows `New email received`. Turning notifications off does not stop sync and does not announce the backlog when they are turned on.
6. No OAuth scope change. `gmail.modify` and the historical `gmail.readonly` grant both authorize `history.list` and `getProfile`.
7. Mail refreshes the current page, the open conversation, or the label counts only when the delta touches that view. An empty history response does not reload the list. An ambiguous delta refreshes the open view.
8. One sync per account at a time. A running bulk action skips that account's cycle, records it as pending, and runs it when the bulk operation finishes.
9. Windows toasts use Electron `Notification` and `app.setAppUserModelId('com.rubenosaka.aurora')`. No new dependency. A toast Windows suppresses is not retried.
10. A toast click focuses Aurora and opens that account's conversation. The renderer cannot request a toast. Navigation targets are validated before the conversation opens.
