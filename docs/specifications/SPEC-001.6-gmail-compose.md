# SPEC-001.6 — Gmail Compose

## Status

Completed on 8 November 2026. Automated verification passed. The project owner approved manual acceptance of this specification. That approval does not record a separate result for each named scenario below. The authorization request still uses `https://www.googleapis.com/auth/gmail.modify`. `gmail.send` and `gmail.compose` are not added. SQLite schema version remains 2. Parent specifications: [SPEC-001.2-gmail-oauth.md](SPEC-001.2-gmail-oauth.md), [SPEC-001.3-gmail-reader.md](SPEC-001.3-gmail-reader.md), [SPEC-001.4-gmail-actions.md](SPEC-001.4-gmail-actions.md), and [SPEC-001.5-aurora-visual-system.md](SPEC-001.5-aurora-visual-system.md).

## Goal

Let a person write and send a new Gmail message, reply to a message, reply to all recipients of a message, and forward a message. Gmail remains the mailbox of record. Aurora sends only when the person uses Send.

## Non-goals

Persistent Gmail drafts are out of scope. `drafts.create`, `drafts.update`, `drafts.send`, and `drafts.delete` are not called. File attachments, inline images, and multipart bodies are out of scope. Rich-text and HTML editing are out of scope. Signatures, scheduled send, Undo Send, bulk send, automatic replies, AI-written mail, contact autocomplete, and a background sending queue are out of scope. Send-as aliases, the People API, and the Gmail settings API are out of scope. Unicode mailbox addresses are out of scope. No new dependency and no schema migration. Electron sandbox, context isolation, disabled Node integration, web security, the navigation block, denied `window.open`, and both content security policies stay as they are.

## Current code this design relies on

Verified in this repository, not assumed from an earlier report.

- `schemaVersion` is 2. `connected_accounts.granted_scopes` stores the scope string. A version 1 database gains that column with the historical grant `openid email profile https://www.googleapis.com/auth/gmail.readonly`. A fresh database does not insert that default.
- `googleScopes` is `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/gmail.modify`. The authorization URL does not set `include_granted_scopes`. `prompt` is `consent select_account`.
- `grantAllowsMailChanges` is true only when those four scopes are present. The account summary exposes that as `canModifyMail`. It does not expose the raw scope or any token.
- A successful connect or reconnect calls `forgetAccess` for that account. Cancel, `access_denied`, and `scope-denied` keep the previous refresh token and the previous `granted_scopes`.
- Gmail calls use `https://gmail.googleapis.com/gmail/v1/users/me/` from the Electron main process. The renderer cannot pass a URL, a method, or a raw JSON body. Access tokens stay in a main-process map.
- `users.threads.get` for an open conversation is a full get. `decodeConversation` keeps `From`, `To`, `Cc`, `Bcc`, `Subject`, and `Date`, each clipped, plus the plain text and sanitized HTML. It does not keep `Message-ID`, `References`, or `Reply-To`.
- List metadata headers are only `From`, `To`, `Cc`, `Bcc`, `Subject`, and `Date`.
- The shared JSON request path retries once on HTTP 429, 500, or 503. Its timeout is 10 seconds. A thrown `fetch` becomes `network`. HTTP 401 refreshes the access token and retries the same request once.
- Mutations take the mailbox lease and a per-account, per-thread lock. `modificationGrant` returns `ready`, `readonly`, or `needs-reauth` before the HTTP call. A mutating 403 with `insufficientPermissions` or `ACCESS_TOKEN_SCOPE_INSUFFICIENT` is `insufficient-scope`. That result does not delete the refresh token and does not mark `needs_reauth`.
- The mail screen has a list toolbar, a 188px folder sidebar, a two-line row, and a conversation with a 48px header and a 40px action row. Trash uses `role="dialog"`. Controls use `.control` and fields use `.field`, including `:focus-visible`. This specification adds the composer on that layout.
- The production content security policy keeps `form-action 'none'`, `img-src 'self' data:`, and `connect-src 'self'`.

## Decisions

- Send with the existing `gmail.modify` grant. Do not add `gmail.send`, `gmail.compose`, or `https://mail.google.com/`. Do not set `include_granted_scopes`. Schema version stays 2.
- One composer holds unsent text in renderer memory. Aurora does not write that text to SQLite or to Gmail.
- The renderer sends kind, account id, thread id, message id, recipient addresses, subject, and a plain-text body. Main builds the MIME message, the `From` header, and any threading headers.
- Reply and Reply all keep the Gmail thread only when main can read a usable `Message-ID` and can set `threadId`, `In-Reply-To`, `References`, and a subject derived from the source. Forward starts a new thread.
- `messages.send` is not retried for quota or server errors. A lost response is not reported as "not sent".
- No MIME library is added. A tested encoder in this repository builds the one `text/plain` message.

## OAuth and permissions

Official scope text, checked for this specification:

| Scope                                           | Google's description                                                                                             | `users.messages.send` |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| `https://www.googleapis.com/auth/gmail.send`    | Send email on your behalf. Sensitive.                                                                            | Accepted              |
| `https://www.googleapis.com/auth/gmail.compose` | Manage drafts and send emails. Restricted.                                                                       | Accepted              |
| `https://www.googleapis.com/auth/gmail.modify`  | Read, compose, and send emails from your Gmail account. Does not allow immediate permanent deletion. Restricted. | Accepted              |
| `https://mail.google.com/`                      | Read, compose, send, and permanently delete all email. Restricted.                                               | Accepted              |

`users.messages.send` lists those four scopes. Aurora already requests `gmail.modify` for SPEC-001.4. That scope is sufficient for send, and it is the scope that also allows the reader and the mailbox actions. `gmail.send` cannot replace it: a token with only `gmail.send` cannot read mail. Requesting `gmail.send` beside `gmail.modify` would show another permission and would not add a send capability the modify grant lacks. `gmail.compose` exists to manage drafts, which this specification does not do. `https://mail.google.com/` is wider because it includes permanent deletion.

The consent sentence for `gmail.modify` already says read, compose, and send. Accounts that reconnected for SPEC-001.4 already hold a grant that Google describes as including send. This specification does not widen that sentence and does not start a new consent by itself.

An account still on the historical read-only grant can read. `canModifyMail` is false. Compose, Reply, Reply all, and Forward do not open the composer and do not call Gmail. The existing reconnect sentence and Integrations link stay. Reconnect is the SPEC-001.2 flow, which already asks for `gmail.modify`. Cancel during that reconnect leaves the previous refresh token and the previous `granted_scopes` in place. A successful reconnect still replaces `granted_scopes` and still drops that account's cached access token.

A refresh that omits `scope` still leaves the stored grant unchanged. A refresh that returns a valid scope string still replaces the stored grant. If `gmail.modify` disappears, `canModifyMail` becomes false and send is refused before HTTP. A later mutating or sending 403 with `insufficientPermissions` or `ACCESS_TOKEN_SCOPE_INSUFFICIENT` remains `insufficient-scope`. The refresh token stays. The account does not become `needs_reauth`.

`include_granted_scopes` stays absent. Incremental authorization is not used, because no scope is added. Adding it would change every future consent and is not required to send.

No access-token cache drop is added on send. The cache is still dropped after a successful reconnect, which is what makes a new modify grant replace a cached read-only token.

## Gmail API

`userId` is always `me`. The renderer cannot choose the mailbox address.

| Call                          | Method                               | Units | When                                                        |
| ----------------------------- | ------------------------------------ | ----- | ----------------------------------------------------------- |
| Load reply or forward headers | `GET /messages/{id}?format=metadata` | 20    | Reply, Reply all, and the subject check before a reply send |
| Send                          | `POST /messages/send`                | 100   | Send                                                        |

The metadata get asks only for `From`, `To`, `Cc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, and `References`. It does not use `format=full`, `raw`, or `html` (those cost 60). The official per-user limit remains 6,000 units per minute, and the per-project limit remains 1,200,000. One reply is 120 units. Google's own recipient cap is 500 addresses per message. Aurora's cap is lower and is stated below.

The send body is a Message resource with exactly `raw`, plus `threadId` only for Reply and Reply all. Aurora does not send `labelIds`, `classificationLabelValues`, or an upload URI. The metadata URI is `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send` with `Content-Type: application/json`.

`raw` is the RFC 5322 message encoded as UTF-8 bytes, then as base64url with no padding and no line breaks inside the JSON string. Gmail documents this field as an RFC 2822 message in base64url. Aurora uses CRLF line endings, which satisfies both the RFC 5322 wire format and that requirement.

A successful send returns a Message. Aurora reads `id` and, when present, `threadId`. Both must match the existing Gmail id grammar when present. Aurora ignores `historyId`, `snippet`, `payload`, `raw`, `labelIds`, and `sizeEstimate`. A `200` with a valid `id` is success even when `threadId` is absent. A `200` without a valid `id` is `send-unconfirmed`.

Official thread rules, from the Gmail threads guide: a message joins a thread only when the request includes that `threadId`, `In-Reply-To` and `References` comply with RFC 2822, and the subject matches. Aurora treats a reply as threaded only when it can meet those three rules. It does not promise threading for a subject the person typed.

## MIME message

Aurora generates these headers and no others:

| Header                      | New and Forward                                              | Reply and Reply all                                    |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| `MIME-Version`              | `1.0`                                                        | `1.0`                                                  |
| `Date`                      | Current UTC time in RFC 5322 form                            | Same                                                   |
| `From`                      | Account display name, when it has one, and the account email | Same                                                   |
| `To`                        | Addresses the person kept in To                              | Same                                                   |
| `Cc`                        | Addresses the person kept in Cc, omitted when empty          | Same                                                   |
| `Bcc`                       | Addresses the person kept in Bcc, omitted when empty         | Same                                                   |
| `Subject`                   | The edited subject, which may be empty                       | The derived reply subject                              |
| `In-Reply-To`               | Absent                                                       | The source `Message-ID`                                |
| `References`                | Absent                                                       | The trimmed source `References` plus that `Message-ID` |
| `Content-Type`              | `text/plain; charset=UTF-8`                                  | Same                                                   |
| `Content-Transfer-Encoding` | `base64`                                                     | Same                                                   |

Gmail, not Aurora, assigns the outgoing `Message-ID`, applies `SENT`, delivers to `Bcc`, and removes `Bcc` from the copies other people receive. Aurora does not set `Reply-To`, `Sender`, `Resent-*`, `Comments`, or `Keywords`.

The body is one part. It is not `multipart/alternative` and it contains no HTML. The base64 body is wrapped at 76 characters. A blank line separates the headers from the body. The encoder rejects a header value that contains CR, LF, or NUL before it writes any line. Display names and subjects that are not ASCII printable use one RFC 2047 encoded-word, `=?UTF-8?B?...?=`, and never raw UTF-8 in a header. Addresses stay ASCII.

`From` is the stored account email. The display name is the stored account display name when it is non-empty, at most 200 characters, and free of CR, LF, and NUL. Otherwise `From` is the bare address. The renderer cannot supply `From`. If the account has no email, send is `invalid-request` and does not call Gmail.

Recipient addresses are bare addr-specs. A display name is not accepted on `To`, `Cc`, or `Bcc` in this specification. Internationalized display names are the `From` display name and the plain-text quotation, not the recipient headers. An address is at most 254 characters and matches a dot-atom local part, `@`, and a dot-atom domain of at least two labels. Quoted local parts, address comments, source routes, IP literals, and non-ASCII mailbox text are `invalid-request`. Comparison for duplicates and for "myself" is ASCII case-folding of the whole address. Dots in a `gmail.com` local part are not collapsed.

At least one address is required across To, Cc, and Bcc. Each field holds at most 50 addresses, and the three fields together hold at most 50. The same address is kept once, with To winning over Cc and Cc winning over Bcc. The subject is at most 998 characters. The body is at most 262,144 UTF-8 bytes. The finished raw message is at most 1,048,576 bytes. A larger value is `too-large` and is not sent. The body may be empty. Tab and line breaks are allowed. Other C0 controls and DEL are rejected. Aurora normalizes CRLF and CR to LF, then writes CRLF.

## Recipients and threading

Compose seed is `GET` metadata for one message the person already opened. The renderer does not parse RFC headers. Clipped `from`, `to`, and `cc` strings on the read model are display text and are not a safe address list.

Reply target: the parsed `Reply-To` addresses when that header has at least one valid address. Otherwise the parsed `From` addresses. Invalid tokens in those headers are dropped. If none remain, the seed returns an empty To and the composer opens for the person to type an address.

Reply:

- To is the reply target.
- If every reply-target address is the account address, and the source `To` has another valid address, To becomes the source `To` instead. This is a reply to mail the account sent.
- Cc and Bcc are empty.

Reply all:

- To starts as the reply target.
- The account address is removed from To when at least one other address remains.
- Cc is the source `To` plus the source `Cc`, minus any address already in To, minus the account address.
- Bcc is empty. A source `Bcc` is never copied.

Forward:

- To, Cc, and Bcc start empty.
- No `threadId`, `In-Reply-To`, or `References` is sent.
- The subject starts as `Fwd:` plus the source subject, with one existing `Fwd:` or `Fw:` prefix removed first. The person may edit it.

Reply subject, read-only in the composer: strip one or more leading `Re:`, `Fw:`, or `Fwd:` prefixes, then prefix a single `Re:`. An empty source subject becomes `Re:`. Main computes this subject again at send time. The IPC subject must equal it. A different subject is `invalid-request` and is not sent. The field is read-only so the screen and the message cannot disagree.

`In-Reply-To` is the source `Message-ID` in angle brackets. `References` is the list of angle-addr tokens already in the source `References`, then that `Message-ID` if it is not already last. Aurora keeps at most 10 ids: the first id, then the newest ids that fit. A usable `Message-ID` is `<`, 1 to 200 characters from the addr-spec alphabet plus `@` and `.`, then `>`. If Reply or Reply all cannot find one, or the metadata `threadId` differs from the thread the person has open, Aurora does not send and does not invent an id. The composer shows that the reply could not be attached to the conversation.

The send request sets `threadId` only for Reply and Reply all, and only to the open thread id. After success, Aurora refreshes that open conversation when the returned `threadId` is absent or equal to the open thread. When Gmail returns a different `threadId`, the send still succeeded. Aurora says the message was sent and does not claim it joined the open conversation.

## Quotation

The initial body is built in the renderer from the message already on screen. It is plain text, visible, and editable. Main does not append a hidden quotation.

Reply and Reply all start with a blank line, `On {date}, {from} wrote:`, and the plain-text body prefixed with `> `. Forward starts with a blank line, `---------- Forwarded message ---------`, then `From`, `Date`, `Subject`, and `To`, then the plain text. The date and the addresses in that block are the display strings already shown. They are body text, not headers.

When the open message has no plain text, the quotation says `The original message had no plain-text body.` It does not copy HTML into the outgoing message. Remote images stay omitted. The quotation is shortened so the initial body fits in the body limit, and the shortened text ends with `[Quoted text was shortened.]`. The person can delete the quotation before sending.

## Process boundaries

Main owns the Gmail URL, the bearer token, MIME construction, recipient validation, the metadata read used for threading, and the mailbox lease. Preload exposes `composeSeed` and `sendMessage` and no `fetch`. The renderer does not send header blocks, MIME, or base64.

A compose seed and a send each take the mailbox lease, so disconnect and reconnect wait until the call finishes. The lease is not a send queue.

The renderer applies a send result only when the account id and the composer generation captured at Send are still current. Main still sends with the account id from that request. Switching accounts does not retarget the call.

## IPC

New code: `send-unconfirmed`, sentence `Aurora could not confirm whether Gmail sent this message. Check Sent before sending it again.`

Existing codes stay. The composer uses its own sentences for a definite send failure and does not reuse `Aurora could not read this mailbox.`

| Channel              | Argument                                                               | Success               |
| -------------------- | ---------------------------------------------------------------------- | --------------------- |
| `gmail:compose-seed` | `{ accountId, threadId, messageId, kind }`                             | `{ to, cc, subject }` |
| `gmail:send-message` | `{ accountId, kind, threadId, messageId, to, cc, bcc, subject, body }` | `{ id, threadId }`    |

`kind` is `reply`, `reply-all`, or `forward` for the seed. For send it is `new`, `reply`, `reply-all`, or `forward`. `to`, `cc`, and `bcc` are arrays of address strings. `subject` and `body` are strings. `threadId` and `messageId` are Gmail ids for reply and reply-all, and both are `null` for new and forward. The seed's `to` and `cc` are the addresses Aurora chose. Exact keys only. An extra field is `invalid-response`. Ids use the SPEC-001.3 grammar. `accountId` must be an Aurora Google account UUID in `connected` state.

`gmail:send-message` success `threadId` is `string | null`. It is null when Gmail omits it.

## UI

The visual system is SPEC-001.5. No new component framework. Icons are Lucide at 16px and stroke 1.75: `SquarePen` for Compose, `Reply`, `ReplyAll`, `Forward`, and `Send`. Decorative icons are `aria-hidden`. The composer uses `.control`, `.field`, `.field-text`, and the existing focus ring.

The list toolbar gains a Compose button with the visible label `Compose`. The conversation header shows the same button while a conversation is open. Each open message, beside its star, gains Reply, Reply all, and Forward, each with that visible accessible name. Those four actions do nothing except show the existing reconnect sentence when `canModifyMail` is not true.

One dialog, `role="dialog"` and `aria-modal="true"`, sits in the mail stage above the folder overlay. Its title is `New message`, `Reply`, `Reply all`, or `Forward`. On a wide mail stage it is 560px wide. When the mail stage is narrow it uses the stage width, with the same stacked fields and an internal scroll. It does not scroll the mailbox page and does not add a horizontal folder row.

The dialog shows:

- `From` as text, the selected account email. It is not an editable address and it is not a second account picker.
- To. Cc and Bcc are hidden until their buttons are used, unless the seed included Cc.
- Subject. It is an input for New and Forward, and read-only text for Reply and Reply all.
- A plain `textarea`. Enter inserts a line break. Ctrl+Enter or Cmd+Enter sends. The textarea is not `contenteditable` and does not render HTML.
- `Send`, with the icon and the visible label `Send`.

Focus moves to To for a new message or a forward, and to the textarea for a reply. Tab order is the fields, Send, then Close. Focus stays inside the dialog until it closes. Escape asks to close.

Address fields accept one address or a paste split on comma, semicolon, or newline. Enter commits the address currently typed. An invalid address stays in the field and Send reports `Enter a valid email address.` An empty recipient set reports `Add at least one recipient.` Errors use text and `role="alert"`, not color alone.

While Send is in flight the button is disabled, `aria-busy="true"`, and uses `cursor: progress`. A second Send or Ctrl+Enter does not start another call. Close is disabled during that flight so the unsent text cannot be discarded while the outcome is open.

Success closes the composer, clears its dirty state, and shows `Message sent.` in `role="status"`. A reply whose returned thread is the open conversation reloads that conversation once. A new message or a forward does not insert a row. If the active folder is Sent and no search is active, the list reloads its first page. If a search is active, the existing stale-result and Refresh behavior applies. Refresh still reloads that same query, not the whole mailbox.

A definite failure leaves the composer open, restores Send, and shows `Aurora could not send this message.` `send-unconfirmed` leaves the composer open, restores Send, and shows the `send-unconfirmed` sentence. It does not say the message was not sent. The same dialog offers `Check Sent`, which opens the Sent folder and leaves the composer and its text in place. It does not send again.

The composer is dirty when its fields differ from the seed, or from empty for a new message. Closing it, choosing another compose action, changing route, or changing the mailbox account asks `Discard this message?` with `The unsent message will be lost.` The actions are `Keep editing` and `Discard`. `Discard` is `.control-danger`. Focus starts on `Keep editing`. Escape keeps the message. Discard then performs the action that was waiting. The account selector does not change the composer's account id while the dialog is still deciding. While the composer is dirty, the renderer sets `beforeunload` so closing the window can ask the platform to confirm. That warning is only as strong as Electron's document close path. A crash, a killed process, or a shutdown that does not deliver `beforeunload` still drops the unsent text, because there is no draft.

## State and concurrency

There is no sending queue and no SQLite copy of the draft. The only unsent copy is the open composer.

One send may be in flight per Aurora account. A second send for that account returns `operation-in-progress`, does not call Gmail, and does not clear the composer. The composer shows `This message is already being sent.` The per-thread label lock remains separate, so a label change on another thread can still run. Two composers are not created.

Before send, main checks `modificationGrant`. `needs-reauth` and `readonly` return before HTTP. The metadata get for a reply happens after that check and before `messages.send`. If that get fails, nothing is sent.

`messages.send` does not use the reader retry. HTTP 400 is `gmail-rejected`. HTTP 401, when a response was received, may refresh the access token and try that one rejected call once, which is the existing authorized retry. HTTP 403 scope failures are `insufficient-scope`. HTTP 404 is `not-found`. HTTP 429, 500, and 503 are `send-unconfirmed`. Other definite 4xx responses use the existing permission or rejection codes. None of these are retried as a second send.

These outcomes are `send-unconfirmed`, are not retried, and must not be described as a message that was not sent:

- The send `fetch` throws, including the 10 second timeout.
- HTTP 500 or 503.
- A `200` whose body is missing, is not JSON, or has no valid message id.

A network failure on the metadata get, before `messages.send`, stays `network`. No send was attempted.

Reconnect and disconnect keep the composer text. The next Send uses the account id captured with the composer. If that account is gone or the grant is no longer usable, the composer stays open and shows the shared reauth or scope sentence.

## Errors

| Condition                                                                      | Code                                    | Sent           |
| ------------------------------------------------------------------------------ | --------------------------------------- | -------------- |
| Local validation, extra IPC field, or reply subject mismatch                   | `invalid-request` or `invalid-response` | No             |
| Read-only stored grant                                                         | `insufficient-scope`                    | No             |
| Token endpoint `invalid_grant`                                                 | `needs-reauth`                          | No             |
| Second send for the same account                                               | `operation-in-progress`                 | No second call |
| Metadata get fails before send                                                 | The read error                          | No             |
| Source message has no usable `Message-ID`, or its thread id differs            | `invalid-request`                       | No             |
| HTTP 400                                                                       | `gmail-rejected`                        | No             |
| HTTP 403 insufficient scope                                                    | `insufficient-scope`                    | No             |
| HTTP 404                                                                       | `not-found`                             | No             |
| HTTP 429                                                                       | `send-unconfirmed`                      | Unknown        |
| Timeout, dropped connection, HTTP 500, HTTP 503, or a `200` without a valid id | `send-unconfirmed`                      | Unknown        |

Development logs stay status and a safe reason, without the body, the subject, a recipient, or a token.

## Security

Context isolation, the sandbox, and disabled Node integration stay on. IPC sender checks stay in front of both new channels. The renderer cannot pass a URL, a method, a header block, or `raw`. Tokens and `historyId` are not IPC fields. The content security policy is unchanged. The composer does not load images, fonts, or HTML. The existing sanitizer is unchanged because the outgoing body is plain text.

The account id selects both the token and the `From` address. A reply's `threadId` must match the metadata message before send. One account cannot send with another account's token by changing the mailbox selector during an open composer. Nothing is sent by opening the composer, by a timer, or by a retry of an uncertain request.

## Tests

Automated tests use an injected `fetch` and do not use Google credentials.

- A new message is `POST /messages/send` for `users/me`, with `raw` and without `threadId`.
- Reply and Reply all include `threadId`, `In-Reply-To`, and `References`, and the derived subject. They do not call `drafts.send`.
- Forward has no `threadId` and no reply headers. Its encoded subject can carry the edited value.
- The decoded MIME is `text/plain; charset=UTF-8`, uses CRLF, and preserves Unicode in the body and in an encoded `From` display name and subject.
- A recipient, subject, or display name containing CR or LF does not produce an extra header.
- Empty recipients, a non-ASCII address, more than 50 addresses, a body over 262,144 bytes, and a raw message over 1,048,576 bytes do not call Gmail.
- Reply all removes the account address, copies To and Cc, and does not copy Bcc. A source `Reply-To` replaces `From`.
- A reply whose metadata `threadId` differs, or whose `Message-ID` is unusable, does not send.
- A historical read-only grant returns `insufficient-scope` before `fetch`. A 403 `insufficientPermissions` on send does the same and does not change the refresh token.
- Cancelled reconnect still does not replace `granted_scopes`. No test requires `gmail.send` in the authorization URL. `include_granted_scopes` stays absent.
- Two overlapping sends for one account produce one Gmail call and one `operation-in-progress`.
- HTTP 429, HTTP 500, a timeout, and a `200` without an id are `send-unconfirmed` and are not retried. HTTP 400 is `gmail-rejected` and is not retried. A received HTTP 401 refreshes the access token and retries that send once.
- A late success for a previous composer generation or a previous account does not clear the current composer.
- The component keeps typed text while the dialog is open, blocks a second Send, traps focus, and asks before discarding a dirty composer. Reply, Reply all, Forward, and Compose are reachable from the keyboard.

## Manual acceptance

Approved by the project owner on 8 November 2026 as acceptance of SPEC-001.6. The approval covers the implemented plain-text composer: a new message, Reply, Reply all, and Forward. It does not record a separate result for each named scenario.

The acceptance scope is a disposable mailbox and a disposable recipient:

- A read-only account can still open the inbox. Compose shows the reconnect sentence and does not send.
- Reconnect grants the existing modify consent. Cancel during that reconnect still leaves the old account able to read.
- After reconnect, a new plain-text message arrives at the recipient. The subject and Unicode body match. Cc and Bcc arrive as addressed, and the Bcc recipient is not shown to the To recipient.
- Reply stays in the same Gmail conversation. Reply all includes the other original recipients and does not include the sending account as a copy of itself.
- Forward arrives as a new conversation, with the forwarded plain text, and the person can change its recipients first.
- Send shows a busy state and does not send twice when activated twice.
- A failed send leaves the text in the composer. Discard asks before that text is thrown away. Keep editing leaves it.
- Quitting Aurora drops the unsent composer and does not create a Gmail draft.
- An `https` link still opens only from a click. A remote image is still not requested. The sent message contains no HTML part.

## Stages

1. Add the address, subject, quotation, and MIME helpers, with the encoding and injection tests. Do not call Gmail.
2. Add the metadata seed, the send call without the reader retry, `send-unconfirmed`, and the reader tests.
3. Add the two IPC channels, preload, and the renderer client.
4. Add the composer, the four actions, the discard dialog, and the component tests.
5. Run lint, format:check, typecheck, tests, coverage, build, and packaging. Manual acceptance uses the list above.

## Verification

Checked on 8 November 2026. `pnpm lint`, `pnpm format:check`, and `pnpm typecheck` passed. Node tests: 177 passed, 37 suites. Vitest: 24 passed, 8 files. Coverage of the existing included files: lines 92.90, branches 81.90, functions 90.42. `src/shared/mail-compose.ts` and `src/main/gmail/compose-mime.ts` are exercised by their own tests and are outside that coverage include list. Build: main 543.97 kB, preload 23.09 kB, CSS 28.77 kB, JS 362.66 kB. `pnpm check:build` passed. Package used `electron-builder` 26.17.0 with `--win --x64 --publish never`. Signing was skipped. Installer 110222625 bytes. Unpacked 386195711 bytes. `pnpm check:package` passed. Manual acceptance is the owner approval recorded above.

## Known limitations

Aurora sends one `text/plain` UTF-8 MIME message, built in the main process. A new message, Reply, Reply all, and Forward are supported. A definite send failure leaves the composer open. HTTP 429, HTTP 500, HTTP 503, a timeout, a dropped connection, and a `200` without a valid id are `send-unconfirmed`. Aurora does not retry those outcomes and does not describe them as a message that was not sent.

Unsent composition stays in renderer memory. Failed sends and unconfirmed sends keep that text. Discard asks before throwing it away. Changing account does not silently retarget an open composition. `beforeunload` can warn when the window closes. A crash, a killed process, or a shutdown that does not deliver `beforeunload` still drops the text, because there is no local draft and no Gmail draft.

Recipient addresses are ASCII only. A display name may be Unicode on `From`, and the body may be Unicode. Reply and Reply all use one normalized `Re:` subject plus `threadId`, `In-Reply-To`, and `References`. Forward starts a new conversation. Aurora does not repair a thread that Gmail still splits. `From` is the connected email. Send-as aliases are not offered.

Attachments, HTML composition, signatures, scheduled sending, and a background sending queue are not implemented. Those limits are deferred to SPEC-001.7. This specification does not define that later work.

## Risks

Gmail's subject match is specified only as "must match". Aurora sends one normalized `Re:` subject. A conversation can still split if Gmail compares the subject more strictly than that normalization. Aurora will not send a second copy to repair the split.

A timeout after Google accepted the message looks the same as a timeout before Google saw it. `send-unconfirmed` is the honest result. The person can create a duplicate if they send again without checking Sent. The sentence tells them to check first. Aurora does not try to detect the duplicate.

`From` is the connected email. A Google send-as alias is not offered. Gmail can reject a From it does not consider allowed. That rejection is `gmail-rejected`.

The metadata get and the send are two calls. The source message can change between them. Send uses the later headers. If the message was deleted, the reply is `not-found` and nothing is sent.

The 10 second timeout is the existing Gmail client timeout. A slow accept can become `send-unconfirmed` even though Gmail later sends the message.

Closing the OS window through `beforeunload` can warn. A crash or a forced quit still loses the composer. That is the consequence of refusing a draft store. Recipient addresses are ASCII only. A display name may be Unicode on `From`, and the body may be Unicode, but a non-ASCII mailbox is rejected.

## Approval

Accepted on 8 November 2026 and implemented.

1. `gmail.modify` remains the only Gmail scope. `gmail.send` is not added. Incremental authorization stays off. Schema version stays 2. Accounts that already reconnected can send. Read-only accounts use the existing reconnect.
2. Aurora builds one `text/plain` MIME message in process. No MIME dependency and no Gmail draft.
3. Main sets `From` from the connected account. Recipient headers are bare ASCII addresses. Display names are encoded only on `From`.
4. Reply and Reply all use a read-only derived subject, `threadId`, `In-Reply-To`, and `References`. A missing `Message-ID` blocks the reply. Forward is a new thread with an editable subject and a visible plain-text quotation.
5. `messages.send` is not retried on 429, 500, 503, or a lost response. Those lost responses are `send-unconfirmed`. A received HTTP 401 may be retried once after the access token is refreshed.
6. Unsent text exists only while the composer is open. Account changes do not retarget it. Quitting the app discards it.
