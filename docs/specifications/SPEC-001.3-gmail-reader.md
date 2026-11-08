# SPEC-001.3 — Gmail Reader

## Status

Implemented and accepted. The manual checks that were performed confirmed that the Gmail reader works. Those checks were not reported scenario by scenario, so this document does not mark the individual mailbox scenarios below as passed. The thread-based architecture, `gmail.readonly`, main-process Gmail calls, in-memory access tokens, the page size of 20, main-process HTML sanitization, disabled remote images, attachment metadata only, and `sanitize-html` as the only new dependency are in place. A conversation is returned whole or as `too-large`. Only a token-endpoint `invalid_grant` marks a refresh token unusable. SPEC-001.1 and SPEC-001.2 stay in place. This specification does not write to Gmail.

## Goal

Let a person read and search Gmail from Aurora with an account connected in SPEC-001.2.

## Non-goals

Marking a message read, archiving, deleting, sending, and changing labels are out of scope. Attachment bytes are out of scope. Full mailbox synchronization and a persistent message cache are out of scope. No backend is added. The schema remains version 1 and no migration runs. The Gmail scope remains `https://www.googleapis.com/auth/gmail.readonly`. Electron sandbox, context isolation, disabled Node integration, web security, the navigation block, denied `window.open`, and both content security policies stay as they are.

## Decisions

- The mailbox UI is thread-based. A row is a conversation. Opening it loads that conversation once.
- Gmail API v1 is called with `fetch` from the Electron main process. The npm `googleapis` package is not added.
- `sanitize-html` is the only new dependency. HTML is sanitized in main before IPC.
- Remote images are removed and are not requested. Attachments are name, media type, and size.
- Access tokens live in a main-process map keyed by the Aurora account id. They are not written to SQLite and are not sent through IPC.
- `refreshAccessToken` is extended to return the access token to its main-process caller. `refreshAccount` still does not persist or return that token.
- A conversation is returned whole or as `too-large`. The success value never contains a subset of the conversation.
- HTTP status alone does not prove that a refresh token is unusable. Only a token-endpoint `invalid_grant` marks the account `needs_reauth` and makes the stored refresh token unusable. The existing decrypt failure path from SPEC-001.2 also sets `needs_reauth`, and it still does not delete the ciphertext.
- External links open only after a click, and only after main accepts the URL.
- Account authorization uses the selected Aurora account id. A Gmail thread id is an opaque parameter of that account's request, not a capability and not a cache key.
- The mail view drops a settled response whose generation is no longer current.

## UX

Add `Mail` at `/mail` between Dashboard and Integrations. Use a Lucide icon. Dashboard, Integrations, and Settings keep the 720 px column. Mail uses the width of the main area.

The top of Mail has an account select and a search box. Labels sit under that. The content shows either the conversation list or one open conversation. Back returns to the list and keeps the page stack.

The account select uses `google-accounts:list`. The first `connected` account is selected. A `needs_reauth` account is disabled. Mail does not start OAuth. Its recovery link goes to Integrations. Changing account clears the list, the open conversation, the search, and the page stack.

The initial label is `INBOX`. Visible system labels are `INBOX`, `SENT`, `DRAFT`, `SPAM`, `TRASH`, `STARRED`, and `IMPORTANT`, plus every label whose type is `user`. `CATEGORY_*`, `UNREAD`, and `CHAT` are hidden. A user label's visible name is the API `name`, capped and free of control characters. An unread count is shown when it is an integer from 0 through 1000000.

A non-empty search is sent as `q` and replaces the label filter. Clearing it restores the selected label. `includeSpamTrash` is true only when the active label is `SPAM` or `TRASH`, or when a search is active. Aurora does not interpret Gmail query syntax.

The list page size is 20, with Previous and Next. There is no infinite scroll. A row shows the oldest message's subject, the newest message's sender and date, the thread snippet, and unread when any message includes `UNREAD`. Opening a conversation does not remove `UNREAD` in Aurora or in Gmail.

The snippet is the Gmail `snippet` string from thread metadata, or the list snippet when metadata has none. Before clipping, Aurora decodes character references in that field once, in the main process. Decimal references are `&#` plus digits plus `;`. Hexadecimal references are `&#x` or `&#X` plus hex digits plus `;`. Named references are lowercase `amp`, `lt`, `gt`, `quot`, `apos`, and `nbsp`, each with `;`. The scan continues after the reference, so `&amp;#44;` becomes the characters `&#44;` and is not decoded again. A reference stays unchanged when the semicolon or the digits are missing, the code point is above U+10FFFF, the code point is a surrogate, or the code point is 31 or below or 127. Those references therefore cannot add a disallowed control character. Control characters already in the snippet are still removed. The stored snippet is then at most 500 characters, or null when nothing remains. Subject and participants are not decoded. The mail view interpolates the snippet as text and does not use `v-html`.

Empty and error states use `StatusPanel`. No connected account asks for a connection in Integrations. An empty label says there are no conversations. `too-large` on open says the conversation is too large to show. The list row remains.

## Gmail API

Requests go to `https://gmail.googleapis.com/gmail/v1/users/me/...` with a bearer access token. The path uses `users/me`. The Aurora account id selects the refresh token. The mailbox address is not part of the URL.

- Labels: `GET /labels`
- List: `GET /threads?maxResults=20`, plus `labelIds`, `pageToken`, `q`, and `includeSpamTrash` when they apply
- Row metadata: `GET /threads/{id}?format=metadata` with headers `From`, `To`, `Cc`, `Bcc`, `Subject`, and `Date`
- Conversation: `GET /threads/{id}?format=full`

Metadata reads for one page run four at a time. One failed metadata read fails the page. `format=full` is requested only when a conversation is opened.

Label, thread, and message ids are 1 to 128 characters and match `[A-Za-z0-9_-]`. A search is 1 to 512 characters and has no control character. `pageToken` is 1 to 1024 characters, has no control character, and is otherwise opaque. Main forwards it and does not store or interpret it. The renderer keeps a stack for the current account, label, and search. The first page has no token. A missing `nextPageToken` means there is no next page. Changing account, label, or search clears the stack.

Each Gmail response is read as a stream. If `Content-Length` is one decimal integer greater than 8388608, the body is not read. Otherwise bytes are counted as they arrive. At 8388608 bytes the read is cancelled, the partial bytes are discarded, and the result is `too-large`. A partial body is not parsed as JSON. A missing or repeated `Content-Length` leaves the stream cap in force. Each HTTP call still times out at 10 seconds.

## Access token

`refreshAccessToken` returns `{ accessToken, expiresIn, refreshToken }` to main. `accessToken` is a string of 1 to 8192 characters with no control character. `expiresIn` is an integer from 1 through 86400, or absent. `refreshToken` stays optional and is persisted only through the existing rotation path.

The cache key is the Aurora account id. A present `expiresIn` is stored until 60 seconds before expiry. An absent `expiresIn` is used for that Gmail call and is not cached. The cache entry is removed on disconnect, on `needs_reauth`, when a Gmail call rejects the token, when refresh fails, and on shutdown.

One refresh is in flight per account id. A Gmail read requires the OAuth phase to be `idle`, then increments a reader count. Connect, reconnect, disconnect, saving the client, and `refreshAccount` return `operation-in-progress` while that count is above zero. The count is decremented when the read finishes, including when the renderer will ignore the result.

A Gmail HTTP 401 drops that account's cached access token, refreshes once, and retries that Gmail request once. The retry uses the new access token. If Gmail returns 401 again, the result is `gmail-rejected`. The account status and the stored refresh token stay unchanged, and the rejected access token is not cached.

## Limits

These limits apply to one conversation. Crossing any of them returns `too-large` and no messages.

- HTTP body: 8388608 bytes, enforced while streaming.
- Messages in the thread resource: 50. Message 51 makes the conversation `too-large`.
- MIME nesting: depth 8. The payload starts at depth 1. Each nested `parts` level adds one.
- One decoded `text/plain` or `text/html` part: 1000000 Unicode code units. The part is not shortened.
- Sum of those decoded parts in the conversation: 1500000 Unicode code units.
- UTF-8 size of the IPC success value: 2000000 bytes.
- UTF-8 size of a list or label success value: 512000 bytes.

Attachment bytes inside `format=full` count toward the HTTP cap. They are not decoded into the IPC value.

## MIME

`payload` is walked after the thread JSON is accepted and the message count is within 50. A missing `parts` array means the payload itself is the body. `multipart/alternative` keeps HTML for display and keeps plain text when the sanitized HTML is empty. `multipart/mixed` and `multipart/related` contribute the body and the attachment list.

`body.data` for a text part must match `^[A-Za-z0-9_-]*={0,2}$`. Any other alphabet makes the conversation `unavailable`. Decoding uses base64url. The charset comes from `Content-Type`. A missing charset is UTF-8. An explicit `utf-8` label, and any other label outside the three below, is decoded as UTF-8 with replacement. `us-ascii`, `iso-8859-1`, and `windows-1252` are decoded as UTF-8 first, with `TextDecoder` in fatal mode. If those bytes are not valid UTF-8, they are decoded as Windows-1252. Bytes `0x00` through `0x7F` and `0xA0` through `0xFF` become the Unicode scalar of the same value. Bytes `0x80` through `0x9F` use the Encoding Standard Windows-1252 map, so `0x80` is U+20AC. Node 22.13.0 `TextDecoder` maps those thirty-two bytes to C1 controls. Electron 44.7.2, which embeds Node 24.21.0, maps `0x80` to U+20AC. The fallback uses the table directly so both runtimes produce the Encoding Standard result. This accepts mail that labels UTF-8 bytes with a single-byte charset. A genuine Windows-1252 message is not valid UTF-8 when it contains a byte such as `0xF3` (`ó`) or `0x80` (`€`), so it still decodes as Windows-1252. ASCII-only text is the same in both encodings. The check does not search the decoded string and does not replace character sequences. The `iso-8859-1` and `us-ascii` fallback is that same Windows-1252 map, which is how the Encoding Standard treats those labels. A missing charset is not sniffed. A single-byte payload whose bytes happen to be valid UTF-8 is read as UTF-8. Messages are ordered by `internalDate` ascending. `internalDate` is a decimal millisecond string of 1 to 13 digits. A missing or invalid date is null.

An attachment is a part with `Content-Disposition: attachment` or a filename. The IPC value contains the file name, the media type, and the size. The file name drops path separators and control characters and is capped at 256 characters. A missing name is `Attachment`. A media type that does not match a single `type/subtype` token pair becomes `application/octet-stream`. Size is an integer from 0 through `Number.MAX_SAFE_INTEGER`, or 0 when missing. `attachments.get` is not called.

A payload that is not an object, a `parts` value that is present and is not an array, or a text body whose base64url is illegal is `unavailable`. Those cases are not `too-large` and are not sent through as raw MIME.

## HTML and links

`sanitize-html` runs in main. The allowed tags are `a`, `p`, `br`, `div`, `span`, `strong`, `em`, `ul`, `ol`, `li`, `blockquote`, `pre`, `code`, `h1` through `h6`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, and `hr`. The only allowed attribute is `href` on `a`. `style`, event handlers, `src`, `svg`, `math`, `img`, `script`, `iframe`, `object`, `embed`, `form`, `link`, `meta`, and `base` are dropped. An original `img` sets `imagesOmitted` to true. The mail view then says `Images in this message were not loaded.` The renderer paints the sanitized HTML and does not treat any other field as HTML.

An anchor click is the only event that may request an external open. The handler calls `preventDefault`. Rendering, hovering, and mounting do not call the open channel. Main accepts `{ url }` and then checks the raw string:

- Length is 1 to 2048.
- No character code at or below 31, and no character code 127.
- No whitespace and no backslash.
- `new URL` succeeds.
- The protocol is `http:`, `https:`, or `mailto:`.
- `username` and `password` are empty.
- `http` and `https` have a non-empty hostname.
- `mailto` has a non-empty address.

Main opens `url.href` from that parsed URL only after the same protocol and credential checks pass on the parsed value. Any other input is `invalid-request` and nothing is opened. `shell.openExternal` is the only opener. The channel cannot prove that a click happened. The renderer contract forbids any other caller, and main still applies the checks above.

## IPC

`attachGmailIpc` is separate from the Google account channels. Each handler checks the authorized sender, requires exact keys, turns an extra field into `invalid-response`, and does not throw to Electron. Error text is the fixed sentence for the code. Responses contain no access token, refresh token, raw MIME, `historyId`, or `attachmentId`.

| Channel           | Argument                                   | Success value                |
| ----------------- | ------------------------------------------ | ---------------------------- |
| `gmail:labels`    | `{ accountId }`                            | `{ labels }`                 |
| `gmail:threads`   | `{ accountId, labelId, query, pageToken }` | `{ threads, nextPageToken }` |
| `gmail:thread`    | `{ accountId, threadId }`                  | `{ id, messages }`           |
| `gmail:open-link` | `{ url }`                                  | `{ opened: true }`           |

`labelId`, `query`, and `pageToken` may be null. `labelId`, when set, must be one visible label for that same account. Main learns the visible set from that account's label request. A label id that is only well formed is not accepted for another account's list.

A label is `{ id, name, type, unreadCount }` with `type` of `system` or `user`. A row is `{ id, subject, from, date, snippet, unread }`. A message is `{ id, from, to, cc, bcc, subject, date, unread, text, html, imagesOmitted, attachments }`. An attachment is `{ fileName, mimeType, size }`. `date` is ISO-8601 from `internalDate`, or null. Subject, participants, and snippet are null or bounded text with no control characters. `text` and `html` are null or bounded text that may contain tab, line feed, and carriage return. Any other control character in those fields is rejected. The success value for a thread has no truncation flag and no omitted-count field.

Shared parsers live in `src/shared/gmail.ts`. Preload and the renderer client expose `gmail` beside `google`. The renderer parses every success value again before display.

Error codes: `unauthorized`, `invalid-request`, `invalid-response`, `needs-reauth`, `network`, `encryption-unavailable`, `operation-in-progress`, `rate-limited`, `unavailable`, `not-found`, `too-large`, `permission-denied`, `gmail-rejected`, `internal`.

New sentences:

- `rate-limited`: `Gmail is limiting requests. Try again in a moment.`
- `unavailable`: `Aurora could not read this mailbox.`
- `not-found`: `This conversation is no longer available.`
- `too-large`: `This conversation is too large to show.`
- `permission-denied`: `Gmail did not allow this request.`
- `gmail-rejected`: `Gmail refused this request.`

`needs-reauth` keeps the SPEC-001.2 sentence. `permission-denied` and `gmail-rejected` do not change the account status. The mail view may link to Integrations. It does not present those two results as an expired credential.

When `NODE_ENV` is `development`, a failed Gmail call may write one line: `aurora gmail status=<http> reason=<identifier>`. The identifier is kept only when it matches `^[A-Za-z0-9_]{1,64}$`; otherwise the line says `reason=none`. The line omits the response body, tokens, the query, and ids. Production does not write it.

## Account isolation

Every read takes an Aurora `accountId`. Main loads that row, requires provider `google` and status `connected`, and refreshes only that row's refresh token. A `needs_reauth` row does not call Gmail. No map is keyed by a Gmail thread id, label id, or message id. The same thread id string requested for two Aurora accounts uses two credentials and two bearer tokens.

The renderer also clears mailbox state on account change. That clearing is not the isolation control. Main authorizes each request from the account id even when a stale renderer call still arrives.

## Stale responses

The mail view keeps one numeric generation. It increments the generation when the selected account changes, the selected label changes, the search is applied or cleared, a conversation is opened, Back returns to the list, or the visible page changes. The page increment keeps a slow page from replacing a newer page.

Each labels, threads, and thread call captures the generation before awaiting. When the promise settles, the view applies the success or the error only if the captured generation is still current. A stale success does not replace the visible mailbox. A stale error does not replace the newer loading or error state. On account, label, or search change, the visible list and open conversation are cleared before the new request returns, so the previous account's messages are not left on screen. On conversation change, the open body is cleared before the new body returns. The list can stay while a conversation is loading.

Main does not receive the generation and does not cancel the HTTP call for a superseded view. The reader count still covers that call until it finishes.

`gmail:open-link` is not generation-gated. The click already chose the URL, and main validates that URL.

## Errors

Gmail error bodies are read only for classification. From a JSON object, main may read `error.errors[].reason` and, if no reason is present, `error.status`. A value is kept only when it matches `^[A-Za-z0-9_]{1,64}$`. `message` and `error_description` are ignored.

Quota reasons are `rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`, and `dailyLimitExceeded`. Permission reasons are `insufficientPermissions`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, and `forbidden`. If both kinds appear, the quota reason wins. `error.status` of `RESOURCE_EXHAUSTED` is a quota signal. `error.status` of `PERMISSION_DENIED` is a permission signal only when no quota reason is present.

| Condition                                                        | Result                                              | Stored refresh token and account status                           |
| ---------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| Token endpoint `invalid_grant`                                   | `needs-reauth`                                      | Marked unusable and `needs_reauth`                                |
| Refresh-token decrypt failure                                    | `needs-reauth`                                      | Status becomes `needs_reauth`; ciphertext stays, as in SPEC-001.2 |
| Gmail 401, then refresh succeeds, then the retried call succeeds | Success                                             | Unchanged; new access token may be cached                         |
| Gmail 401 after one refresh and one retry                        | `gmail-rejected`                                    | Unchanged; rejected access token is not cached                    |
| Token endpoint network failure                                   | `network`                                           | Unchanged                                                         |
| Token endpoint error other than `invalid_grant`                  | `unavailable`                                       | Unchanged                                                         |
| HTTP 429, or a quota reason                                      | One retry of at most 2 seconds, then `rate-limited` | Unchanged                                                         |
| HTTP 403 with a permission reason                                | `permission-denied`                                 | Unchanged                                                         |
| HTTP 403 with no recognized reason                               | `unavailable`                                       | Unchanged                                                         |
| HTTP 404                                                         | `not-found`                                         | Unchanged                                                         |
| HTTP 500 or 503                                                  | One retry, then `unavailable`                       | Unchanged                                                         |
| Any other HTTP status                                            | `unavailable`                                       | Unchanged                                                         |
| Stream or decoded-size limit                                     | `too-large`                                         | Unchanged                                                         |
| Malformed MIME or illegal base64url                              | `unavailable`                                       | Unchanged                                                         |

The 429 retry waits for a `Retry-After` delta of 1 or 2 seconds. Any other `Retry-After` waits 1 second. There is no second retry. A 403 is never by itself a reason to refresh, and it is never by itself a reason to mark the refresh token unusable.

## Tests

Automated tests use an injected `fetch` and an injected cipher. They do not use Google credentials.

Access token and isolation:

- The extended refresh returns an access token to the caller, and `refreshAccount` does not persist it.
- Two overlapping reads of one account cause one token request.
- The same Gmail thread id read for two Aurora accounts uses two refresh tokens and two bearer headers.
- A thread id containing `/` or `..` is `invalid-request`.
- No IPC JSON contains `access_token`, `refresh_token`, or the token value.
- An unauthorized sender does not reach the service.

Errors:

- Token-endpoint `invalid_grant` marks the credential unusable and returns `needs-reauth`.
- Gmail 401, a successful refresh, and a successful retry return the mailbox and do not change account status.
- Gmail 401 after a successful refresh returns `gmail-rejected` and leaves the account `connected`.
- HTTP 403 `insufficientPermissions` returns `permission-denied` and leaves the refresh token usable.
- HTTP 403 `rateLimitExceeded` and HTTP 429 twice return `rate-limited` and leave the account `connected`.
- HTTP 403 with no recognized reason, and a token-endpoint `invalid_client`, return `unavailable` and leave the account `connected`.
- HTTP 503 twice returns `unavailable`.
- A development failure line contains the status and a safe reason, and does not contain the response body or the access token.

Size and MIME:

- `Content-Length` above 8388608 does not read the body and returns `too-large`.
- A stream that passes 8388608 bytes cancels the read, does not parse the partial JSON, and returns `too-large`.
- 51 messages return `too-large` and no message array.
- MIME depth 9 returns `too-large`.
- A text part of 1000001 code units returns `too-large` and is not shortened in the result.
- An IPC value above 2000000 UTF-8 bytes returns `too-large`.
- Illegal base64url and a `parts` value that is not an array return `unavailable`.
- A legal multipart alternative keeps sanitized HTML and plain text, and an attachment contributes no bytes.
- UTF-8 Spanish text labeled `us-ascii`, `iso-8859-1`, or `windows-1252` decodes as UTF-8.
- Genuine Windows-1252 Spanish text, including `0xF3` and `0x80`, decodes as Windows-1252 and passes the shared thread parser.
- Explicit `utf-8` stays UTF-8 with replacement. Another charset label is not sniffed.
- A mislabeled multipart alternative passes `parseGmailThread` with the decoded text and sanitized HTML.
- `&#44;` in a snippet becomes a comma, `&#8364;` and `&#x20AC;` become €, and `&amp;` becomes `&`.
- `&lt;script&gt;` becomes the plain characters `<script>`. `&amp;#44;` stays `&#44;`.
- A numeric reference without a semicolon, without digits, above U+10FFFF, a surrogate, or a disallowed control stays unchanged.
- Snippet decoding happens before the 500-character clip. The result has no disallowed control character and passes the shared list parser. Subject and sender are not decoded.
- `script`, `iframe`, `onerror`, a `javascript:` link, and `img` are removed. An `https` link remains. `imagesOmitted` is true when an image was removed.

Links, pagination, and stale view:

- `gmail:open-link` opens `https` and `mailto` after a modeled click.
- It rejects `javascript:`, `data:`, `file:`, a URL with a user or password, a control character, whitespace, a backslash, and a string `URL` cannot parse.
- `pageToken` is forwarded unchanged, and an extra response field is `invalid-response`.
- Disconnect while a read is active returns `operation-in-progress`.
- The mail view applies a response only when its generation is current. A late error from the previous account, label, search, or conversation does not replace the newer state.

The coverage include list adds the new Gmail modules. Thresholds stay at lines 90, branches 80, and functions 90. Implementation runs the existing quality commands. The manual checks that were performed confirmed the reader. These scenarios were not reported individually, so none is marked passed on its own: inbox fields, a multi-message HTML conversation that remains unread in Gmail web, a body that previously showed paired characters such as `Ã³` now showing the accented letter, a snippet `&#44;` shown as a comma while `&lt;script&gt;` is shown as text, `from:` search, next and previous page, a user label plus `SENT` and `SPAM`, a second account, a revoked grant that becomes `needs-reauth` only after `invalid_grant`, a remote image that Aurora does not request, and an `https` link opened by a click.

## Stages

1. Extend refresh so main receives the access token, with cache, single-flight, and cleanup.
2. Add the streaming Gmail client, limits, and error classification.
3. Add MIME decoding and HTML sanitization.
4. Add shared types, IPC, preload, and the renderer client.
5. Add the Mail route, including the generation guard and click-only links.
6. Add the automated tests and run the quality suite. The manual checks that were performed confirmed the reader. The scenarios above stay unitemized.

## Risks

The access token remains in the main process until expiry or cache removal. DPAPI does not cover that value. A Testing-mode refresh token still expires after 7 days. If Google rotates the refresh token and the local write then fails, the account becomes `needs_reauth`, as in SPEC-001.2.

`sanitize-html` can have a bypass. The closed allowlist, the link re-check, and the unchanged content security policy limit the effect. Main cannot prove that `gmail:open-link` was caused by a click.

A superseded mailbox request still runs until the Gmail call finishes, and it holds the reader count for that time. A metadata page can approach Gmail's per-user quota. The page size of 20 and one retry do not make Aurora a sync client. A conversation past any limit is refused whole, so a large but mostly readable thread shows `too-large` rather than the first messages.

Single-byte charset labels are checked as UTF-8 before Windows-1252. A Windows-1252 body whose bytes are also valid UTF-8 is read as UTF-8. Snippet decoding is one pass and only the six named references plus numeric references. A sender who wrote the characters `&#44;` as text, and whose mail client stored them as `&amp;#44;`, still sees `&#44;`.

Opening a message does not mark it read. Attachments are visible as metadata and cannot be downloaded. Drafts can be read and cannot be sent.

## Verification

Host: Windows, Node `v22.13.0`, pnpm `12.11.2`. Electron `44.7.2` embeds Node `24.21.0`.

`pnpm lint` (exit 0).

`pnpm format:check` (exit 0).

`pnpm typecheck` (exit 0).

`pnpm test` (exit 0): Node `158` tests, `34` suites, `0` failures; Vitest `19` tests, `8` files, `0` failures. Node printed the existing type-stripping, module-type, and glob warnings, plus the SQLite experimental warning. This run is the combined tree, so it also includes the SPEC-001.5 tests.

`pnpm test:coverage` (exit 0). Aggregate result: lines `96.52`, branches `82.60`, functions `95.84`. Thresholds remain lines 90, branches 80, functions 90. The include list adds the Gmail modules to the previous security, persistence, and Google account modules. This is not coverage of the whole repository.

`pnpm build` (exit 0): main `510.89 kB`, preload `17.04 kB`, renderer CSS `26.25 kB` (`index-z5PPMLgR.css`), renderer JS `309.23 kB` (`index-c7Irh7xM.js`). The main bundle requires `node:sqlite`, calls `safeStorage`, contains the sanitizer, and contains `gmail.readonly`. The renderer bundle does not contain `node:sqlite`, `safeStorage`, access tokens, or refresh tokens. The renderer CSS and JS sizes include SPEC-001.5.

`pnpm check:build` (exit 0): `build output verified`.

`pnpm package` (exit 0): electron-builder `26.17.0`, `npmRebuild` false, signing skipped, `--publish never`. Installer `release/Aurora-Setup-0.0.0.exe`, `110207006` bytes. Unpacked tree `386100636` bytes. That installer also contains SPEC-001.5.

`pnpm check:package` (exit 0): `packaging verification passed`. `app.asar` contains `package.json` and `out/` only.

`sanitize-html` `2.18.1` is installed for the build and bundled into `out/main/index.js`. It is a development dependency so electron-builder does not copy `node_modules` into `app.asar`.

## Approval

No product choice is left open. Implementation is complete. The manual checks that were performed confirmed the reader. Unitemized mailbox scenarios are not recorded as passed.
