# SPEC-001.4 — Gmail Actions

## Status

Implemented. The user confirmed that the Gmail actions they tested work and that the reviewed Mail interface, including the Folders toggle, looks correct. Named checks that were not reported stay pending in Manual acceptance. Parent specifications: [SPEC-001.1-persistence.md](SPEC-001.1-persistence.md), [SPEC-001.2-gmail-oauth.md](SPEC-001.2-gmail-oauth.md), [SPEC-001.3-gmail-reader.md](SPEC-001.3-gmail-reader.md), and [SPEC-001.5-aurora-visual-system.md](SPEC-001.5-aurora-visual-system.md). SPEC-001.3 remains the reader. This specification adds the only Gmail writes Aurora may perform.

## Goal

Let a person change the connected Gmail mailbox from Aurora: mark a conversation read or unread, star or unstar one message, archive a conversation, move it to Trash, restore it from Trash, and add or remove an existing user label. Gmail stays the source of truth. Aurora does not keep a mailbox cache.

## Non-goals

Sending, replying, forwarding, and drafts are out of scope. Permanent deletion is out of scope. `threads.delete`, `messages.delete`, and `messages.batchDelete` are not called. Bulk changes across conversations are out of scope. Creating, renaming, and deleting labels are out of scope. Attachment download, filters, automatic processing, AI actions, background sync, and `history.list` are out of scope. No new dependency and no mailbox table. Schema version 2 adds the granted-scope column described below. Electron sandbox, context isolation, disabled Node integration, web security, the navigation block, denied `window.open`, and both content security policies stay as they are.

## Decisions

- Extend the SPEC-001.3 reader and its IPC. Do not add a second Gmail client or a generic API proxy.
- Conversation actions use thread methods. A star uses `messages.modify` on one message id. The same star is not applied to the rest of the thread.
- `https://www.googleapis.com/auth/gmail.modify` replaces `gmail.readonly` in the authorization request. `gmail.readonly` is not kept beside it. `include_granted_scopes` stays absent. `https://mail.google.com/` is not requested.
- An existing refresh token is kept until a new consent succeeds. A missing scope is not `invalid_grant` and does not mark the account `needs_reauth`.
- The renderer chooses a named action. Main chooses the endpoint, the HTTP method, and the label ids for read, unread, archive, trash, and restore.
- A user-label change sends exactly one label id. Main accepts it only when that account's own `users.labels.list` returns it with type `user`.
- No optimistic removal is committed before Gmail accepts the call. The visible row may show a pending state. On failure it returns to the previous flags.
- Trash asks for confirmation. Archive, read state, star, and label changes do not.
- A Mail sidebar lists folders vertically. The message list is the scrolling region. Each row uses two lines, and its actions sit in a separate column.

## Existing architecture

SPEC-001.1 stores one refresh token per account as `safeStorage` ciphertext in SQLite. Schema version 2 adds `connected_accounts.granted_scopes`. Access tokens are not stored. A version 1 database gains that column with the default grant `openid email profile https://www.googleapis.com/auth/gmail.readonly`, so an existing account stays read-only until the person reconnects. A fresh database is created at version 2 and does not insert that historical default.

SPEC-001.2 runs Authorization Code with PKCE. The granted scope set requested for a new consent is `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/gmail.modify`. Accounts migrated from version 1 keep the historical read-only grant until reconnect. The authorization URL does not send `include_granted_scopes`. `prompt` is `consent select_account`. Reconnect is the same flow with an expected account id. Cancel and `access_denied` leave the stored refresh token in place. One phase machine serializes connect, reconnect, cancel, disconnect, and client-id changes. A mailbox read holds a lease that blocks disconnect and those account changes.

SPEC-001.3 calls `https://gmail.googleapis.com/gmail/v1/users/me/` with `fetch` from the Electron main process. The channels are `gmail:labels`, `gmail:threads`, `gmail:thread`, and `gmail:open-link`. Each handler checks the authorized sender, requires exact keys, and rejects an extra field. Shared parsers in `src/shared/gmail.ts` run again in the preload and the renderer. Access tokens stay in a main-process map keyed by the Aurora account UUID. A Gmail 403 does not refresh the access token and does not delete the refresh token. Only a token-endpoint `invalid_grant` marks `needs_reauth` and makes that refresh token unusable. The mail view drops a settled read whose generation is no longer current. Main does not receive that generation and does not cancel the HTTP call.

The thread summary is `{ id, subject, from, date, snippet, unread, starred }`. `unread` is true when any metadata message includes `UNREAD`. `starred` is true when any metadata message includes `STARRED`. A message in an open conversation also carries `starred` and `labelIds`. The list metadata request already returns `labelIds`.

SPEC-001.5 supplies Outfit and Inter, Lucide, the 56px row, the 48px conversation header, `.control` states, and the folder column. The open control is a `button` inside `ul li`. That selector stays valid.

## Gmail API

`userId` is always `me`. The renderer cannot choose the mailbox address. Official method pages, checked for this specification, are the source for the shapes below. Quota units are from the Gmail usage-limits page after the 1 May 2026 update. A Cloud project that used the API between November 2025 and April 2026 may still be on the previous per-user quota. Aurora treats `429` the same in either case.

| Action                     | Method                       | Units | Body                                |
| -------------------------- | ---------------------------- | ----- | ----------------------------------- |
| Mark conversation read     | `POST /threads/{id}/modify`  | 10    | `{ "removeLabelIds": ["UNREAD"] }`  |
| Mark conversation unread   | `POST /threads/{id}/modify`  | 10    | `{ "addLabelIds": ["UNREAD"] }`     |
| Archive                    | `POST /threads/{id}/modify`  | 10    | `{ "removeLabelIds": ["INBOX"] }`   |
| Add one user label         | `POST /threads/{id}/modify`  | 10    | `{ "addLabelIds": ["<id>"] }`       |
| Remove one user label      | `POST /threads/{id}/modify`  | 10    | `{ "removeLabelIds": ["<id>"] }`    |
| Star one message           | `POST /messages/{id}/modify` | 5     | `{ "addLabelIds": ["STARRED"] }`    |
| Remove one star            | `POST /messages/{id}/modify` | 5     | `{ "removeLabelIds": ["STARRED"] }` |
| Move conversation to Trash | `POST /threads/{id}/trash`   | 20    | empty                               |
| Restore conversation       | `POST /threads/{id}/untrash` | 10    | empty                               |

`threads.modify` applies the label change to every existing message in the thread. Messages that arrive later do not inherit it. `messages.modify` changes only that message. `threads.trash` moves every message in the thread to Trash. `threads.untrash` removes every message in that thread from Trash. Gmail restores the labels those messages had before Trash; Aurora does not invent or store that previous set.

`messages.trash`, `messages.untrash`, `threads.delete`, and `messages.delete` are not used. `messages.modify` also accepts classification-label fields. Aurora does not send `addClassificationLabels` or `removeClassificationLabelIds`.

A successful `threads.modify`, `threads.trash`, or `threads.untrash` returns a Thread. A successful `messages.modify` returns a Message. Aurora reads `id` and, when present, `labelIds` or each message `labelIds`. It ignores `historyId`, `snippet`, `payload`, and `raw`. The returned `id` must equal the id Aurora sent. Any other id is `invalid-response`. A `200` whose id matches is success even when `labelIds` is absent. Aurora does not require Gmail to echo the label.

`UNREAD` is a label. A conversation is unread when any message has it. Removing `UNREAD` from the thread marks every current message read, including one the person had already read. Adding `UNREAD` marks every current message unread. That is the conversation action. It is not a per-message read control.

`STARRED` is a label on a message. A thread looks starred when any message has it. Starring through `threads.modify` would star every message. Aurora does not do that. The list derives `starred` from metadata `labelIds` that the reader already fetches. The open message derives `starred` from the full thread that the reader already fetches.

Archive removes `INBOX` only. It does not remove `UNREAD`, `STARRED`, `IMPORTANT`, category labels, or user labels. It does not add `TRASH`.

User labels exist on messages. The folder list already shows type `user`. Applying or removing one through `threads.modify` changes every current message in the conversation. Draft-only threads cannot take labels; Gmail rejects that change and Aurora surfaces the failure without a local label.

Per-user quota is 6,000 units per minute on the current published limit, and 1,200,000 units per minute per project. One Trash is 20 units. The page size of 20 and these single actions stay inside normal use. There is no `batchModify`. The SPEC-001.3 retry applies: one retry of at most 2 seconds for `429` or a quota reason, and one retry for HTTP 500 or 503. These label writes are idempotent, so that retry does not create a second kind of change. HTTP 400 is not retried.

## OAuth scope and migration

`gmail.modify` is the narrowest scope named on `threads.modify`, `threads.trash`, `threads.untrash`, and `messages.modify`. Those methods also allow `https://mail.google.com/`. `messages.modify` additionally allows `gmail.modify.restricted` for domain-wide delegation. Aurora uses none of those wider scopes.

Google describes `gmail.modify` as read, compose, and send, without immediate permanent deletion. Aurora will not call send, drafts, insert, import, or permanent delete. There is no official scope that can change labels and trash while excluding compose and send. `gmail.labels` manages label resources. It does not authorize `threads.modify`. `gmail.readonly` cannot perform any action in this specification.

The authorization request becomes exactly `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/gmail.modify`. New connections and reconnects use that list. The consent screen therefore changes from view-only to the broader `gmail.modify` wording. That wording is accepted because it is the minimum method scope.

Refresh tokens already stored were minted for `gmail.readonly`. Google does not add scopes to that token. Reads keep working. Aurora stores the scope string from the token response on the account. Before a mutation it reads that string. When `gmail.modify` is absent it returns `insufficient-scope` and does not call Gmail. HTTP 403 with `insufficientPermissions` or `ACCESS_TOKEN_SCOPE_INSUFFICIENT` remains the fallback for a grant that changed at Google after the stored string was saved. That result is `insufficient-scope`. The refresh token stays. The account does not become `needs_reauth`. The access token stays cached for reads.

The authorization-code response must include a scope string that contains `openid`, `email`, `profile`, and `gmail.modify`. A missing or malformed scope is `provider-rejected` and is not committed. A well-formed scope that lacks one of those values is `scope-denied`, sentence `Google did not grant permission to change mail. The saved account was kept.` It is not `invalid_grant`, it does not delete the refresh token, and it does not drop the cached access token. The first connection with `scope-denied` creates no account.

Reconnect is the migration. It is the existing SPEC-001.2 reconnect: the system browser, the same client, `prompt=consent select_account`, and a refresh token written only after the token response is accepted. `oauth-denied`, Cancel, and `scope-denied` leave the previous ciphertext and the previous `granted_scopes` in place. A successful reconnect replaces `granted_scopes` and drops that account's cached access token before the next Gmail call. The cache is keyed only by account id and would otherwise keep serving a token whose scopes are still `gmail.readonly` until it expires. A 403 does not trigger a refresh, so the cache drop is required for the new grant to be used.

A refresh response may omit `scope`. Aurora then leaves the stored grant unchanged. A refresh response that includes a valid scope string replaces the stored grant, even when `gmail.modify` is no longer present. The refresh token stays. The account summary exposes `canModifyMail` and does not expose the raw scope string, the access token, or the refresh token. When `canModifyMail` is false the mail view shows the reconnect sentence and a Reconnect link to Integrations, and it does not call a mutation.

`invalid_grant` from the token endpoint stays `needs-reauth` and still makes the refresh token unusable. `forbidden`, and a 403 without a recognized reason, stay `permission-denied` or `unavailable` as in SPEC-001.3. They are not `insufficient-scope`.

## Process boundaries

Main owns the Gmail URL, the bearer token, the JSON body, label allowlists, response checks, and the mailbox lease. Preload exposes one function per action and no `fetch`. The renderer sends the Aurora account UUID, the thread id, and, for a star, the message id, or, for a user label, that label id. It does not send HTTP paths, methods, or label ids for read, unread, archive, trash, or restore.

The renderer applies a result only when the account id and the view generation captured at the click are still current. Main still performs the call with the account id from that request. Switching accounts does not retarget the call. Main does not cancel a POST that has been sent.

Each mutating call takes the existing mailbox lease, so disconnect and reconnect wait until it finishes. The lease is not an undo.

## IPC

New codes: `insufficient-scope`, sentence `Reconnect this Google account before changing mail.`

Existing codes and sentences stay, including `unavailable` (`Aurora could not read this mailbox.`). An action failure with `unavailable`, `network`, `rate-limited`, `gmail-rejected`, or `not-found` is shown by the mail view with a fixed sentence that names the action, for example `Aurora could not archive this conversation.` Account-level results `needs-reauth`, `insufficient-scope`, and `permission-denied` use their shared sentences and may link to Integrations.

| Channel                | Argument                             | Success                                   |
| ---------------------- | ------------------------------------ | ----------------------------------------- |
| `gmail:mark-read`      | `{ accountId, threadId }`            | `{ threadId, unread: false }`             |
| `gmail:mark-unread`    | `{ accountId, threadId }`            | `{ threadId, unread: true }`              |
| `gmail:archive-thread` | `{ accountId, threadId }`            | `{ threadId }`                            |
| `gmail:trash-thread`   | `{ accountId, threadId }`            | `{ threadId }`                            |
| `gmail:untrash-thread` | `{ accountId, threadId }`            | `{ threadId }`                            |
| `gmail:add-label`      | `{ accountId, threadId, labelId }`   | `{ threadId, labelId }`                   |
| `gmail:remove-label`   | `{ accountId, threadId, labelId }`   | `{ threadId, labelId }`                   |
| `gmail:star-message`   | `{ accountId, threadId, messageId }` | `{ threadId, messageId, starred: true }`  |
| `gmail:unstar-message` | `{ accountId, threadId, messageId }` | `{ threadId, messageId, starred: false }` |

Ids use the SPEC-001.3 grammar: 1 to 128 characters, `[A-Za-z0-9_-]`. Exact keys only. An extra field is `invalid-response`. `accountId` must be an Aurora Google account UUID in `connected` state. `labelId` must be type `user` on that account's fresh label list. `INBOX`, `UNREAD`, `STARRED`, `TRASH`, `SPAM`, `SENT`, `DRAFT`, `IMPORTANT`, `CHAT`, and `CATEGORY_*` are rejected on the label channels even if a future list returned them as user labels.

The read model gains `starred` on the thread summary and on each open message, taken from `STARRED` in `labelIds` already returned by Gmail. Each open message also gains `labelIds`, an array of ids in that grammar, length 0 through 100. More than 100 ids makes the conversation `unavailable`. The summary does not copy those ids. No `historyId` is added.

## UI

The visual system is SPEC-001.5. No new component framework. Icons are Lucide at 16px and stroke 1.75: `MailOpen` for mark read, `Mail` for mark unread, `Archive`, `Trash2`, `RotateCcw` for restore, `Tag` for labels, `Star` for starred. Decorative icons are `aria-hidden`. Icon-only buttons have a visible accessible name through `aria-label`, not a second copy of visible text.

Mail folders are a second sidebar inside the Mail workspace. The Aurora navigation sidebar is unchanged. The Mail sidebar is 188px and lists the system folders and any user labels already loaded, in that order, with the existing icons, names, and unread counts. The active folder keeps the accent fill. The sidebar does not scroll on its own. The account selector and search stay above it.

The workspace is a column beside that sidebar at the widths used by the 760px, 880px, and 1280px windows. When the Mail content width is at most 560px, the sidebar collapses to a 48px icon rail. The Folders control is a `.control` button named `Folders`, with the Lucide `PanelLeft` icon, `aria-expanded`, and the existing focus ring. Its selector is `.mail-folder-bar .mail-folder-toggle`, which beats `.control { display: inline-flex }`. It is `display: none` while the 188px sidebar is showing, so it leaves no gap above Inbox. It is `display: inline-flex` only inside `@container mail-screen (max-width: 560px)`. Opening it lays the 188px folder list over the message list. Choosing a folder, including the folder that is already selected, closes that overlay. There is no horizontal folder row.

The message list is the only region that scrolls while the inbox is open. Search, the folder sidebar, and the page controls stay in place. An open conversation hides the Mail sidebar and scrolls inside the reading stage. The reading column and the 48px header stay as they are.

Each row is at least 64px. The open control is still a `button` and is not a parent of the action buttons. The first line is the subject and the snippet. The second line is the sender and the date. A 112px column on the right holds mark read or unread, archive or restore, and Trash, aligned in one horizontal group. Those buttons use `.control` at 32px: pointer, hover, `:focus-visible` ring, `cursor: default` when disabled, and `cursor: progress` with `aria-busy="true"` while that action is in flight. They stay in tab order. Subject, snippet, sender, and date truncate on their own line and do not overlap the action column. The unread marker and the unread weight stay. A starred summary still shows a star and the accessible text `Starred`.

Row actions are mark read or mark unread, archive, and Trash. Archive is omitted when the active label is not `INBOX` and no search is active, except it remains available when the open model says the thread is in the inbox. From the `TRASH` label the row offers Restore instead of Archive and Trash. The row does not star and does not edit labels. A starred summary shows a star and the accessible text `Starred`, in the same way unread is not color alone.

The open conversation keeps the 48px header. Under it, a 40px toolbar holds mark read or unread, archive or restore, Trash, and Labels. The choice between archive and restore follows the thread: restore when every shown path is Trash or the active label is `TRASH`; otherwise archive when any message has `INBOX`. Trash is hidden when the thread is already in Trash. Each message header gains one star button, `aria-pressed` for its own `starred` value, named `Star` or `Remove star`.

Labels opens a listbox of the user labels already loaded for this account. Each option is `aria-pressed` when any open message includes that id. Choosing it adds or removes that one label. There is no create, rename, or delete control. No user labels shows the text `No labels`.

Trash opens a dialog titled `Move to Trash?` with the text `You can restore this conversation from Trash.` Actions are Cancel and `Move to Trash`. Escape and Cancel close it without a Gmail call. The confirm button is `.control-danger`. Focus moves to Cancel when the dialog opens and returns to the Trash button when it closes. Archive has no dialog.

While an action is in flight, every action for that thread is disabled. A failed action restores the flags from before the click and shows the action sentence. A successful action updates those flags. The current folder and search stay selected.

List membership changes only when no search is active:

- `INBOX` and archive or Trash removes the row.
- `TRASH` and restore removes the row.
- A user label and removal of that same label removes the row.
- `STARRED` and the last star removed from the open thread removes the row.

A search stays as SPEC-001.3 defines it, including spam and trash, so archive or Trash does not drop the row. Aurora does not assume those results remain valid. A successful mutation while a search is active marks the results stale and offers Refresh. Refresh reloads the first page of the same query. It does not reload the whole mailbox, and Aurora does not reload the list after every action. Unread counts on folder buttons move by one only when the row's unread flag flips and that folder's count is a number. They are not refetched. The page token is kept. The page may show fewer than 20 rows until the person changes page, label, or search. Aurora does not rewrite the token.

## State and concurrency

There is no SQLite mailbox table. The visible list and the open thread are the only copies. Gmail is reread through the existing list and thread calls when the person navigates.

The renderer keeps the SPEC-001.3 generation. A click captures the account id, thread id, and generation. The result is ignored when any of those no longer match the view. The Gmail call still belongs to the captured account.

Main allows one mutation at a time per Aurora account id plus thread id, including a star on a message in that thread. A second mutation for that pair returns `operation-in-progress` and does not call Gmail. Different threads may proceed. Different accounts may proceed. The renderer disables the thread's actions for the same interval.

A `not-found` result removes the open conversation and the matching row. It does not change another account's list. A revoked grant follows the SPEC-001.3 token rules. A network failure leaves both the credential and the previous flags in place.

## Errors

| Condition                                                                             | Code                 | Credential                        |
| ------------------------------------------------------------------------------------- | -------------------- | --------------------------------- |
| Authorization-code response lacks `gmail.modify`                                      | `scope-denied`       | Previous ciphertext kept          |
| Token endpoint `invalid_grant`                                                        | `needs-reauth`       | Marked unusable, as in SPEC-001.2 |
| Mutating HTTP 403 with `insufficientPermissions` or `ACCESS_TOKEN_SCOPE_INSUFFICIENT` | `insufficient-scope` | Unchanged                         |
| Other permission 403                                                                  | `permission-denied`  | Unchanged                         |
| HTTP 404                                                                              | `not-found`          | Unchanged                         |
| HTTP 400                                                                              | `gmail-rejected`     | Unchanged                         |
| HTTP 429 or a quota reason, after the one retry                                       | `rate-limited`       | Unchanged                         |
| HTTP 500 or 503, after the one retry                                                  | `unavailable`        | Unchanged                         |
| Network failure                                                                       | `network`            | Unchanged                         |
| Response id does not match                                                            | `invalid-response`   | Unchanged                         |

A 403 is still not a refresh and not a reason to delete the refresh token. Development logs stay the SPEC-001.3 line: status and a safe reason, without body, token, subject, or address.

## Security

Context isolation, the sandbox, and disabled Node integration stay on. IPC sender checks stay in front of every new channel. The renderer cannot pass a URL, a method, or a raw JSON body. Label ids are not trusted from shape alone. Tokens, refresh tokens, and `historyId` are not IPC fields. The content security policy is unchanged. No remote image, font, or script behavior changes.

The mailbox lease and the per-thread lock are the race controls. They do not authorize one account to use another account's token. Two Aurora accounts that share a Gmail thread id string still use two credentials.

## Tests

Automated tests use an injected `fetch` and do not use Google credentials.

- Each action requests the method and path in the table, with `userId` `me`, and no other label ids.
- Star and unstar send only `STARRED` on `messages.modify`. They do not call `threads.modify`.
- Trash and untrash send an empty body and do not call `threads.delete` or `messages.delete`.
- Archive sends only `removeLabelIds: ["INBOX"]`.
- A user label is sent only after `labels.list` for that account returned it as type `user`. A system id, an unknown id, and a well-formed id absent from that list are `invalid-request` and do not modify.
- Extra IPC fields, a bad account id, and a bad thread or message id are rejected before `fetch`.
- A response whose thread or message id differs is `invalid-response`.
- `insufficientPermissions` on a mutation is `insufficient-scope` and does not change account status or the stored refresh token.
- Token-endpoint `invalid_grant` is `needs-reauth` and follows SPEC-001.2.
- A network error and a 404 do not change the credential. The 404 result drops only that account's row in the component test.
- Two overlapping mutations for one account and thread produce one Gmail call and one `operation-in-progress`.
- A late success for the previous account does not change the current account's rows.
- The mail component marks a row read, removes an inbox row after archive, leaves a search row in place, restores flags after a rejected archive, and reaches row actions from the keyboard without nesting buttons.
- Existing reader tests still pass, including unread parsing, stale generation, and no Gmail write from a read.

## Known limitations

Aurora does not send, reply, forward, save drafts, download attachments, or permanently delete. There is no bulk action, no way to create, rename, or delete a label, and no mailbox cache. Read, unread, archive, trash, restore, and a user label change every current message in the thread. A star changes one open message. `gmail.modify` is the consent scope, so Google's consent text mentions compose and send even though Aurora does not call those methods. An account migrated from schema version 1 stays read-only until reconnect. Cancel and `scope-denied` keep the previous grant. Search results stay on screen after a mutation and are marked stale. Refresh reloads the first page of that same query. It does not reload the mailbox. After a removal the current page can show fewer than 20 rows, and Aurora does not repair a page token that Gmail invalidates. If Gmail accepts a write and the response id does not match, the interface rolls back and the next load shows Gmail's state. Aurora does not send a compensating write. The Folders toggle stays hidden at the reviewed 760px, 880px, and 1280px windows, because those widths keep the 188px sidebar.

## Manual acceptance

Reviewed on 8 November 2026. Use a disposable conversation and a disposable user label. Do not use permanent delete.

Confirmed by the user, as a review of the actions they exercised and of the current Mail screen. These are not item-by-item passes of the pending list:

- The Gmail actions tested from Mail work.
- The Mail sidebar, the two-line message rows, and the rest of the reviewed Mail layout look correct.
- The responsive Folders toggle is hidden while the folder sidebar is fully visible.

Pending. The user did not report these named checks:

- A connected account that has not reconnected can still open the inbox. Mark read shows the reconnect sentence and the message stays unread in Gmail.
- Reconnect grants `gmail.modify`. Cancel during that reconnect leaves the old account able to read.
- After reconnect, mark read clears the unread state in Aurora and in Gmail web. Mark unread sets it again on the conversation.
- Star on one message in an open conversation stars that message only. Another message in the same conversation stays unstarred in Gmail web. Remove star reverses the one message.
- Archive removes the conversation from the Inbox and leaves it out of Trash. A user label that was on it remains.
- Trash asks for confirmation. Cancel does not change Gmail. Confirm moves the conversation to Trash. Restore from Trash returns it, and Gmail's previous labels are whatever Gmail restored.
- Add and remove an existing user label. Aurora does not offer a way to create or delete the label.
- A second connected account does not gain or lose that label, star, or trash state.
- Revoking the Google grant, then reading or archiving, becomes `needs-reauth` rather than a scope error.
- An `https` link still opens only from a click. A remote image is still not requested.

## Verification

Checked on 8 November 2026, including the Mail sidebar, two-line rows, and the hidden Folders toggle. `pnpm lint`, `pnpm format:check`, and `pnpm typecheck` passed. Node tests: 164 passed, 34 suites. Vitest: 22 passed, 8 files. Coverage: lines 93.18, branches 82.83, functions 90.89. Build: main 523.85 kB, preload 20.69 kB, CSS 28.15 kB, JS 334.14 kB. `pnpm check:build` passed. Package used `electron-builder` 26.17.0 with `--win --x64 --publish never`. Signing was skipped. Installer 110216094 bytes. Unpacked 386144057 bytes. `pnpm check:package` passed. The confirmed review and the pending named checks are recorded in Manual acceptance.

## Stages

1. Replace the scope constant and drop the cached access token after a successful reconnect. Cover the old and new scope strings and the cache drop.
2. Add the mutating calls, the per-thread lock, `insufficient-scope`, and the reader tests.
3. Add the IPC channels, preload, renderer client, `starred`, and message `labelIds`.
4. Add the row actions, conversation toolbar, message star, label list, and Trash dialog. The Mail sidebar and the two-line row replace the horizontal folder row.
5. Run the quality commands. Manual acceptance uses the list above.

## Risks

`gmail.modify` is a restricted scope, as `gmail.readonly` already is. The consent text mentions compose and send. A reviewer can reject that wording; the alternative is not to ship these actions. `mail.google.com` would be wider, not narrower.

`threads.modify` rewrites every current message. Mark unread will mark an older read message unread. That matches the conversation action and will surprise someone who expected a single-message read state. Message-level read state is not in this specification.

A short list page after a removal is expected. The following page token can also skip or repeat if Gmail invalidates it. The existing next-page error path handles an unusable token. Aurora does not try to repair it.

A cached access token from before reconnect would make the first actions look unauthorized. The cache drop in stage 1 is what prevents that.

A mutation that Gmail accepts and whose response Aurora then rejects as `invalid-response` can leave Gmail changed while the UI rolls back. The next list or thread load corrects the view. Aurora does not send a compensating write.

## Approval

The architecture above is approved. `gmail.modify` replaces `gmail.readonly` in the authorization request. The official compose-and-send consent text is accepted because no narrower scope can modify and trash. Stars stay on one open message. Trash is confirmed and archive is not. The `unavailable` sentence stays on the IPC code, and the mail view names the failed action. A successful action does not reload the mailbox. Search results are marked stale and can be refreshed. Granted scopes are stored per account. A known read-only account is refused before Gmail is called.
