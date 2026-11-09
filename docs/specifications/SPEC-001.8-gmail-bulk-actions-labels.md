# SPEC-001.8 — Gmail Bulk Actions and Advanced Labels

## Status

Implemented and manually accepted by the project owner. Individual manual scenarios were not recorded one by one. Baseline before this work: `be9af837836eda83b58c009d106efb45ce767343`. Parent specifications: [SPEC-001.3-gmail-reader.md](SPEC-001.3-gmail-reader.md), [SPEC-001.4-gmail-actions.md](SPEC-001.4-gmail-actions.md), [SPEC-001.5-aurora-visual-system.md](SPEC-001.5-aurora-visual-system.md), [SPEC-001.6-gmail-compose.md](SPEC-001.6-gmail-compose.md), and [SPEC-001.7-gmail-drafts-attachments.md](SPEC-001.7-gmail-drafts-attachments.md). SPEC-001.4 remains the single-conversation action model. This specification adds selection of the visible page, the same actions applied to that selection, and user-label create, rename, and delete. It does not replace the reader, the composer, or drafts.

The decisions in [Decisions requiring approval](#decisions-requiring-approval) were accepted, including a separate `notAttempted` outcome and visible copy that distinguishes bulk star from bulk unstar. The manual checks below are not marked passed individually.

## 1. Goals and exclusions

### Goals

- Select conversation rows on the current visible page, select every visible row, clear that selection, and show how many rows are selected.
- Apply the existing conversation actions to that selection: mark read, mark unread, archive, move to Trash, restore from Trash, and add or remove one existing user label.
- Star and unstar without turning the SPEC-001.4 message-level star into a thread-wide star.
- Create, rename, and delete custom Gmail labels, then refresh the folder list from Gmail.
- Report partial success per conversation. Do not claim the whole selection changed when only some calls succeeded.
- Keep tokens in the main process, keep `gmail.modify`, and keep schema version 2.

### Exclusions

- No "select every conversation that matches this search in Gmail". Selection never walks past the current page of at most 20 rows.
- No `messages.batchModify`, `messages.batchDelete`, `messages.delete`, `threads.delete`, or `labels.patch`.
- No permanent message deletion. `users.labels.delete` removes the label and detaches it from mail. It does not delete messages.
- No label colors, no Gmail filters, no nested-label editor, and no change to label visibility after creation.
- No SQLite table or migration for labels. Gmail remains the only store.
- No new OAuth scope, no `include_granted_scopes`, and no `https://mail.google.com/`.
- No generic Gmail proxy. The renderer names an action. Main chooses the endpoint.
- No change to compose, drafts, attachments, search ranking, or the dashboard.
- SPEC-001.9 does not start.

## 2. Existing architecture

The published reader lists threads with `GET /gmail/v1/users/me/threads?maxResults=20`. `labelIds`, `pageToken`, and `q` are optional. `includeSpamTrash` is true only for Spam, Trash, or an active search. Search replaces the folder filter. Changing account, folder, or search clears the page stack. A generation counter drops a response that belongs to an older account, folder, search, or page.

Each visible row is a thread summary: `id`, `subject`, `from`, `date`, `snippet`, `unread`, and `starred`. `unread` and `starred` are true when any metadata message in that thread carries `UNREAD` or `STARRED`. The message ids used to compute those flags are discarded before the summary crosses IPC. The row therefore cannot name the message that is starred.

Visible folders are `INBOX`, `SENT`, `DRAFT`, `SPAM`, `TRASH`, `STARRED`, `IMPORTANT`, and every label whose `users.labels.list` entry has `type` `user`. `CATEGORY_*`, `UNREAD`, and `CHAT` stay hidden. User labels are sorted by name. The folder column is 200px when `main` is at least 960px wide and one scrolling 40px row below that. The Aurora sidebar stays 232px or 64px. Rows are two lines. Row actions sit in a separate column: read or unread, archive when the folder is Inbox or a search is active, restore in Trash, and Trash elsewhere. Trash asks for confirmation. Archive, read state, star, and label changes do not.

SPEC-001.4 writes:

| Action                       | Endpoint                     | Effect                                                            |
| ---------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| Mark read or unread          | `POST /threads/{id}/modify`  | Adds or removes `UNREAD` on every message already in the thread   |
| Archive                      | `POST /threads/{id}/modify`  | Removes `INBOX` only                                              |
| Add or remove one user label | `POST /threads/{id}/modify`  | The same one label id, after a fresh list proves `type` is `user` |
| Move to Trash                | `POST /threads/{id}/trash`   | Moves every message in the thread to Trash                        |
| Restore                      | `POST /threads/{id}/untrash` | Restores the thread                                               |
| Star or unstar               | `POST /messages/{id}/modify` | `STARRED` on that one message id                                  |

A later message does not inherit a label applied earlier. System label ids are rejected on the user-label channel. One mutation per account and thread is reserved in `busyThreads`. A second mutation for that pair returns `operation-in-progress`. `requireGrant` runs before a write. HTTP 403 `insufficientPermissions` or `ACCESS_TOKEN_SCOPE_INSUFFICIENT` is `insufficient-scope` and does not delete the refresh token. Only token-endpoint `invalid_grant` is `needs-reauth`.

The Gmail client allows `GET`, `POST`, `PUT`, and `DELETE` under `https://gmail.googleapis.com/gmail/v1/users/me`. It retries one HTTP call once on 429, 500, or 503 when the call is not a send or draft delivery. A timeout becomes `network` and is not retried. Access tokens stay in a main-process map keyed by the Aurora account id. `userId` is always `me`.

IPC objects use exact keys. An extra field is `invalid-request` on input and `invalid-response` on a Gmail body Aurora parses. The renderer does not send an HTTP method, a URL, or a raw Gmail body. The same Gmail thread id on two Aurora accounts uses two credentials.

`canModifyMail` is the renderer signal. A read-only grant hides write controls. Schema version is 2. `googleScopes` is `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/gmail.modify`.

Official quota figures checked for this specification, from [Gmail API usage limits](https://developers.google.com/workspace/gmail/api/reference/quota) and the method pages, as published after the 1 May 2026 quota update:

| Method                               | Units | Scope that Aurora already holds |
| ------------------------------------ | ----- | ------------------------------- |
| `threads.modify`                     | 10    | `gmail.modify`                  |
| `threads.trash`                      | 20    | `gmail.modify`                  |
| `threads.untrash`                    | 10    | `gmail.modify`                  |
| `threads.get` with `format=metadata` | 40    | `gmail.modify`                  |
| `messages.modify`                    | 5     | `gmail.modify`                  |
| `messages.batchModify`               | 50    | `gmail.modify`                  |
| `labels.list`                        | 1     | `gmail.modify`                  |
| `labels.create`                      | 5     | `gmail.modify`                  |
| `labels.update`                      | 5     | `gmail.modify`                  |
| `labels.delete`                      | 5     | `gmail.modify`                  |

Per user per minute the limit is 6,000 units. Per project per minute it is 1,200,000. A Cloud project that called the API between November 2025 and April 2026 may still be on its previous quota. Aurora treats HTTP 429 the same in either case. There is no `threads.batchModify`. `messages.batchModify` accepts up to 1,000 message ids, returns an empty body, and changes only those messages.

`users.labels.create`, `users.labels.update`, and `users.labels.delete` each accept `gmail.modify`. `gmail.labels` also authorizes them and is not requested. A mailbox may hold up to 10,000 labels. A label name that duplicates an existing label is rejected by Gmail. System labels cannot be updated or deleted. A `/` in a name is Gmail's nested-label separator. This specification does not let Aurora create or rename such a name.

## 3. Selection model

Selection is a set of thread ids drawn only from the rows currently rendered. The page size is 20, so the set holds at most 20 ids.

- Each row has a checkbox outside the button that opens the conversation. Its accessible name is `Select` plus the subject, or `Select (no subject)`.
- A header checkbox selects every visible row, clears them when all are selected, and uses `indeterminate` when the selection is a strict subset. Its name is `Select all visible conversations`.
- A `Clear selection` button empties the set. It is shown only when the count is greater than zero.
- The count is the number of selected ids that are still present in the visible rows. The text is `{n} selected`.
- Ids that are not in the visible rows are not kept. Previous and Next, a folder change, a search change, an account change, Refresh, and opening a conversation all clear the selection.
- Returning from a conversation does not restore the selection.
- A new list generation clears the selection even if some thread ids appear again.
- Shift-click range selection is not part of this specification.
- There is no control that asks Gmail for every thread matching the folder or the query.

Keyboard use follows SPEC-001.5. Tab order is source order. The checkbox, the row button, and the row actions are separate controls. Space toggles the focused checkbox and does not open the conversation. Focus uses the existing 2px accent ring. Disabled controls do not take the pointer.

On a narrow window the checkbox stays a 40px target. The bulk toolbar wraps inside the list column. The folder rail and the Aurora sidebar are not resized.

## 4. Gmail API endpoints

Main calls only these URLs, with `userId` `me`:

- `POST /threads/{id}/modify` for read, unread, archive, and one user label.
- `POST /threads/{id}/trash` and `POST /threads/{id}/untrash`.
- `GET /threads/{id}?format=metadata` while starring or unstarring, to recover message ids the list summary does not keep.
- `POST /messages/{id}/modify` for `STARRED` on the messages chosen by the rules below.
- `GET /labels` before a user-label apply, remove, rename, or delete, and after every successful label-definition change.
- `POST /labels` to create.
- `PUT /labels/{id}` to rename.
- `DELETE /labels/{id}` to delete.

`messages.batchModify` is not used. A page of 20 conversations is at most 200 units for read, unread, archive, or a user label, and at most 400 units for Trash. `batchModify` costs 50 units per request but requires message ids the list does not have, returns no per-message body, and would leave any message not included in the id list unchanged. That is a different result from `threads.modify`. Using it here would also invite a mailbox-wide update, which this specification excludes.

Bodies match SPEC-001.4:

- Mark read: `{ "removeLabelIds": ["UNREAD"] }`
- Mark unread: `{ "addLabelIds": ["UNREAD"] }`
- Archive: `{ "removeLabelIds": ["INBOX"] }`
- Add a user label: `{ "addLabelIds": ["<one user id>"] }`
- Remove a user label: `{ "removeLabelIds": ["<one user id>"] }`
- Star one message: `{ "addLabelIds": ["STARRED"] }`
- Unstar one message: `{ "removeLabelIds": ["STARRED"] }`

Trash and restore send no label body. Create sends only `name`, `labelListVisibility: "labelShow"`, and `messageListVisibility: "show"`. Rename sends the new name and those same two visibility values. Aurora does not send `color`, `type`, or a client-chosen label id on create.

## 5. Bulk-operation semantics

A bulk request names one account, one action, and 1 to 20 distinct thread ids. The renderer may send only ids from the current visible rows. Main still validates the grammar and the count, because IPC is the trust boundary. More than 20 ids, a duplicate, an empty list, or an id outside `^[A-Za-z0-9_-]{1,128}$` is `invalid-request` and performs no Gmail call.

Before any Gmail call, main checks the modification grant. A read-only account is `insufficient-scope`. If a bulk operation is already reserved for that account, or any selected thread is already in `busyThreads`, the request is `operation-in-progress` and performs no Gmail call. The reservation covers the account and every selected thread until the response is built.

Calls run with the reader's concurrency of four. Each call uses the existing single retry for HTTP 429, 500, and 503. A timeout is not retried. The renderer does not send the bulk again by itself.

Outcomes are recorded per thread id:

- `succeeded` when Gmail accepts that thread's calls.
- `failed` with an existing service code when Gmail rejects that thread or a later call is not attempted.
- `unconfirmed` when the HTTP call times out or the connection drops after the request may have been accepted. Aurora does not call that a failure and does not call it a success.

If a call returns 429 after its one retry, main stops starting new calls. Threads that already succeeded stay succeeded. The thread that was limited is `failed` with `rate-limited`. Threads not started are `notAttempted`. They are not described as updated or as individually rejected.

`needs-reauth`, `insufficient-scope`, and `encryption-unavailable` stop the rest of the bulk the same way. The conversation that received the failure is `failed`. Conversations not started are `notAttempted`. Completed successes stay in `succeeded`. A timeout or dropped connection is `unconfirmed` for that conversation only, is not retried, and does not stop the others.

Read, unread, archive, and user-label changes remain thread operations. They are not expanded into per-message `messages.modify` or `batchModify`.

### Star and unstar

The open conversation keeps the SPEC-001.4 control: one `messages.modify` on the message the person is starring.

From the list, the renderer sends thread ids only. It cannot choose a message id.

For each selected thread, main reads `threads.get` with `format=metadata`:

- Bulk star adds `STARRED` only to the newest message, chosen by the greatest `internalDate`, then by message id if the dates tie. No other message in the thread is starred.
- Bulk unstar removes `STARRED` only from messages in that metadata response that already have `STARRED`, at most 50 messages. If more than 50 messages in the response are starred, those 50 are updated and the thread is `failed` with `too-large` after the partial message updates, so the summary does not say the conversation was fully unstarred. A metadata response that is already `too-large` fails that thread and continues with the others.

`threads.modify` is not used for `STARRED`.

### User labels on the selection

Main lists labels for that account immediately before the first thread call. The requested id must be present with `type` `user`. System ids, including `INBOX`, `UNREAD`, `STARRED`, `TRASH`, `SPAM`, `SENT`, `DRAFT`, `IMPORTANT`, `CHAT`, and `CATEGORY_*`, are `invalid-request` and no thread is modified. An unknown id is `not-found` and no thread is modified. Exactly one label id is accepted.

### Trash and restore

Trash uses `threads.trash`. Restore uses `threads.untrash`. Restore is offered when the visible folder is Trash. Archive is offered when the folder is Inbox or a search is active. The same rules as the single-row buttons apply to the bulk toolbar. Bulk Trash asks for confirmation with the selected count. Bulk restore does not.

### After the calls

If every selected thread succeeded, the current list generation and account are unchanged, and the bulk was not cancelled by an account switch, Mail reloads the current page and the label list. The selection is cleared. Rows that left the folder disappear because the reload came from Gmail, not because the renderer removed them optimistically before the response.

If the person changes account while calls are in flight, the calls finish on the account id captured at the start. Their result is not applied to the newly selected account. The new account's list is whatever its own load returns. The selection on the new account starts empty.

A thread that disappeared in Gmail is `not-found` for that id. Other ids continue. Aurora does not compare history ids and does not promise to detect an edit made in Gmail web. The last accepted Gmail write wins, then the reload shows the stored state.

## 6. Label lifecycle

Gmail is the authority. Aurora does not insert label rows into SQLite.

### Create

The person enters a name. Main trims it. The stored name must be 1 to 225 characters. It must not contain a character code below 32, a DEL character, or `/`. It must not equal a system label name already returned for that account, compared case-sensitively after trim. If the fresh list already contains any label with that same name, main returns `label-exists` and does not call `labels.create`. If Gmail still returns HTTP 409, the result is also `label-exists`.

The create body is the name plus `labelShow` and `show`. The response id must match the Gmail id grammar and `type` must be `user`. Otherwise the result is `invalid-response`. On success, main lists labels again and the sidebar shows the new user label in the existing sort.

### Rename

The same name rules apply. The id must be a current user label for that account. System labels are `invalid-request` with no Gmail write. A rename to the label's current name is `invalid-request`. A name owned by a different label is `label-exists`. `PUT /labels/{id}` sends the new name and the same visibility pair used at create. The returned id must equal the requested id. The label id does not change, so a folder that was selected stays selected. The list is refreshed.

### Delete

Delete applies only to a current user label. System labels are rejected before HTTP. The dialog states that Gmail removes the label from every conversation and does not delete the messages. `DELETE /labels/{id}` sends an empty body. Success is an empty JSON object. The list is refreshed. If the deleted id was the open folder, Mail selects Inbox and loads Inbox. The selection is cleared.

### External changes

A label renamed or deleted in Gmail web disappears or changes on the next `labels.list`. Aurora does not keep a private copy that could win. Applying a label that is gone at the start fails the bulk with no thread writes. A label that disappears after some threads were updated leaves those threads in `succeeded` and the rest in `failed`.

## 7. IPC contracts

New channels, exact keys, no extra fields:

```ts
interface GmailBulkThreadsRequest {
  accountId: string;
  threadIds: string[];
  action: 'read' | 'unread' | 'archive' | 'trash' | 'untrash' | 'star' | 'unstar';
}

interface GmailBulkLabelRequest {
  accountId: string;
  threadIds: string[];
  labelId: string;
  mode: 'add' | 'remove';
}

interface GmailLabelNameRequest {
  accountId: string;
  name: string;
}

interface GmailLabelRenameRequest {
  accountId: string;
  labelId: string;
  name: string;
}

interface GmailLabelDeleteRequest {
  accountId: string;
  labelId: string;
}

interface GmailBulkResult {
  succeeded: string[];
  failed: { threadId: string; code: GmailServiceCode }[];
  unconfirmed: string[];
  notAttempted: string[];
}
```

Channel names:

- `gmail:bulk-threads`
- `gmail:bulk-label`
- `gmail:label-create`
- `gmail:label-rename`
- `gmail:label-delete`

`accountId` is an Aurora account UUID. Label ids use the same grammar as Gmail ids. `threadIds` has length 1 to 20 and no duplicates.

`gmail:bulk-threads` and `gmail:bulk-label` return `GmailBulkResult` when at least one Gmail call was started or when every id was refused individually after the request was accepted. A request rejected before any reservation release path that still made no call uses the existing error channel: `invalid-request`, `insufficient-scope`, `needs-reauth`, or `operation-in-progress`.

`succeeded`, `failed`, `unconfirmed`, and `notAttempted` partition the requested ids. Their union is the request list, with no extras. `failed[].code` is an existing `GmailServiceCode`. The UI does not show `reason` or a raw Gmail body.

`gmail:label-create` returns `{ id, name }` after the refresh list contains that id. `gmail:label-rename` returns `{ id, name }`. `gmail:label-delete` returns `{ id }`.

A new service code `label-exists` uses the fixed sentence `A label with this name already exists.` No other sentence is added for bulk results. The summary sentences in the UX section are product copy, not raw errors.

The existing single-thread channels stay. The bulk toolbar does not loop them from the renderer. A compromised renderer still cannot pass an HTTP method, a URL, a label id for read or archive, or more than 20 thread ids.

## 8. UX

The list header gains the select-all checkbox, the count, and `Clear selection`. When the count is zero, the bulk actions are not rendered. When the count is greater than zero, a toolbar in the list column shows:

- Mark as read
- Mark as unread
- Archive, only for Inbox or an active search
- Restore, only for Trash
- Move to Trash, except in Trash
- Star
- Unstar
- A label menu of the current user labels, with Add and Remove for the highlighted label

The menu lists the same user labels as the folder column. It does not list system folders. If there are no user labels, the menu says so and points to the label dialog. It does not create a label inline.

Buttons use `.control`. Move to Trash and Delete label use `.control-danger`. The toolbar sets `aria-busy="true"` while a bulk request is running, and every bulk button, row checkbox, and row action is disabled for that time. The account select stays enabled, matching SPEC-001.5, so a newer account selection can supersede the view. The in-flight result is ignored for the new account.

Confirmation dialogs use the existing `role="dialog"` pattern:

- Move to Trash: `Move {n} conversations to Trash?` with Cancel and Move to Trash.
- Delete label: `Delete {name}? Gmail will remove this label from every conversation. Messages stay in Gmail.` with Cancel and Delete label.

Archive, read state, star, unstar, and applying or removing a label do not ask.

The result uses `role="status"`:

- All succeeded: `Updated {succeeded} conversations.`
- Mixed: `Updated {succeeded}. {failed} could not be changed. {unconfirmed} could not be confirmed. {notAttempted} were not attempted.`
- None succeeded: `None of the selected conversations were updated.` followed by the same non-zero clauses.

Omit a clause whose count is zero. Do not say all selected conversations were updated unless `failed`, `unconfirmed`, and `notAttempted` are empty.

The bulk toolbar states the star difference in visible text: Star marks only the newest message in each conversation. Unstar removes the star from messages that already have one, up to 50 per conversation. A conversation with more starred messages is not reported as fully updated.

Label management is one dialog opened by `Labels` in the folder column. It is available only when `canModifyMail` is true. The dialog lists user labels and provides a name field, Create, Rename, and Delete. Rename edits one label at a time. The folder chips and the 40px mobile row do not gain per-label icon buttons. Create, Rename, and Delete are disabled while their request runs. A `label-exists` result is shown beside the name field.

Loading the mailbox still uses the existing status panel. An empty page has no select-all action beyond a disabled checkbox. Search, pagination, and the conversation view stay as they are.

## 9. Security

- Refresh tokens stay in SQLite through `safeStorage`. Access tokens stay in the main process. The renderer receives account ids, label ids, thread ids, and the fixed result.
- Each new handler checks the account UUID, the grant, and the exact payload before `fetch`.
- Calls always use the credential for the Aurora account id in the request. A thread id or label id from another account is just an id; it is sent only with the requested account's token. Tests cover that split.
- The handler map is fixed. No renderer field selects a path, a method, or a raw label list.
- Read, unread, archive, trash, and restore do not accept label ids from the renderer.
- User-label apply, remove, rename, and delete accept one id and only after `labels.list` shows `type` `user` for that account.
- Create and rename reject system names, control characters, `/`, and the empty name.
- `messages.delete`, `messages.batchDelete`, and `threads.delete` are not added.
- OAuth scopes and schema version do not change. There is no migration.
- Label definitions are not written to SQLite.
- Bulk results and label errors do not include Gmail response bodies, Authorization headers, or tokens.
- A bulk of more than 20 ids is rejected so a renderer cannot turn these channels into an unbounded fan-out.

## 10. Error handling

| Situation                                                                 | Behavior                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Extra IPC field, bad id, empty selection, more than 20 ids, duplicate ids | `invalid-request`, no fetch                                                                            |
| Read-only grant                                                           | `insufficient-scope`, no fetch                                                                         |
| Revoked refresh token                                                     | `needs-reauth`, no further calls                                                                       |
| Another bulk on that account, or a selected thread already busy           | `operation-in-progress`, no fetch                                                                      |
| HTTP 429 after the one existing retry                                     | Stop the queue. That thread is `failed`. Threads not started are `notAttempted`. Do not retry the bulk |
| HTTP 500 or 503                                                           | One retry inside that call, as the reader already does                                                 |
| Timeout or dropped connection                                             | That thread is `unconfirmed`. No automatic retry. Other threads continue                               |
| Authorization or authentication failure mid-bulk                          | That thread is `failed`. Threads not started are `notAttempted`                                        |
| HTTP 404 for one thread                                                   | That thread is `not-found`. Continue                                                                   |
| Label id missing before any thread call                                   | `not-found`, no thread call                                                                            |
| Duplicate label name                                                      | `label-exists`, no second create                                                                       |
| System label create, rename, or delete                                    | `invalid-request`, no fetch                                                                            |
| Gmail web changed the same thread                                         | Last accepted write wins. Reload shows Gmail                                                           |
| Account switch during the bulk                                            | Ignore the result in the new view                                                                      |
| Stale list generation                                                     | Clear selection. Do not paint the old result                                                           |
| All ids unconfirmed or failed                                             | The status says none were updated                                                                      |

Idempotent label, read, archive, star, trash, and restore calls may use the existing one-call retry for 429, 500, and 503. The bulk operation itself is not replayed. A timeout stays unconfirmed because the client cannot know whether Gmail accepted it. The person can run the same action again on a new selection; the specification does not auto-repeat it.

## 11. Automated tests

Selection and view:

- Select one row, select all visible rows, clear, and show the count.
- Select all never includes an id that is not in the current 20.
- Previous, Next, folder change, search change, account change, and opening a conversation clear the selection.
- A mixed header checkbox is indeterminate.
- Read-only mail does not render the bulk toolbar or the Labels button.
- Existing row actions still call the single-thread channels.

Thread semantics:

- Bulk read, unread, and archive issue `threads.modify` with the SPEC-001.4 bodies, one thread id per call, and never `messages.batchModify`.
- Bulk Trash and restore issue `threads.trash` and `threads.untrash` only.
- Bulk label add and remove issue `threads.modify` with one user label id after a list entry of `type` `user`.
- A system label id on `gmail:bulk-label` performs no modify.
- Bulk star issues `threads.get` metadata and `messages.modify` only for the newest message. It does not call `threads.modify`.
- Bulk unstar issues `messages.modify` only for messages that already have `STARRED`, and stops claiming success when more than 50 are starred.

Labels:

- Create sends `labelShow` and `show`, then lists labels again.
- Rename sends `PUT` and keeps the same id.
- Delete sends `DELETE` and, when that folder was open, the next load is Inbox.
- Duplicate names and HTTP 409 become `label-exists`.
- Names with `/`, control characters, or an empty trim are rejected locally.
- System ids are rejected locally.

Reliability and IPC:

- A page where half the calls fail returns those ids in `failed` and does not report full success.
- A timeout is `unconfirmed` and is not retried.
- A 429 stops unstarted work.
- A second bulk for the same account is `operation-in-progress`.
- Extra fields, 21 ids, and duplicate ids are `invalid-request` before fetch.
- The same thread id with account A and account B uses A's token and then B's token, never the other credential.
- An account switch drops the in-flight result for the new view.

Regression:

- The existing reader, single-thread action, compose, and draft tests stay green.
- Coverage thresholds stay at lines 90, branches 80, and functions 90. New modules that this work adds are included in the coverage list when they are implemented. This specification does not weaken the thresholds.

## 12. Manual acceptance criteria

These checks are pending. None is marked passed.

1. Select three visible Inbox rows and mark them read. Those conversations become read in Gmail. The status count matches. The other rows on the page stay as they were.
2. Select all visible rows. The count equals the number of rows on the page and does not include the next page.
3. Go to the next page. The selection is empty.
4. Change folder, change search, and change account. Each change leaves the selection empty.
5. Archive a selection from Inbox. The conversations leave Inbox and remain available under All Mail or their other labels in Gmail. They are not deleted.
6. Move a selection to Trash, confirm the count, and restore it from Trash. Messages still exist.
7. Star a multi-message conversation from the bulk toolbar. Only the newest message gains the star. Older messages keep their previous star state. The star control inside the open conversation still changes only the message it already targets.
8. Unstar a conversation where two messages are starred. Both lose the star. A third message that was not starred stays unstarred.
9. Apply one custom label to a selection and remove it. System folders cannot be chosen in the label menu.
10. Create a custom label. It appears in the folder column after the refresh. Rename it. Delete it and confirm that the messages remain in Gmail without that label.
11. Try to create `INBOX`, an empty name, and a name that already exists. Aurora refuses each one and does not create a duplicate.
12. Disconnect the network after some conversations in a selection have updated. The status must not say the whole selection succeeded.
13. Start a bulk action and switch accounts before it returns. The second account does not show the first account's result.
14. Keyboard: reach a checkbox, toggle it with Space, and confirm the conversation does not open. Focus rings stay visible.
15. At 760px width, the bulk controls wrap in the list column and the folder row remains one horizontal line.

## 13. Implementation stages

1. Selection state and the list controls, with no new Gmail writes. Prove the selection clears on page, folder, search, account, and open.
2. `gmail:bulk-threads` for read, unread, archive, trash, and restore, plus `gmail:bulk-label`, the toolbar, the Trash confirmation, and the partial-result status.
3. Label create, rename, and delete, the Labels dialog, and the sidebar refresh.
4. Bulk star and unstar, only after the newest-message and 50-message rules in the approval section are accepted.
5. The automated tests above, then the existing typecheck, lint, test, coverage, build, and package pipeline. No migration and no scope change.

Stage 4 is not folded into stage 2. A bulk star must not ship as `threads.modify`.

## 14. Decisions requiring approval

1. Selection is only the current visible page, at most 20 thread ids. Aurora will not select every conversation matching a folder or a search.
2. Read, unread, archive, Trash, restore, and user-label changes stay on the existing thread endpoints, one conversation at a time. `messages.batchModify` is not used.
3. Bulk star reads metadata and stars only the newest message through `messages.modify`. Bulk unstar clears `STARRED` only on messages that already have it, at most 50 per conversation. `threads.modify` is not used to star or unstar a whole thread.
4. Aurora refuses `/` in names it creates or renames. Nested labels that already exist in Gmail still appear in the folder list.
5. New labels are created visible (`labelShow`, `show`). Color, later visibility edits, and `labels.patch` stay out of scope.
6. One bulk operation per account. If any selected thread is already busy, the whole bulk is refused before any call.
7. A mixed result is a normal response with per-thread arrays: succeeded, failed, unconfirmed, and notAttempted. The interface never reports full success unless every id succeeded. Timeouts are unconfirmed and are not retried automatically. Authorization and rate-limit stops leave unstarted conversations as notAttempted.
8. `gmail.modify` stays the only Gmail scope. Schema version stays 2. Label definitions are not stored in SQLite.
9. Label management is one dialog from the folder column. The folder rail is not redesigned.
10. `users.labels.delete` is allowed for a user label, with confirmation, because it deletes the label definition and not the messages.
