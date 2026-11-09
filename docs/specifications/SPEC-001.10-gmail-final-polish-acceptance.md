# SPEC-001.10 — Gmail Final Polish and Acceptance

## Status

Implemented and manually accepted by the project owner. Individual manual scenarios were not recorded one by one. This is the last planned specification for the Gmail module. It stabilizes the mail that already exists. It does not add a product area. With this acceptance, SPEC-001.1 through SPEC-001.10 are complete and the Gmail module is closed.

Publication baseline before this work: `006f302baf80c4e0917ccd81c92b64c74de42e7b`. SPEC-001.8 and SPEC-001.9 are published and were manually accepted before this change. This document does not rewrite those files. The manual checks below are not marked passed individually.

Parent specifications: [SPEC-001.1-persistence.md](SPEC-001.1-persistence.md), [SPEC-001.2-gmail-oauth.md](SPEC-001.2-gmail-oauth.md), [SPEC-001.3-gmail-reader.md](SPEC-001.3-gmail-reader.md), [SPEC-001.4-gmail-actions.md](SPEC-001.4-gmail-actions.md), [SPEC-001.5-aurora-visual-system.md](SPEC-001.5-aurora-visual-system.md), [SPEC-001.6-gmail-compose.md](SPEC-001.6-gmail-compose.md), [SPEC-001.7-gmail-drafts-attachments.md](SPEC-001.7-gmail-drafts-attachments.md), [SPEC-001.8-gmail-bulk-actions-labels.md](SPEC-001.8-gmail-bulk-actions-labels.md), and [SPEC-001.9-gmail-sync-notifications.md](SPEC-001.9-gmail-sync-notifications.md).

## 1. Goals and exclusions

### Goals

- Close the Gmail module on the behavior SPEC-001.1 through SPEC-001.9 already define.
- Fix the confirmed dialog, navigation, and refresh gaps below without a new mailbox model.
- Keep destructive confirmation in front of the rest of Mail, and return focus when the dialog closes.
- Make a failed visible refresh distinguishable from a successful sync.
- Open a notification in Inbox for that account.
- Keep the existing automated thresholds and add regression tests for the changes in this specification.
- Leave a short manual acceptance path for the journeys a person uses every day.

### Exclusions

- No Calendar, Contacts, or other Google product.
- No generated replies, summaries, or other model features.
- No HTML compose editor, scheduled send, filters, or automation rules.
- No Windows service, tray, Pub/Sub, or `users.watch`.
- No Gmail-wide or cross-page selection.
- No new OAuth scope. `gmail.modify` stays the write scope. The historical `gmail.readonly` grant stays read-only until the person reconnects.
- No SQLite schema version 4. Schema version stays 3 after SPEC-001.9.
- No generic Gmail proxy and no new IPC method that accepts a URL, an HTTP method, or a raw Gmail body.
- No retry of an ambiguous send, save, or other non-idempotent write.
- No rewrite of Mail into new components, and no visual-system redesign.
- No second acceptance pass of every numbered check in SPEC-001.1 through SPEC-001.9.

## 2. Current implementation inventory

The inventory below describes Aurora before this polish. SPEC-001.8 and SPEC-001.9 are now on `origin/main`. Schema version remains 3.

| Area             | What Aurora does today                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence      | One SQLite file. Schema version 3 in the working tree. Refresh tokens and the client secret are `safeStorage` ciphertext. Access tokens stay in a main-process map. Drafts are not stored in SQLite.                                                                                                                                                                                        |
| Accounts         | Authorization Code and PKCE. Scopes are `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/gmail.modify`. One operation at a time. `invalid_grant` marks that account `needs_reauth` and deletes its refresh token. Disconnect deletes the account row.                                                                                                                     |
| Reader           | `threads.list` pages of 20. Search replaces the folder. A generation counter drops a stale list, thread, or bulk result. HTML is sanitized in the main process with `sanitize-html`. Remote images are removed. Attachment metadata is returned. A conversation that is too large is `too-large`.                                                                                           |
| Actions          | Read, unread, archive, Trash, restore, star, and unstar on one conversation. Archive removes `INBOX` only. There is no permanent delete. Star changes the newest message.                                                                                                                                                                                                                   |
| Compose          | Plain text. New message, reply, reply all, and forward. ASCII recipients. HTTP 429, 500, 503, timeout, a lost response, or HTTP 200 without an id is send-unconfirmed and is not retried. A confirmed HTTP 401 refreshes once.                                                                                                                                                              |
| Drafts and files | Gmail is the draft store. Save, open, delete, and send. At most 10 attachments and 5 MiB total. The save dialog is native. Download writes the chosen path from the main process.                                                                                                                                                                                                           |
| Bulk and labels  | Selection is the visible page only, at most 20. One bulk operation per account. Results are succeeded, failed, unconfirmed, and not attempted. User labels can be created, renamed, and deleted. Names Aurora writes cannot contain `/`. System labels are protected.                                                                                                                       |
| Sync and notices | `history.list` every 120 seconds while the process is alive, plus resume and Mail focus after more than 30 seconds. One job per account. A bulk operation defers that account and runs when the bulk finishes. Native toasts use `com.rubenosaka.aurora`. Inbox-only eligibility, 14-day deduplication, and a global show-or-hide preference. Closing the window quits the Windows process. |
| Window           | One window, 1120 by 740, minimum 760 by 560. `contextIsolation`, `sandbox`, `nodeIntegration: false`, and `webSecurity` are on. The preload does not expose `ipcRenderer`.                                                                                                                                                                                                                  |

`MailView.vue` is the mail screen. It owns the list, the reader, compose, drafts, bulk selection, labels, sync status, and every mail dialog. The visual tokens and focus rings for `.control`, `.field`, and `.folder-button` stay in the SPEC-001.5 styles.

## 3. Confirmed defects

These are observed in the current source. They are not inferred from missing features.

### 3.1 Mail dialogs do not hold the rest of the screen

`.mail-dialog` in `src/renderer/src/features/mail/mail.css` is a fixed, centered panel. It has no backdrop. The list, folder buttons, and composer controls behind it remain visible to pointer and keyboard.

The composer traps Tab in `onComposeKeydown`. The other dialogs do not. Escape is bound on the dialog element, so it runs only when focus is already inside that dialog. The single-conversation Trash dialog does not set `aria-modal`. The other dialogs do.

`closeTrash` returns focus to the button that opened it. Closing the bulk Trash dialog, the label editor, the delete-label dialog, the delete-draft dialog, or the discard dialog does not.

The label editor and its delete confirmation can both be open. Both use the same stacking level. The delete-draft and discard dialogs use a higher level. The Trash confirmation does not.

### 3.2 The open-thread label menu is not a working listbox

The menu in the open conversation uses `role="listbox"` and `role="option"`, and each option also sets `aria-pressed`. There is no keyboard handler for that menu. A listbox that does not move with the arrow keys, and that mixes pressed state with selection, does not match the role it announces.

### 3.3 A notification click does not select Inbox

`openNotified` in `MailView.vue` changes the account and clears search only when the account differs or a search is active. On the same account, with no search, it leaves the current folder and calls `openThread`. A click while Trash, Sent, or a user label is open shows that Inbox conversation on top of the other folder. Back returns to that other folder.

### 3.4 A failed visible refresh is silent

`applySync` loads sync status and then, for a page or thread refresh, fetches labels, the list, or the thread. The `catch` returns without an alert and without changing the status line. The main process may already have stored a newer cursor, so the line can say the mailbox was updated while the open list was not.

`loadSyncStatus` has the same empty `catch` and then sets sync state to null. The status line disappears. The notification checkboxes treat a missing state as enabled, because they compare with `!== 'off'` and `!== 'hide'`.

### 3.5 An open conversation is re-read on an unrelated page refresh

`refreshFor` in `src/main/gmail/sync.ts` returns `refresh: 'page'` with the open `threadId` when the visible folder was touched. `applySync` then calls `readThread` whenever a conversation is open and `threadId` is null or equal to that conversation. A label change on another row of the same folder therefore costs `labels.list` (1), `threads.list` (10), and `threads.get` metadata (40) even though the open conversation was not in the delta.

This is wasted quota, not a wrong mailbox. A quiet tick remains one `history.list` (2 units) and is not part of this defect.

## 4. Risks and technical debt

These are not confirmed user-facing defects. SPEC-001.10 does not have to remove them to close Gmail.

- `MailView.vue` holds the whole mail screen. A split would be a large unrelated refactor. Do not split it in this specification.
- SPEC-001.4 still says its writes are the only Gmail writes. Compose, drafts, bulk actions, and label edits came later. The code is the authority. Do not rewrite the historical specifications in this change.
- SPEC-001.6 and SPEC-001.7 still say the schema is version 2. The working tree is version 3 because of SPEC-001.9. Same rule: do not rewrite those documents here.
- SPEC-001.8 and SPEC-001.9 files still say they await acceptance, while the owner has accepted them and git has not published them. Publication is a gate in [Decisions requiring approval](#12-decisions-requiring-approval), not a behavior change.
- There is no live Gmail browser test. The suite uses fakes. A live Google test would need a real account and is out of scope.
- Sync still waits up to 120 seconds and applies at most five history pages per cycle. That is the accepted SPEC-001.9 design.
- A crash or a forced quit can still drop unsent composer text. SPEC-001.6 accepted that. This specification does not add a local outbox.
- `applySync` and the focus path ignore a failed `reportSyncView` or `syncFocus`. The next timer or a later focus retries. That is acceptable recovery, not a second defect beyond section 3.4.

## 5. UX and accessibility improvements

Preserve SPEC-001.5. Reuse `.control`, `.field`, `.choice`, and the existing focus rings. Do not add a component library.

### 5.1 Make every mail dialog modal

- Problem: section 3.1. A confirmation can be open while the person activates Archive, Trash, or Send on the screen behind it. Focus can leave the dialog, and only one dialog returns focus.
- Evidence: `mail.css` defines `.mail-dialog` without a backdrop. `MailView.vue` traps Tab only in `onComposeKeydown`. The Trash dialog at the `trash-title` block has `role="dialog"` and no `aria-modal`. `closeTrash` is the only closer that focuses the opener.
- Proposed solution: one shared behavior for the Trash, bulk Trash, label editor, delete-label, compose, delete-draft, and discard dialogs. While one is open, a backdrop covers the mail screen and the screen behind is not tabbable. Tab cycles inside the dialog. Escape closes a confirmation and cancels it, including when focus is on the backdrop. Compose keeps its current Escape rule: Escape asks to discard when the text is dirty, and closes when it is not. Opening a dialog moves focus to the first control, or to the cancel button for a destructive confirmation. Closing returns focus to the control that opened it. The delete-label confirmation replaces the label editor until it closes, instead of leaving both in the tab order. The Trash confirmation uses `aria-modal="true"`.
- Priority: P1.
- Acceptance criteria: with any mail dialog open, Tab does not reach the list or the folder column; Escape activates the dialog's cancel path; after close, focus is on the opener when that control still exists; the single Trash dialog exposes `aria-modal="true"`; a component test covers the Trash dialog and the label-delete stack.
- Estimated complexity: medium. The behavior is local to `MailView.vue` and `mail.css`, but every dialog must be checked so compose discard still works.

### 5.2 Correct the label menu

- Problem: section 3.2. The open-conversation label control announces a listbox that the keyboard cannot operate.
- Evidence: the `label-menu` block uses `role="listbox"`, `role="option"`, and `aria-pressed`, and it has no key listener.
- Proposed solution: keep the existing buttons and the SPEC-001.5 menu look. Remove `role="listbox"` and `role="option"`. Use a `role="group"` named `Labels`, and keep each button's pressed state. Escape closes the menu and returns focus to the Labels button. Arrow keys are not required once the control is no longer a listbox. Do not change which Gmail method toggles a label.
- Priority: P1.
- Acceptance criteria: the menu has no listbox or option role; each label button still exposes pressed state; Escape closes it and restores focus; applying or removing a label is unchanged; a component test covers Escape.
- Estimated complexity: small.

### 5.3 Open a notification in Inbox

- Problem: section 3.3. The conversation opens, and the folder behind it can be the wrong one.
- Evidence: `openNotified` assigns `labelId` to `INBOX` only inside the branch where the account differs or `activeQuery` is not null.
- Proposed solution: for a valid notification target, select that account, clear search, select Inbox, load that list, and then open the thread. If a dirty composer is open, use the existing discard confirmation before changing account or folder. If the person cancels the discard, leave the composer and do not change the folder. Ignore a target whose account is no longer connected or whose thread id fails `isGmailId`, as today.
- Priority: P1.
- Acceptance criteria: a notification for the selected account, while Trash is open and search is empty, ends on Inbox with that conversation open; a notification for another connected account does the same on that account; a dirty composer asks before the folder changes; a component test covers the Trash case.
- Estimated complexity: small.

### 5.4 Show a failed refresh

- Problem: section 3.4. The status line can claim success, or disappear, when the visible list did not refresh.
- Evidence: `applySync` and `loadSyncStatus` swallow errors. The checkboxes derive "on" and "show" from a null state.
- Proposed solution: if the list or thread fetch in `applySync` fails, keep the previous list and set `actionNotice` from the existing `GmailIpcError` message, or the existing internal sentence. Do not advance any renderer cursor. The main-process history cursor stays where SPEC-001.9 put it. If `loadSyncStatus` fails, leave the previous sync state on screen when one exists. When none exists, show the offline sentence instead of an enabled pair of checkboxes. Do not retry the failed read in a loop. The next sync event or focus may try again.
- Priority: P1.
- Acceptance criteria: a rejected `listThreads` during `gmail:sync-changed` leaves the previous rows in place and shows an alert; the checkboxes do not flip to enabled solely because status failed to load; a component test covers the rejected list.
- Estimated complexity: small.

### 5.5 Deferred interaction polish

Arrow-key movement through the message list, a skip link, and a second measurement pass of the 760, 880, and 1280 pixel widths are not defects. They are P2. Do not implement them unless the approval section explicitly adds them. The existing row buttons, folder toggle, and pager remain the keyboard path.

## 6. Performance improvements

### 6.1 Skip the open conversation when the delta did not touch it

- Problem: section 3.5. A page refresh re-reads the open conversation even when another row changed.
- Evidence: `refreshFor` returns the open `threadId` for a folder hit. `applySync` reads that thread on every `page` refresh when it is open.
- Proposed solution: `gmail:sync-changed` gains no new field. For `refresh: 'page'`, the renderer reloads the list and labels as it does now, and calls `readThread` only when `threadId` is the open conversation. `refreshFor` sets `threadId` only when that conversation's id is in the delta. A `refresh: 'thread'` event is unchanged. An uncertain delta still refreshes the open conversation or, when none is open, the page. Do not add a cache, a new page size, or a different Gmail method.
- Priority: P2. It is a quota saving, not a broken screen. Implement it in the same stage as section 5.4 because both edit `applySync`, if the approval includes it. If it is deferred, section 5.4 still ships.
- Acceptance criteria: a history record that changes another thread in the open folder reloads the list and does not call `readThread`; a record that names the open thread does call `readThread`; the sync unit test and the Mail component test both cover one of those cases.
- Estimated complexity: small.

No other performance change is in scope. Quiet history stays one `history.list`. Attachment bytes stay capped at 5 MiB. MIME parsing stays in the main process with the existing size limits. Account switching stays a new list request. SQLite writes for sync stay the current one transaction per applied record.

## 7. Reliability improvements

The recovery rules already accepted stay in force.

- Token refresh: one retry after a confirmed HTTP 401. `invalid_grant` stops that account only.
- Offline: the history cursor does not move. The next interval, resume, or eligible focus tries again.
- HTTP 429: one retry inside the existing Gmail client, then stop. Do not tight-loop.
- Send and save: `send-unconfirmed` and `save-unconfirmed` are not retried.
- Draft conflict: the composer stays open and shows the existing conflict sentence.
- Bulk: a partial result stays split into succeeded, failed, unconfirmed, and not attempted. A global auth or rate-limit failure does not start the remaining conversations.
- Sync cursor: it advances only after the applied history prefix is stored. Shutdown does not store a partial page.
- Notifications: eligible ids are stored before the toast, including when toasts are off. Deduplication stays 14 days and 1,000 ids per account.
- Sleep: suspend does not start a sync. Resume starts one.
- Two accounts: a failure on one does not use the other account's token.

Section 5.4 is the only new reliability behavior. It tells the person when the visible list did not follow a successful cursor store. It does not add a retry.

## 8. Security review

Reviewed against the working tree. No P0 issue was found. SPEC-001.10 does not add a Gmail proxy, a scope, or a credential column.

| Check                                                           | Result                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contextIsolation`, `sandbox`, `nodeIntegration`, `webSecurity` | Set in `src/main/aurora-window.ts`. No change.                                                                                                                                                                                                                                                |
| Preload                                                         | `ipcRenderer` stays inside the preload. The renderer receives named methods. No change.                                                                                                                                                                                                       |
| IPC                                                             | Existing parsers require exact keys. Sync status does not return tokens, history ids, or bodies. No change.                                                                                                                                                                                   |
| Account isolation                                               | Reads and writes take the Aurora account id and use that account's token. Notification targets are parsed before open. Section 5.3 keeps that check.                                                                                                                                          |
| Tokens                                                          | Access tokens are memory-only. Refresh tokens and the client secret stay ciphertext. No change.                                                                                                                                                                                               |
| HTML                                                            | `sanitize-html` runs in the main process. The allowlist has no `img` and no event handlers. Links are `http`, `https`, or `mailto` after `acceptExternalUrl`. The reader and the composer quote use that HTML. `v-html` must continue to receive only that value. No change to the sanitizer. |
| Remote images                                                   | Removed. The reader shows "Images in this message were not loaded." No change.                                                                                                                                                                                                                |
| Attachments                                                     | Native save dialog. The main process writes the path. The 5 MiB and 10-file caps stay. No change.                                                                                                                                                                                             |
| URLs                                                            | The renderer prevents the default click and calls `openLink`. No change.                                                                                                                                                                                                                      |
| Mutations                                                       | System labels stay protected. There is no permanent delete. Bulk ids are validated before any call. No change.                                                                                                                                                                                |
| Notification privacy                                            | Hide mode uses "New email received" and does not include the sender or the subject. No change.                                                                                                                                                                                                |
| Dialogs                                                         | Section 5.1 reduces accidental writes while a confirmation is open. That is the only security-related code change.                                                                                                                                                                            |

## 9. Automated testing plan

Keep the current commands and thresholds: lines 90, branches 80, functions 90, on the files already listed for `pnpm test:coverage`. Do not lower a threshold. Do not add `MailView.vue` to the Node coverage include. Component coverage stays in Vitest.

Add or extend tests for the work that ships:

- Trash dialog: `aria-modal`, Tab stays inside, Escape cancels, focus returns.
- Delete-label confirmation: the label editor is not in the tab order while the confirmation is open.
- Label menu: no listbox role, Escape closes and restores the Labels button, a click still toggles.
- Notification open from Trash on the same account selects Inbox and reads that thread. A dirty composer blocks the folder change until discard is confirmed.
- `applySync` with a rejected `listThreads` keeps the previous rows and shows an alert.
- If section 6.1 ships: a page event whose `threadId` is null does not call `readThread` while a conversation is open, and a matching `threadId` does.
- Existing reader, action, compose, draft, bulk, sync, migration, and IPC tests stay green.

Do not add Playwright against Google. Do not add a test that needs a real refresh token or a real mailbox. "End to end" in this plan means the existing main-process tests with a fake `fetch`, plus the Mail component tests with a fake bridge.

## 10. Manual acceptance plan

The project owner approved this closing pass as a whole. Individual scenarios were not recorded one by one, and none of the checks below is marked passed individually. They do not replace a failed earlier check, and they do not require every old scenario to be repeated.

Use two Google accounts on Windows. One may be read-only only if a second writable account is available. Disconnect the network by disabling the adapter or the wireless interface, not by killing the process.

1. Connect an account, quit Aurora, and open it again. The account is still connected and Inbox loads.
2. Connect a second account. Mail from one account does not appear in the other. Switching accounts loads that account's Inbox.
3. Search, open a result, go back, and clear the search. The previous folder returns.
4. Open a conversation. Reply, reply all, and forward one message. Send one new plain-text message. The unconfirmed-send sentence appears only if Gmail does not confirm the id. Do not retry a send that Aurora could not confirm.
5. Save a draft, quit Aurora, and open the draft from Drafts. An attachment under the existing size cap can be added and downloaded. A draft conflict still leaves the local text in place.
6. On one conversation, mark read, archive, move to Trash, and restore. Star still affects one message.
7. Select several rows on the visible page only. Run one bulk action. A partial failure names what did not complete. Confirm Trash from the keyboard with Escape cancelling once.
8. Create a user label, apply it, rename it, and delete it. Deleting asks first and does not delete messages. A name that contains `/` is refused.
9. Leave Inbox open until the status line shows a recent update. A new Inbox message appears without Refresh. Marking it read in Gmail web follows on a later sync.
10. A new Inbox message shows one toast with the sender and subject. Hide content and confirm the next toast says `New email received`. Turn notifications off and confirm sync continues without a toast. Turn them on and confirm older mail is not announced again.
11. While a non-Inbox folder is open, activate a toast for that same account. Inbox and that conversation open.
12. Disconnect the network. The status says Aurora could not reach Google. Reconnect. A later sync succeeds and does not skip the gap.
13. Revoke one account. That account asks for reconnect. The other account still reads. Reconnect the revoked account.
14. Open the Trash confirmation and the composer. The list behind them does not take the click or the Tab key. Escape cancels the confirmation. Focus returns to the button that opened it.
15. Install `release/Aurora-Setup-0.0.0.exe` from the SPEC-001.10 package, launch it, and confirm Mail opens for an already connected account. Uninstall still leaves the local database in place, which is the current NSIS setting.

## 11. Implementation stages

Do not start stage 1 until decision 1 in the next section is done. SPEC-001.10 does not commit SPEC-001.8 or SPEC-001.9 itself.

1. Modal dialogs, focus return, and the Trash `aria-modal` fix, with component tests.
2. Label menu roles and Escape, and notification open through Inbox, with component tests.
3. Visible sync-refresh failure. Include section 6.1 only if it is approved.
4. Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm test:coverage`, `pnpm build`, `pnpm check:build`, `pnpm package`, and `pnpm check:package`.
5. Stop for the manual plan. Do not mark a manual check passed from the automated run.

## 12. Decisions requiring approval

1. Publish SPEC-001.8 and SPEC-001.9 as their own commits before any SPEC-001.10 code. The owner has accepted both. Git has not. This specification does not mix that publication with polish.
2. No P0 defect was found. SPEC-001.10 is P1 polish plus an optional P2 quota guard, then a closing manual pass.
3. Dialogs become modal, with a backdrop, a Tab cycle, Escape, and focus return. Compose discard behavior stays as SPEC-001.6 defined it.
4. A notification click selects Inbox for that account before opening the conversation. A dirty composer asks before that navigation.
5. A failed list or thread refresh shows the existing error sentence and keeps the previous rows. It does not retry, and it does not move the history cursor.
6. Section 6.1, skipping `readThread` when the open conversation is not in the delta, is included unless this approval drops it.
7. Arrow-key list navigation, a MailView split, a schema migration, a new OAuth scope, and a live Gmail end-to-end test are out.
8. Historical specification wording that lags the code stays as history. The code and this document are the authority for the closing pass.

## 13. Gmail module completion criteria

Gmail is complete when all of the following are true.

- SPEC-001.8 and SPEC-001.9 are on `origin/main` as their own commits.
- Every P1 item in this specification is implemented and covered by the automated tests in section 9.
- Section 6.1 is either implemented or explicitly dropped in approval.
- No P0 item is open. This review found none.
- Deferred P2 items in section 5.5 stay deferred.
- The pipeline in stage 4 passed on the polish change.
- The project owner approved the manual plan in section 10 as a whole. Individual rows are not marked passed.
- No Calendar, Contacts, HTML editor, Pub/Sub, background service, new scope, or schema version 4 landed in the closing change.

## 14. Implementation record

The approved decisions in section 12 are in force. SPEC-001.8 and SPEC-001.9 were already on `origin/main`. Section 6.1 is included. Section 5.5 stays deferred. No schema version 4 and no new OAuth scope were added.

### Dialogs

Every mail dialog shares one backdrop and one active dialog. The mail screen is `inert` while a dialog is open, so the list and folders do not take pointer or keyboard input. Tab and Shift+Tab cycle inside the active dialog, including when focus has left it. Escape cancels the active dialog. A destructive confirmation receives focus on its cancel button. The label editor and the compose dialog receive focus on their first field. Closing returns focus to the control that opened the dialog when that control is still connected.

The label-delete confirmation replaces the label editor until it closes. The composer stays mounted behind a discard or delete-draft confirmation, but it is `inert` and is not a second active dialog. Escape on those confirmations cancels them and does not discard the message. Escape on the composer still asks to discard when the text is dirty and closes it when it is not. A click on the backdrop does not confirm or cancel.

### Label menu

The open-conversation label control is a `role="group"` named Labels. Each label is a button with `aria-pressed`. It is not a listbox and it does not use `aria-pressed` together with `role="option"`. Enter and Space activate the focused button. Escape closes the group and returns focus to the Labels button. The Gmail add and remove calls are unchanged.

### Notification navigation

A valid notification selects that connected account, clears search, selects Inbox, loads that list, and then opens the conversation. Back therefore returns to Inbox. An id that fails `isGmailId`, or an account that is not connected, is ignored. If the composer is open, Aurora uses the existing discard confirmation before changing account or folder. Cancel leaves the composer, account, folder, and conversation as they were. Confirm discards and then performs the Inbox navigation. Notification eligibility and deduplication are unchanged.

### Visible refresh and the history cursor

Invariant: the main process stores a history cursor only after the applied history prefix is persisted, and only then emits `gmail:sync-changed`. The renderer does not keep a cursor. A failed list, label, or thread fetch keeps the previous rows, shows the existing Gmail error sentence, and does not present the status line as a successful update. The stored cursor is not rolled back, because the next sync event for that account, including `refresh: 'none'`, or a later focus, retries the visible mailbox once. A failed retry keeps the same explicit failure. Aurora does not loop on the failed read and does not retry an ambiguous history failure.

If notification status cannot be loaded and no previous status is on screen, the status line says Aurora could not reach Google and the two checkboxes stay disabled and unchecked. If a previous status is already on screen, that status stays. A failed load does not turn the checkboxes on.

### Quota guard

`pageEventThreadId` in `src/main/gmail/sync.ts` is the only place that decides whether a page refresh names the open conversation. It returns that id only when the conversation is in the delta. The renderer calls `readThread` for a page refresh only when the event names the open conversation. An uncertain delta still refreshes the open conversation, or the page when none is open. Removing this guard means returning the open id from `pageEventThreadId` for every page refresh and reading the open conversation whenever the page event has no thread id. The dialogs, notification navigation, and refresh-failure behavior do not depend on it.

### Automated verification

`pnpm lint`, `pnpm format:check`, and `pnpm typecheck` passed. `pnpm test` passed 236 Node tests and 37 Vitest tests. `pnpm test:coverage` passed with lines 93.87%, branches 80.68%, and functions 91.07%. `pnpm build` and `pnpm check:build` passed. `pnpm package` produced `release/Aurora-Setup-0.0.0.exe` at 110244242 bytes, and `pnpm check:package` passed. The project owner then approved the manual acceptance as a whole. Individual manual scenarios were not recorded one by one.

### Known limitations

Arrow-key movement through the message list, a skip link, and a second measurement of the 760, 880, and 1280 pixel widths stay deferred. `MailView.vue` remains one screen. The schema stays at version 3. No new OAuth scope, live Gmail account test, Pub/Sub, Windows service, Calendar, Contacts, or generated-mail feature is part of this close. A crash or a forced quit can still drop unsent composer text. Sync still waits up to 120 seconds and applies at most five history pages per cycle.

### Module close

SPEC-001.1 through SPEC-001.10 are implemented and accepted. Gmail is closed on this specification. No further Gmail integration starts from this change.
