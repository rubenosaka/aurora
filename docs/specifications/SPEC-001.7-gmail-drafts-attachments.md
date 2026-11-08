# SPEC-001.7 — Gmail Drafts & Attachments

## Status

Implemented and manually accepted by the project owner. Individual manual scenarios were not recorded one by one. Parent specifications: [SPEC-001.2-gmail-oauth.md](SPEC-001.2-gmail-oauth.md), [SPEC-001.3-gmail-reader.md](SPEC-001.3-gmail-reader.md), [SPEC-001.4-gmail-actions.md](SPEC-001.4-gmail-actions.md), [SPEC-001.5-aurora-visual-system.md](SPEC-001.5-aurora-visual-system.md), and [SPEC-001.6-gmail-compose.md](SPEC-001.6-gmail-compose.md). This specification does not change the authorization request or the SQLite schema. `gmail.modify` stays the write scope. Schema version stays 2. Gmail remains the only persistent draft store. The Current code section records the baseline at `7ef1a5e0f5845c8451bd781fa6d369bd835d654e`, before this work.

## Goal

Keep unsent mail in Gmail, and let a person attach files to a new message, a reply, or a forward, and save those files from a received message. Gmail is the mailbox of record. Aurora sends only when the person uses Send.

## Non-goals

HTML composition, inline images in outgoing mail, signatures, scheduled send, Undo Send, send-as aliases, the People API, the Gmail settings API, and Google Drive links are out of scope. Unicode mailbox addresses stay out of scope. Resumable upload sessions are out of scope. A background sending queue is out of scope. Permanent deletion of sent or received messages is out of scope. Opening or executing a downloaded file is out of scope. No new dependency and no schema migration. Electron sandbox, context isolation, disabled Node integration, web security, the navigation block, denied `window.open`, and both content security policies stay as they are.

## Current code this design relies on

Verified in this repository at `7ef1a5e0f5845c8451bd781fa6d369bd835d654e`, not assumed from an earlier report.

- `schemaVersion` is 2. There is no mailbox table and no place that stores a message body or a file.
- `googleScopes` is `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/gmail.modify`. The authorization URL does not set `include_granted_scopes`. `canModifyMail` is true only when those four scopes are present. A version 1 database still defaults `granted_scopes` to the historical `gmail.readonly` grant.
- Gmail calls use `https://gmail.googleapis.com/gmail/v1/users/me/` from the main process. `GmailRequest.method` is only `GET` or `POST`. Access tokens stay in a main-process map. The renderer cannot pass a URL, a method, or a raw JSON body.
- The shared JSON reader stops at 8,388,608 bytes. A thrown `fetch` on a send is `send-unconfirmed` and is not retried. HTTP 401 on a received response refreshes the access token and retries that one call once. HTTP 429, 500, and 503 on send are `send-unconfirmed`. The same statuses on a read are retried once. The timeout is 10 seconds.
- `users.messages.send` builds one `text/plain` RFC 5322 message in `buildOutgoingRaw`. The body limit is 262,144 UTF-8 bytes. The base64url `raw` string limit is 1,048,576 bytes. There is no MIME library.
- `decodeConversation` walks `multipart/mixed`, `multipart/related`, and `multipart/alternative` to a depth of 8. A part with a filename or `Content-Disposition: attachment` becomes `{ fileName, mimeType, size }`. The walk does not keep `attachmentId`, `partId`, or the part bytes. `messages.attachments.get` is not called. The IPC success value still excludes `attachmentId`.
- The Drafts label is `DRAFT`. `threads.list` with `labelIds=DRAFT` fills the existing folder. Opening that thread uses `threads.get` and shows each message, including a draft, as mail the person can read. Nothing in that view calls `drafts.create`, `drafts.update`, `drafts.get`, `drafts.list`, `drafts.delete`, or `drafts.send`.
- The composer is one in-memory dialog. Its fields are recipients, subject, plain body, kind, `threadId`, and `messageId`. Dirty text asks before discard. `beforeunload` can warn. A crash drops the text. Send uses `gmail:send-message`. One send per account is held in `busySends`.
- `dialog` in the main process is used for the persistence error box. Mail does not call `showOpenDialog` or `showSaveDialog`. The preload bridge does not expose `fs` or a path picker.
- Trash uses `role="dialog"`. Controls use `.control`. Fields use `.field`, including `:focus-visible`. The mail sidebar stays 188px. Attachment rows already use the Lucide `Paperclip` icon and list the file name, media type, and size. They are not buttons.

## Decisions

- Keep `gmail.modify`. Do not add `gmail.compose`, `gmail.send`, or `https://mail.google.com/`. Schema version stays 2.
- Gmail stores the draft. Aurora does not write the body or the file bytes to SQLite. Bytes of an open composition live only in main-process memory, bound to that account and that composer, and are dropped when the composer closes, the account is discarded, send succeeds, or the process ends.
- The draft resource `id` is the stable id. The message `id` inside it changes on every replace. `threadId` is the conversation id and is not a draft id.
- Autosave replaces the whole draft. Before a replace, delete, or send, Aurora reads the remote draft with `format=minimal`. A different message id is a conflict. When both the stored `historyId` and the remote `historyId` are present and they differ, that is also a conflict. This is the best check Gmail's draft resource exposes. It is not a compare-and-swap. Two clients can both pass the read and both write. The later write wins. Aurora does not claim that simultaneous updates are prevented.
- A message with no attachments stays the SPEC-001.6 single `text/plain` part. A message with attachments is `multipart/mixed` built in process. No MIME dependency.
- Outgoing and incoming file bytes are capped at 5 MiB in total per message, below Gmail's 25 MB product limit, so one JSON body fits the existing response ceiling. Resumable upload is not added.
- Download uses a native save dialog. The renderer never supplies a path. Aurora does not open the saved file.
- `drafts.delete` is permanent. It is not Trash and it is confirmed.
- Sending a draft is one `drafts.send` of the current MIME. It is not also `messages.send`. An ambiguous result stays `send-unconfirmed`.

## OAuth and permissions

Official scope lists, checked for this specification:

| Method                                                           | Scopes Google lists besides `https://mail.google.com/` |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| `drafts.create`, `drafts.update`, `drafts.delete`, `drafts.send` | `gmail.modify`, `gmail.compose`                        |
| `drafts.get`, `drafts.list`                                      | `gmail.modify`, `gmail.compose`, `gmail.readonly`      |
| `messages.attachments.get`                                       | `gmail.modify`, `gmail.readonly`                       |
| `messages.send`                                                  | `gmail.modify`, `gmail.compose`, `gmail.send`          |

`gmail.modify` already covers every write in this specification and the existing reader. `gmail.compose` would not let Aurora read mail, change labels, or trash a conversation, so it cannot replace `gmail.modify`. Adding it beside `gmail.modify` would show another consent line and would not add a draft or attachment call the modify grant lacks.

`messages.attachments.get` and `drafts.get` also accept `gmail.readonly`. A historical read-only account can download an attachment and can read a draft. It cannot create, update, delete, or send a draft, and it cannot send a file. Those actions keep the SPEC-001.6 reconnect sentence and do not open a saving composer. Download stays available. Cancel during reconnect still leaves the previous grant. A successful reconnect still replaces `granted_scopes` and still drops that account's cached access token.

`include_granted_scopes` stays absent. No scope is added, so incremental authorization is not required.

## Gmail API

`userId` is always `me`. Quota figures are the per-method units published for the Gmail API. The per-user limit remains 6,000 units per minute. The per-project limit remains 1,200,000 units per minute.

| Call                 | Method                                       | Units | When                                                                     |
| -------------------- | -------------------------------------------- | ----- | ------------------------------------------------------------------------ |
| Create draft         | `POST /drafts`                               | 10    | First save of a composition that does not yet have a draft id            |
| Read draft identity  | `GET /drafts/{id}?format=minimal`            | 20    | Before every replace, and after an ambiguous save                        |
| Read draft content   | `GET /drafts/{id}?format=full`               | 60    | Open a draft for editing                                                 |
| List drafts          | `GET /drafts?maxResults=100`                 | 5     | Find the draft id for a `DRAFT` message that this session did not create |
| Replace draft        | `PUT /drafts/{id}`                           | 15    | Autosave after the first create                                          |
| Delete draft         | `DELETE /drafts/{id}`                        | 10    | Confirmed delete                                                         |
| Send draft           | `POST /drafts/send`                          | 100   | Send when a draft id exists                                              |
| Send without a draft | `POST /messages/send`                        | 100   | Send when no draft was saved                                             |
| Download attachment  | `GET /messages/{messageId}/attachments/{id}` | 20    | Save a part that has `attachmentId`                                      |
| Confirm inline bytes | `GET /messages/{messageId}?format=full`      | 60    | Save a listed part that has no `attachmentId`                            |

The current client cannot express `PUT` or `DELETE`. This specification adds those two methods to that client. It does not add a generic request channel.

`format=minimal` is the cheap identity read. The quota page prices `drafts.get` at 20 units unless `format` is `full`, `raw`, or `html`, which cost 60. Aurora does not use `format=raw` for ordinary saves. `format=full` is used when the composer must see headers, the plain part, and attachment ids.

Google's draft guide states that the draft `id` is stable and that the message inside it cannot be edited in place. A replace destroys that message and stores a new one, so the message `id` changes. `drafts.send` deletes the draft and returns a new message with the `SENT` label. The guide also states that `drafts.send` can carry a replacement MIME message in the same request. Aurora uses that form so the sent bytes are the bytes the person is looking at, not an older autosave.

The Drafts folder list remains `threads.list` with `labelIds=DRAFT`. That list does not include a draft id. A draft id is resolved by `drafts.list`, matching `message.id`, at most 100 rows per page and at most 5 pages. If this session created the draft, the stored draft id is used and the list is not scanned.

Gmail's own attachment guidance, on the Gmail API create-draft tool reference, says the combined attachment size cannot exceed 25 MB. Aurora does not use that full budget. The upload guide recommends a simple upload for about 5 MB or less and a resumable session above that. This specification stays on one JSON `raw` body and does not start a resumable session.

## Identifiers

| Id                   | Who assigns it                                | Stored where                                        | Used for                                                        |
| -------------------- | --------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| Draft id             | Gmail, on `drafts.create`                     | Composer memory only                                | `drafts.update`, `drafts.delete`, `drafts.send`, conflict reads |
| Message id           | Gmail, new value on every replace and on send | Composer memory, replaced after each confirmed save | Conflict check, and the opened `DRAFT` message                  |
| Thread id            | Gmail                                         | Composer memory                                     | Reply drafts only. Omitted on new mail and on forward           |
| Attachment token     | Aurora, random, for this process              | Main-process map                                    | The composer refers to bytes it picked locally                  |
| Gmail `attachmentId` | Gmail, on a message part                      | Thread IPC, not SQLite                              | `messages.attachments.get`                                      |
| `partId`             | Gmail, on a message part                      | Thread IPC                                          | Find an inline part that has no `attachmentId`                  |

A draft id and a message id both use the existing Gmail id grammar: 1 to 128 characters from `[A-Za-z0-9_-]`. They are not interchangeable. A reply draft sends both the draft id and the source thread id. A forward draft sends a draft id and a null thread id. New mail does the same.

`attachmentId` does not use that 128-character grammar. Gmail attachment ids are longer. Aurora accepts 1 to 2,000 characters from `[A-Za-z0-9_-]` and rejects anything else. `partId` is 1 to 32 characters from `[0-9.]`. A missing `attachmentId` is null, not an empty string. The renderer cannot invent a path, a draft id, or a file body.

## Draft lifecycle

A composition starts without a draft id. No Gmail call is made for an untouched empty composer. The first autosave that has a recipient, a subject, a body, or an attachment calls `drafts.create`. The returned draft id and message id become the stored pair. A later autosave calls `drafts.update` with that draft id.

Autosave waits 2 seconds after the last edit. Picking, removing, or committing an address also starts that wait. A save already in flight is not overlapped. Edits during the flight mark the composer dirty again and schedule one later save. Send, delete, and discard cancel a pending timer. They wait for the flight that has already started, then proceed only if the account and the composer generation still match.

Before `drafts.update`, `drafts.delete`, and `drafts.send`, Aurora calls `drafts.get` with `format=minimal`. The returned message id must equal the stored message id. If Aurora stored a `historyId` for that draft and the remote `historyId` is also present, those values must match too. `historyId` stays in the main process and is not an IPC field. If either check fails, Aurora does not call `drafts.update`. Autosave stops. The composer stays open with the local text, the local attachment chips, and `This draft changed in Gmail. Aurora did not overwrite it.` Reload Gmail version discards the local edits and opens the remote draft. Overwrite Gmail draft is the explicit confirmation: only that action sends `replaceConfirmed: true`. Ordinary typing does not. The read and the later write are still two requests. A change that lands between them is not detected.

Create and update both send the full current MIME message and, for a reply, `threadId`. Gmail applies `DRAFT`. Aurora does not send `labelIds`. A confirmed response replaces the stored message id with the new one and refreshes the saved baseline. If the Drafts folder is the open list, no search is active, and the composer did not move to another account, Aurora reloads the first page. It does not insert a fake row.

Opening a message whose labels include `DRAFT` offers Edit draft. Main resolves the draft id, then reads `format=full`. Recipients, subject, and the plain body come from that payload. Reply and forward headers come from that payload's `In-Reply-To`, `References`, and `threadId`, not from the clipped strings in the reading view. Attachment parts are copied into the main-process map, up to the size cap, so a later replace still contains them. If those bytes cannot be loaded, the composer does not autosave.

A draft that contains `text/html`, or an image part with `Content-ID` or an inline disposition, is not edited. Aurora shows a read-only representation: the plain part when Gmail provided one, and the already sanitized reading HTML of the open message when that HTML is available. The status line says Aurora cannot edit the draft without losing its formatting. Editing, autosave, send, and delete stay disabled. The original Gmail draft is not replaced and is not deleted. HTML editing is out of scope.

Closing the composer does not delete a saved draft. If the text or the attachment set differs from the last confirmed save, Aurora still asks before discarding those unsaved edits. When a draft id exists, the copy says the unsaved changes will be lost and the saved Gmail draft will stay. Discard throws away only the edits since that save. Delete draft is a separate control, and it is absent while the draft is locked.

Delete asks `Delete this draft?` and `Gmail will permanently delete this draft. This is not Trash.` Keep is focused. Delete is `.control-danger`. Escape keeps the draft. A confirmed `drafts.delete` closes the composer and drops its memory. HTTP 404 on delete means the draft is already gone and is treated as deleted. HTTP 404 on update or send is not treated as permission to create and send a second copy by itself.

Send, when a draft id exists, is `POST /drafts/send` with that id and the current `raw`, plus `threadId` only for a reply. Gmail deletes the draft as part of a confirmed send. Send, when no draft exists, stays `POST /messages/send` as in SPEC-001.6. Aurora does not call both. The send button stays disabled while the account's send lock is held. Autosave does not run during send.

After restart, recovery is opening Drafts or the conversation that holds the draft. Aurora does not restore an unsaved composer from disk. Keystrokes after the last confirmed save are gone. Files that were picked and not yet included in a confirmed save are gone. Files that Gmail stored come back through `drafts.get`.

Account switching does not move a draft and does not change `From`. A dirty composer, or a composer that already has a draft id, asks before the account changes. The in-memory files of the discarded composer are dropped. A late save or send whose generation or account no longer matches does not update the new composer.

A create, update, or send that throws, times out, or returns HTTP 429, 500, or 503 does not retry. Create and update use `save-unconfirmed`: `Aurora could not confirm whether Gmail saved this draft. Check Drafts before saving it again.` Autosave stays paused, including after further typing, because Gmail may already have stored the draft. Aurora does not create a replacement draft from that composer. Send uses the existing `send-unconfirmed` sentence and the existing Check Sent action, and it also pauses autosave because the draft may already have been sent and deleted.

Closing the window can warn through `beforeunload` while the composer is dirty. `will-quit` still only closes the database. It does not flush a dirty composer and it does not wait for an upload. A crash or a forced quit still loses unsaved keystrokes and attachment bytes that were not part of a confirmed Gmail save. The last draft Gmail confirmed, including the attachments in that save, remains in Gmail.

## Attachments

### Outgoing

The renderer asks main to pick files. Main calls `dialog.showOpenDialog` on the Aurora window with `openFile` and `multiSelections`. The renderer does not send a path. Main `stat`s each chosen file, rejects a directory, a size above the cap, or a total above the cap, and only then reads the bytes. The read length must still match. The stored record is `{ token, fileName, mediaType, bytes }` in memory. The token is 32 characters from `[A-Za-z0-9]`. The IPC result is `{ token, fileName, mediaType, size }` and does not include bytes or a path.

The displayed name drops CR, LF, NUL, and `/` or `\`, and is capped at 200 characters. An empty result becomes `Attachment`. The media type comes from a small extension map in main. Anything else is `application/octet-stream`. The renderer-supplied type is ignored. At most 10 files are kept. A later pick that would pass 10 or the byte cap is `too-large` and adds nothing.

Remove drops that token's bytes. A token from another account or another composer generation is `invalid-request`.

Picked bytes are the bytes at pick time. A later edit of the same disk file is not noticed. The person removes and picks the file again to refresh it.

### Incoming

The thread payload gains `partId` and `attachmentId` on each listed attachment. `fileName`, `mimeType`, and `size` stay. Bytes stay out of that payload. The list rule is unchanged: a filename or `Content-Disposition: attachment` lists the part, including a nested part inside `multipart/mixed` or `multipart/related`, up to depth 8. A `multipart/alternative` body is still the reading body, not an attachment. An inline image without a filename stays omitted and is not downloaded. The existing image sentence stays.

Download asks `dialog.showSaveDialog` with the sanitized file name as the default. Cancel does nothing. Main checks that the attachment id or part id still belongs to that message on that account by reading the message, then writes the bytes. A part with `attachmentId` uses `messages.attachments.get`. A part with only inline `data` uses that data from the fresh `format=full` read. The decoded size must be the metadata size when that size is non-zero, and must be at most 5 MiB. A larger declared size does not start the transfer.

The write goes to a new file in the OS temp directory, under a name Aurora generates, then moves to the exact path the save dialog returned. The move target is that path after `path.resolve`. Aurora does not append a second path segment from message data. A failure deletes the temp file and does not leave a partial file at the destination. Success does not call `shell.openPath`.

A read-only account may download. The button is absent only when the row has neither a usable `attachmentId` nor a `partId`.

### Limits

5 MiB is 5 × 1024 × 1024 bytes of original file content, summed across every outgoing attachment and applied to each incoming download. The plain body remains 262,144 UTF-8 bytes. A finished RFC 5322 message whose base64url `raw` string exceeds 12,582,912 bytes is `too-large` and is not sent or saved. That ceiling covers a 5 MiB payload after base64 wrapping without approaching a 25 MB Gmail message. Files over 5 MiB are refused with `This file is too large for Aurora to attach.` The conversation-too-large sentence is not reused for a file.

## MIME

No attachments: the SPEC-001.6 `text/plain` message, unchanged.

With attachments, the outer headers are the same `MIME-Version`, `Date`, `From`, `To`, `Cc`, `Bcc`, `Subject`, and the reply headers. The outer `Content-Type` is `multipart/mixed; boundary=` plus a boundary of 24 characters from `[A-Za-z0-9]`. If that token occurs in the body or in a file name, Aurora draws another. The first part is `text/plain; charset=UTF-8` with base64 content, wrapped at 76 characters. Each file is a following part:

- `Content-Type` is the mapped media type, with a quoted ASCII `name` when the name is printable ASCII.
- `Content-Disposition: attachment`, with a quoted ASCII `filename` when the name is printable ASCII.
- A name that is not printable ASCII uses RFC 2231 `filename*=UTF-8''` percent-encoding and does not put raw UTF-8 on the header line.
- `Content-Transfer-Encoding: base64`, wrapped at 76 characters.
- No `Content-ID`. No `inline` disposition. No HTML part.

CR, LF, and NUL in a name or any other header value are rejected before a line is written. The boundary line is `--` plus the token, and the end is the same plus `--`. Parts are separated by CRLF. This is still one encoder in this repository. A MIME library is not added.

Reply and forward quotations stay plain text in the first part, as in SPEC-001.6. Attachments the person removed are not copied into the new message. Attachments they kept, including files that came from the open draft, are.

## IPC

Each channel checks the authorized sender, requires one object with the exact keys below, and rejects an extra field as `invalid-request` before Gmail is called. An extra field on a success payload is `invalid-response`. Tokens, refresh tokens, `historyId`, paths, and file bytes are not IPC fields. `raw` is not an IPC field.

| Channel                     | Request keys                                                                                                                                                                     | Success value                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `gmail:draft-save`          | `accountId`, `draftId`, `expectedMessageId`, `kind`, `threadId`, `messageId`, `to`, `cc`, `bcc`, `subject`, `body`, `attachmentTokens`, `replaceConfirmed`, `composerGeneration` | `{ draftId, messageId, threadId }`                                                                       |
| `gmail:draft-open`          | `accountId`, `threadId`, `messageId`, `composerGeneration`                                                                                                                       | `{ locked, draftId, messageId, threadId, kind, to, cc, bcc, subject, body, subjectLocked, attachments }` |
| `gmail:draft-delete`        | `accountId`, `draftId`, `expectedMessageId`                                                                                                                                      | `{ deleted: true }`                                                                                      |
| `gmail:draft-send`          | The save keys                                                                                                                                                                    | `{ id, threadId }`                                                                                       |
| `gmail:attachment-pick`     | `accountId`, `composerGeneration`                                                                                                                                                | `{ attachments }`                                                                                        |
| `gmail:attachment-drop`     | `accountId`, `composerGeneration`, `token`                                                                                                                                       | `{ dropped: true }`                                                                                      |
| `gmail:attachment-download` | `accountId`, `messageId`, `partId`, `attachmentId`                                                                                                                               | `{ saved }`                                                                                              |

`draftId` and `expectedMessageId` are null on the first save. `kind` is `new`, `reply`, `reply-all`, or `forward`. Reply kinds require Gmail ids for `threadId` and `messageId`. New and forward require both to be null. Recipient, subject, and body rules stay the rules in SPEC-001.6, except a draft save may have zero recipients. Send still requires one.

`replaceConfirmed` is false for autosave. Main will not overwrite a conflicting remote draft unless it is true. `attachmentTokens` are tokens from `gmail:attachment-pick` or from `gmail:draft-open` for files loaded from that draft. Unknown tokens, and tokens from another account or composer generation, are `invalid-request`. `{ saved: false }` means the save dialog was cancelled. A confirmed download is `{ saved: true }`.

`gmail:attachment-download` takes a null `attachmentId` only when `partId` is present. Main re-reads the message and refuses an id that is not on that message. The save dialog runs in main. There is no path argument.

`gmail:send-message` remains for a composition that has no draft id and no new attachment work beyond what SPEC-001.6 already sends. A composition that has a draft id uses `gmail:draft-send` only.

## UI

The mail sidebar, list, and conversation layout stay as specified in SPEC-001.4 and SPEC-001.5. The composer stays the 560px dialog.

The composer gains a status line, `role="status"`, with one of: `Saving…`, `Saved`, `Not saved`, the unconfirmed-save sentence, or the conflict sentence. It gains Attach, using the existing `Paperclip` icon, and a chip row. Each chip shows the file name and a size in bytes, and a Remove control with an accessible name that includes the file name. Send stays the primary control and is hidden while the draft is locked. Delete draft is shown only after a draft id exists and the draft is editable. Its confirm dialog uses `.control-danger`. A conflict shows Reload Gmail version and Overwrite Gmail draft. Check Drafts opens the Drafts folder without closing the composer.

Edit draft is on a message whose `labelIds` include `DRAFT`, beside the existing star. Reply, Reply all, and Forward stay. Choosing one while a dirty composer is open still asks before replacing it.

Received attachment rows gain Download. The row text stays file name, media type, and size. During a download the button is `aria-busy` and disabled. Failure uses `role="alert"` and the fixed sentence for the error code. Success is `Saved.` The file is not opened.

Dialogs keep `role="dialog"` and `aria-modal`. Focus starts on the safe action: Keep editing, Keep, or Cancel. Escape is the safe action. Tab stays inside the open dialog. The Folders toggle and the 188px sidebar are unchanged.

A read-only account still sees Download. Attach, Edit draft, autosave, and Send do not run, and the reconnect sentence stays.

## Security

Context isolation, the sandbox, and disabled Node integration stay on. IPC sender checks stay in front of every new channel. The renderer cannot pass a URL, a method, a header block, `raw`, a filesystem path, or file bytes. `From` still comes from the connected account. One account's token is never used with another account's draft id, message id, or attachment token. The in-memory map is keyed by account id and composer generation.

Header injection is rejected by the same CR, LF, and NUL checks as SPEC-001.6, including file names. The boundary cannot introduce a new header. A locked draft may show the reading HTML that the existing sanitizer already produced for that open message. Aurora does not write that HTML back to Gmail. The outgoing body remains plain text. The reading sanitizer is unchanged.

Download verifies the part against a fresh Gmail read before writing. The destination is the save-dialog path only. Temp files are created with a generated name and removed on failure. Aurora does not spawn the file, does not use `shell.openPath`, and does not follow a `file:` link from message HTML.

A draft save or send requires `canModifyMail` before any Gmail call. A 403 with `insufficientPermissions` or `ACCESS_TOKEN_SCOPE_INSUFFICIENT` stays `insufficient-scope` and does not delete the refresh token.

## Failure handling

| Outcome                                               | Code                                     | Retry | Composer                                                           |
| ----------------------------------------------------- | ---------------------------------------- | ----- | ------------------------------------------------------------------ |
| Create has no response, HTTP 429, 500, or 503         | `save-unconfirmed`                       | No    | Text kept, autosave stopped, no second create                      |
| Update or send has no response, HTTP 429, 500, or 503 | `save-unconfirmed` or `send-unconfirmed` | No    | Text kept, autosave paused                                         |
| Update sees a different message id or `historyId`     | `draft-conflict`                         | No    | Text kept, autosave stopped, no overwrite                          |
| HTTP 401 with a response                              | Existing refresh, one retry of that call | Once  | Unchanged if the retry fails                                       |
| HTTP 400                                              | `gmail-rejected`                         | No    | Text kept                                                          |
| HTTP 404 on delete                                    | Success, already gone                    | No    | Composer closes                                                    |
| HTTP 404 on update or send                            | `not-found`                              | No    | Text kept, no automatic new draft and no automatic `messages.send` |
| File or message over the cap                          | `too-large`                              | No    | Nothing added and nothing sent                                     |
| Download write fails                                  | `unavailable`                            | No    | Temp file removed                                                  |
| Readonly grant on a write                             | `insufficient-scope`                     | No    | Saving composer does not open                                      |

A definite send failure still says `Aurora could not send this message.` An unconfirmed send still does not say the message was not sent, and Check Sent still opens Sent without closing the composer. An unconfirmed save does not say the draft was not saved.

Delete is not sent twice by a double click. The confirm button disables while the delete is in flight. Send stays behind the existing per-account send lock, which now also covers `drafts.send`.

## Tests

Automated tests use an injected `fetch` and do not use Google credentials or the real file dialogs. Dialogs are injected.

- `drafts.create` is one POST with `raw` and no `labelIds`. A second edit is `PUT` with the same draft id. The stored message id becomes the id from the response.
- The autosave timer does not call Gmail on each keystroke. One call follows 2 seconds of quiet. A save in flight is not joined by a second call.
- Opening a `DRAFT` message resolves the draft id from `drafts.list` by message id and fills the composer from `format=full`.
- A `format=minimal` message id that differs from the stored id does not call `PUT`. A different `historyId`, when both sides have one, does not call `PUT` either. `replaceConfirmed` does.
- A `text/html` draft is opened as locked. Aurora does not `PUT` or send it. An inline image part is treated the same way.
- A late save for a previous generation or a previous account does not change the current composer. Changing account asks first and does not rewrite `From`.
- `DELETE` runs only after the confirmed action. A 404 delete is success. The delete sentence is the permanent-delete copy.
- `drafts.send` includes the draft id and the current `raw`. It does not also call `messages/send`. A reply includes `threadId`. A forward does not.
- A message with no files remains one `text/plain` part. A message with two files is `multipart/mixed`, UTF-8 plain text first, then both files as base64. A non-ASCII file name is RFC 2231 and does not add a header line.
- A file name containing CR or LF does not produce an extra header. An unknown token, a token from another account, more than 10 files, a file over 5 MiB, and a total over 5 MiB do not call Gmail.
- Download rejects an attachment id that the fresh message does not contain, rejects a `partId` that escapes the grammar, and rejects a declared size over 5 MiB before `fetch` of the bytes. The written path is the dialog path. A path with a traversal segment is not a second destination. The temp file is removed when the write fails. No test opens the file.
- HTTP 500 on create, update, and `drafts.send` is not retried. An unconfirmed create does not schedule another create.
- Readonly `modificationGrant` refuses save and send before `fetch` and still allows the download call. `gmail.compose` is absent from the authorization URL. `include_granted_scopes` stays absent. Schema version stays 2.
- Existing reader, action, and SPEC-001.6 send tests still pass, including the single-part MIME message, the send lock, and `send-unconfirmed`.

## Verification

Checked on 8 November 2026. `pnpm lint`, `pnpm format:check`, and `pnpm typecheck` passed. Node tests: 201 passed, 40 suites. Vitest: 28 passed, 8 files. Coverage, with the draft, attachment, and MIME modules included: lines 93.71, branches 80.65, functions 91.74. Thresholds stay at 90, 80, and 90. Build: main 584.15 kB, preload 30.05 kB, CSS 28.81 kB, JS 388.54 kB. `pnpm check:build` passed. Package used `electron-builder` 26.17.0 with `--win --x64 --publish never`. Signing was skipped. Installer 110232976 bytes. Unpacked 386268779 bytes. `pnpm check:package` passed. Manual acceptance is the project owner's approval of this specification.

## Manual acceptance

The project owner accepted SPEC-001.7 on 8 November 2026. The scenarios below were not recorded one by one.

- A new plain-text draft appears in Aurora Drafts and in Gmail web. Restarting Aurora and opening that draft shows the same recipients, subject, and body.
- Editing in Aurora updates the same Gmail draft. The draft id stays. Sending removes it from Drafts and delivers the message.
- A reply draft stays in the source conversation. A forward draft is a new conversation. An attachment is present on the received copy.
- Changing the same draft in Gmail web, then typing in Aurora, does not overwrite the web edit until the person confirms.
- Delete asks, then removes the draft from Gmail. It does not appear in Trash.
- A second account does not see the first account's draft or attachment tokens.
- A received file can be saved through the system dialog. Aurora does not open it. A remote image in the message is still not requested.
- A file over 5 MiB is refused. A read-only account can download and cannot save a draft until reconnect.

## Stages

1. Extend the encoder with `multipart/mixed`, file-name encoding, and the size tests. Do not call Gmail.
2. Keep `partId` and `attachmentId` on the decoded attachment. Add the download channel, the save dialog, and the temp-file tests.
3. Add `PUT` and `DELETE` to the Gmail client. Add draft save, open, conflict, and delete, with injected `fetch`.
4. Add the composer status, chips, Attach, Edit draft, and Delete draft. Autosave uses the 2 second wait. Send uses `drafts.send` when a draft id exists.
5. Run lint, format:check, typecheck, tests, coverage, build, and packaging. Manual acceptance uses the list above.

## Risks

Gmail replaces the entire draft on update. A save that Aurora believes is a text edit also rewrites attachments. If the bytes were not loaded, the save would strip them. The open path blocks autosave until those bytes are in memory or the person has removed them. A draft larger than 5 MiB cannot be edited here without refusing the load.

A Gmail web draft is often HTML. Aurora does not convert it. The draft stays read-only, and the Gmail copy is left unchanged. There is no HTML editor in this specification.

The conflict check is one `format=minimal` read immediately before update, delete, or send. It compares the message id and, when both sides have one, `historyId`. `drafts.update` has no general transactional compare-and-swap. Two clients can still pass that read and both write. The later write wins. Aurora does not merge, and it does not claim that simultaneous updates are prevented. A create whose response is lost is `save-unconfirmed` and is not retried. Updates and sends are not retried either.

`drafts.send` with a replacement body both stores and sends. A lost response can mean the message was sent and the draft deleted, or that neither happened. `send-unconfirmed` is the honest result. Retrying would risk a second send. The person checks Sent. Autosave stays off so a confused client does not create a duplicate draft by habit.

A lost `drafts.create` response is the same kind of ambiguity. Gmail may have stored the draft. Aurora reports `save-unconfirmed` and does not schedule another create.

`drafts.list` has no lookup by message id. Save, update, delete, and send use the draft id directly. Opening a draft whose id this session already stored also uses `drafts.get` directly. Listing remains only for a Drafts message whose draft id is not in this process. That scan is at most five pages of 100. A mailbox with more than 500 drafts ahead of an older one can fail to resolve it. The composer then says Aurora could not find the draft. It does not guess an id.

The 10 second timeout is short for a 5 MiB upload on a slow link. A slow accept becomes `save-unconfirmed` or `send-unconfirmed` even when Gmail later stores the message. Raising the timeout only for these calls would change the failure window and needs the approval below.

Delete is permanent. A mistaken confirmation cannot be restored from Trash.

The 5 MiB cap is below the 25 MB limit Gmail documents. People who need a larger file cannot send it with Aurora under this specification.

## Approval

These decisions are accepted, with the refinements in the draft lifecycle and the risks above.

1. `gmail.modify` remains the only Gmail scope. `gmail.compose` is not added. Schema version stays 2. Read-only accounts may download attachments. They cannot save or send until the existing reconnect.
2. Gmail is the only persistent copy. SQLite does not gain a body, a draft id, or a file. Unsaved text and picked bytes exist only in memory and can be lost on a crash.
3. The stable id is the draft id. The message id changes on every replace. Conflict detection also uses `historyId` when both sides have one. A mismatch stops autosave until the person reloads Gmail or chooses Overwrite Gmail draft. That check is not a transaction.
4. Autosave waits 2 seconds. Closing the composer does not delete a saved draft. Delete is a separate confirmed action, and Gmail deletes that draft permanently.
5. Send of a saved draft is one `drafts.send` with the current MIME. Ambiguous HTTP 429, 500, 503, and lost responses are not retried. They stay unconfirmed. Aurora does not recreate the draft after an ambiguous send.
6. Attachments are `multipart/mixed` from the existing encoder. No MIME library. No HTML part. An HTML or inline draft stays read-only and is not converted to plain text.
7. Each message is limited to 10 files and 5 MiB of file bytes, not Gmail's 25 MB. Resumable upload is not added. The Gmail JSON client gains `PUT` and `DELETE` only.
8. The renderer never passes a path or file bytes. Main owns both dialogs, reads picked files, and writes downloads only to the save-dialog path. Downloaded files are not opened.
