# SPEC-001.2 — Gmail OAuth & Account Connection

## Status

Implemented and accepted under the approved revision of SPEC-001.2. Authorization-response issuer validation, a single-flight lock for account operations, and the Desktop client secret required by the real Google token endpoint are in place. Real Google authorization, account persistence after restart, reconnect, and disconnect have passed. SPEC-001.1 stays in place. This specification does not call the Gmail API and does not read mail.

## Goal

Let a person connect more than one Google account from Aurora. The main process runs the Authorization Code flow with PKCE, verifies the ID token, and stores the refresh token with the SPEC-001.1 cipher. Settings holds the Google OAuth Client ID and the Desktop client secret. Integrations lists accounts and offers Connect, Cancel, Reconnect, and Disconnect.

## Decisions

- No dependency was added. Token requests use `fetch`. The callback listener uses `node:http`. PKCE, state, nonce, and signature checks use `node:crypto`.
- The schema remains version 1. State, nonce, the PKCE verifier, and the access token stay in memory. No migration runs.
- The authorization request asks for exactly `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/gmail.readonly`. It does not send `include_granted_scopes`. A later write scope needs a new authorization that lists the complete scope set.
- The system browser opens with `shell.openExternal`. The window created by Aurora does not navigate to Google.
- ID token verification is mandatory. There is no unsigned fallback.
- When the authorization response includes `iss`, that value is checked on its own, before the ID token is verified.
- One phase machine serializes connect, reconnect, cancel, disconnect, refresh, and client-id changes.
- Refresh of an access token is a main-process operation. It has no IPC channel and no Integrations button. A later mail specification can call it. This specification does not request Gmail messages.
- Aurora stores at most one Google OAuth client row. Settings stores the client secret with the SPEC-001.1 ciphertext. The renderer can submit a new secret and can see whether one is stored. It cannot read the secret back.
- A real Desktop client consent in Google Cloud Testing mode is a required manual acceptance test. Authorization, persistence after restart, reconnect, and disconnect have passed.

## Authorization

Endpoints:

- Authorization: `https://accounts.google.com/o/oauth2/v2/auth`
- Token: `https://oauth2.googleapis.com/token`
- Revocation: `https://oauth2.googleapis.com/revoke`
- JWKS: `https://www.googleapis.com/oauth2/v3/certs`

The PKCE verifier is 32 random bytes, encoded as base64url. The challenge is SHA-256 of that verifier, also base64url, with method `S256`. `state` and `nonce` are independent 32-byte base64url values. Comparisons use `timingSafeEqual`. The authorization URL also sends `response_type=code`, `access_type=offline`, and `prompt=consent select_account`.

The loopback server listens on `127.0.0.1` with an ephemeral port. The redirect URI is `http://127.0.0.1:<port>/callback`. Accepted remote addresses are `127.0.0.1` and the IPv4-mapped form `::ffff:127.0.0.1`. The server sets a 5 second request timeout, a 2 second headers timeout, at most 32 headers, and one request per socket. The URL may be at most 2048 characters. The only accepted request is `GET /callback` with an empty body and `Host` equal to `127.0.0.1:<port>`.

Allowed query keys are `code`, `state`, `error`, `scope`, `authuser`, `prompt`, and `iss`. A duplicate key, the wrong method, the wrong path, the wrong host, a body, or a state that does not match does not consume the attempt. Sixteen unmatched requests close the listener as `callback-limit`. A matching state with `error=access_denied` is `oauth-denied`. A matching state with a bad issuer, both `code` and `error`, another error, or an empty code is `provider-rejected`.

When `iss` is present it must be `https://accounts.google.com` or `accounts.google.com`. An absent `iss` is allowed. This check does not replace ID token issuer validation.

The HTML response is a fixed page: `You can close this window.` It does not echo the query. The body is flushed before the sockets are destroyed. Cleanup is idempotent on success, denial, rejection, limit, cancel, timeout, and shutdown.

The browser wait defaults to 180 seconds. Token, JWKS, and revocation requests default to 10 seconds. Tests inject shorter limits.

The real Google Desktop client rejected the authorization-code exchange when `client_secret` was omitted. The token endpoint returned HTTP 400 and `error=invalid_request`. The same flow succeeded after the Desktop Client ID and Client Secret were saved in Settings. When a secret is stored, Aurora includes `client_secret` on the authorization-code exchange and on the refresh request. When no secret is stored, those requests omit the field. PKCE, state, and nonce stay in place.

A failed authorization-code exchange is the only stage that writes a development diagnostic. When `NODE_ENV` is `development`, the main process writes one line: `aurora oauth stage=token-exchange status=<status> error=<identifier>`. The identifier is the provider `error` field when it matches `^[a-z0-9_]{1,32}$`; otherwise the line says `error=none`. The line omits `error_description`, the response body, and every OAuth secret. The renderer still receives `provider-rejected` or, for `invalid_grant`, `needs-reauth`, each with its fixed sentence. Production and packaged runs do not write the line. ID token verification and account persistence do not write it.

## ID token

The token must have three segments. The header algorithm must be `RS256`. `none` and every other algorithm are rejected. `kid` is required. The signature is checked with `node:crypto` `createPublicKey` on the JWK and `verify` with `RSA-SHA256`.

The payload issuer must be one of the two Google issuers. `aud` must equal the configured client id as a string. `exp` and `iat` allow 60 seconds of clock skew. `nonce` must match the value sent in the authorization request. `sub` is 1 to 256 characters and must not contain a control character. It is the account identity. Email is stored only when `email_verified` is exactly `true`; otherwise the stored email is null. An invalid `name` becomes a null display name.

The JWKS cache follows `Cache-Control: max-age`, capped at 3600 seconds. An unknown `kid` causes one refetch. A fetch failure is `network`. A document that is not a usable JWKS is `provider-rejected`. The access token from the token response is discarded. It is not stored and it is not returned.

## Accounts and credentials

`provider_account_id` is the Google `sub`. Connecting an existing subject updates that account. Reconnect whose verified subject differs from the selected account returns `account-mismatch` and writes nothing.

A new account without a refresh token of 1 to 8192 characters writes nothing and returns `provider-rejected`. Reconnect that receives a new refresh token replaces the ciphertext in the same transaction as the profile update. Reconnect that omits a refresh token keeps the existing ciphertext when it still decrypts, and sets the account to `connected`. If that ciphertext is missing or cannot be decrypted, the call returns `needs-reauth` and leaves the status and ciphertext unchanged.

`invalid_grant` during refresh sets `needs_reauth` and deletes the refresh-token row in one transaction. A network failure during refresh keeps the token and the status. A rotated refresh token replaces the ciphertext. A decrypt failure or a missing credential during refresh sets `needs_reauth` and leaves the ciphertext in place.

Encryption runs before `withTransaction`. A new account inserts the account row and then the credential row. An existing account updates the profile to `connected` and then inserts or replaces the credential. Those writes do not call `saveAccountRefreshToken` from inside the transaction, because nested `BEGIN` is rejected. A failed write rolls back the account and the ciphertext. `AccountLinkError` is thrown outside the transaction so it is not rewritten as an internal persistence error.

At most one `oauth_clients` row may have provider `google`. The client id must end with `.apps.googleusercontent.com`, use an `[A-Za-z0-9_-]` prefix, stay within 512 characters, and contain no control characters. Saving the same id changes nothing. Saving a different id with no Google accounts updates the row. Saving a different id while any Google account exists returns `client-in-use` and changes nothing.

## Concurrency

The service is `idle`, `authorizing`, `exchanging`, or `busy`, with a generation counter.

A new connect or reconnect cancels an authorization that is still waiting on the browser. The cancelled attempt returns `oauth-cancelled`. A new connect or reconnect does not cancel token exchange or a database write; those return `operation-in-progress`.

Disconnect and refresh require `idle`. Otherwise they return `operation-in-progress`. Cancel during authorization increments the generation, returns to `idle`, and cancels the listener. Cancel during exchange aborts the token request as `oauth-cancelled` before any write. Cancel during a busy operation returns `operation-in-progress`. Cancel while idle returns `{ cancelled: true }`.

The authorization timeout is remembered if it fires before the listener is assigned. `shutdown` aborts in-flight authorization and exchange. `will-quit` calls `shutdown` before the database closes. Saving the client id while the service is not idle returns `operation-in-progress`. A finished call releases the phase only when it still owns the generation.

## Disconnect

Disconnect is refused while another operation is active. Otherwise the service becomes busy, reads the refresh token, and, when the token can be read, `POST`s it to the revocation endpoint with a 10 second timeout and no retries. The local account is then deleted.

HTTP 200 returns `revoked`. A network error, a timeout, a non-200 response, a missing token, or a token that cannot be decrypted returns `disconnected-local`, and the local row is still deleted. A failed local delete is `internal`.

Revocation applies to the refresh and access tokens of that Google user for that client id, across the scopes of that grant and the devices using that client id. Other Google accounts and other client ids in the same Cloud project stay in place. Google's account permissions screen removes the app by consent-screen identity.

## IPC

`window.aurora.google` exposes seven channels. Each handler checks the authorized sender before calling the service. Arguments and results must have the exact keys below. An extra field, including any token, becomes `invalid-response`. The handler does not throw to Electron. Error text is a fixed sentence for the code. Responses contain no token, authorization code, state, nonce, verifier, or client secret.

| Channel                      | Argument                                     | Success value                                             |
| ---------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| `google-client:get`          | none                                         | `{ clientId: string \| null, secretConfigured: boolean }` |
| `google-client:save`         | `{ clientId, clientSecret: string \| null }` | `{ clientId, secretConfigured }`                          |
| `google-accounts:list`       | none                                         | `{ accounts }` of at most 100 summaries                   |
| `google-accounts:connect`    | none                                         | one account summary                                       |
| `google-accounts:reconnect`  | `{ accountId }`                              | one account summary                                       |
| `google-accounts:cancel`     | none                                         | `{ cancelled: true }`                                     |
| `google-accounts:disconnect` | `{ accountId }`                              | `{ outcome: "revoked" \| "disconnected-local" }`          |

An account summary is `{ id, email, displayName, status }`. `status` is `connected` or `needs_reauth`. `id` is a UUID. `email` and `displayName` are null or bounded text.

Error codes: `unauthorized`, `invalid-request`, `invalid-response`, `needs-client`, `client-in-use`, `oauth-denied`, `oauth-timeout`, `oauth-cancelled`, `callback-limit`, `account-mismatch`, `provider-rejected`, `network`, `encryption-unavailable`, `needs-reauth`, `operation-in-progress`, `internal`.

## Interface

Settings keeps the theme control and adds the Google OAuth client id and client secret. The real Desktop authorization required a saved secret. The client id is trimmed on save. A blank secret field leaves the stored secret in place. A non-empty secret replaces the ciphertext. The password field is cleared after a successful save. The page says whether a secret is saved and never shows its value. The success text is `Client ID saved.` when the secret field was blank, and `Client secret saved.` when a new secret was submitted.

Integrations replaces the empty placeholder. Without a client id, Connect is disabled and the page says to add the client id in Settings. With a client id, the page offers Connect and lists each account by email, otherwise display name, otherwise `Google account`, with status `Connected` or `Needs sign-in`. Each row has Reconnect and Disconnect. Cancel appears only while an authorization is in progress. After disconnect, `revoked` shows `The account was disconnected and the Google grant was revoked.` `disconnected-local` shows `The account was removed from Aurora. The Google grant may still be active.`

## Files

Created:

- `src/shared/google-accounts.ts`
- `src/shared/google-accounts.test.ts`
- `src/main/oauth/errors.ts`
- `src/main/oauth/pkce.ts`
- `src/main/oauth/pkce.test.ts`
- `src/main/oauth/google-issuer.ts`
- `src/main/oauth/loopback.ts`
- `src/main/oauth/loopback.test.ts`
- `src/main/oauth/id-token.ts`
- `src/main/oauth/id-token.test.ts`
- `src/main/oauth/google-flow.ts`
- `src/main/oauth/google-flow.test.ts`
- `src/main/oauth/google-accounts.ts`
- `src/main/oauth/google-accounts.test.ts`
- `src/main/persistence/account-link.ts`
- `src/main/persistence/account-link.test.ts`
- `src/main/google-ipc.ts`
- `src/main/google-ipc.test.ts`
- `src/renderer/src/features/settings/SettingsView.spec.ts`
- `docs/specifications/SPEC-001.2-gmail-oauth.md`

Modified:

- `src/shared/app-info.ts` adds `google` to the bridge types.
- `src/preload/index.ts`, `src/preload/aurora-api.ts`, and `src/preload/aurora-api.test.ts` forward the seven channels.
- `src/renderer/src/aurora-client.ts` and its test unwrap Google results.
- `src/renderer/src/features/settings/SettingsView.vue` saves the client id.
- `src/renderer/src/features/integrations/IntegrationsView.vue` and its spec manage accounts.
- `src/renderer/src/features/dashboard/DashboardView.spec.ts` stubs the Google bridge.
- `src/main/index.ts` constructs the service after the database and cipher exist, registers IPC, and shuts the service down before closing SQLite.
- `package.json` adds the new modules to the coverage include list.

No dependency was added. The schema, CSP, window preferences, and `electron-builder.yml` are unchanged.

## Verification

Host: Windows, Node `v22.13.0`, pnpm `12.11.2`. Electron `44.7.2` embeds Node `24.21.0`.

`pnpm lint` (exit 0).

`pnpm format:check` (exit 0).

`pnpm typecheck` (exit 0).

`pnpm test` (exit 0): Node `120` tests, `27` suites, `0` failures; Vitest `14` tests, `7` files, `0` failures. Node printed the existing type-stripping, module-type, and glob warnings, plus the SQLite experimental warning.

`pnpm test:coverage` (exit 0). Aggregate result: lines `95.64`, branches `81.76`, functions `95.29`. Thresholds remain lines 90, branches 80, functions 90. The include list adds the Google account, OAuth, account-link, and Google IPC modules to the previous security and persistence modules. This is not coverage of the whole repository.

`pnpm build` (exit 0): main `67.51 kB`, preload `9.14 kB`, renderer CSS `13.43 kB`, renderer JS `274.43 kB`. The main bundle requires `node:sqlite`, calls `safeStorage`, and contains the Google authorization, token, revocation, JWKS, and `gmail.readonly` strings. The renderer bundle does not contain those names.

`pnpm check:build` (exit 0): `build output verified`.

`pnpm package` (exit 0): electron-builder `26.17.0`, `npmRebuild` false, signing skipped, `--publish never`. Installer `release/Aurora-Setup-0.0.0.exe`, `109841904` bytes. Unpacked tree `385333540` bytes.

`pnpm check:package` (exit 0): `packaging verification passed`. `app.asar` contains `package.json` and `out/` only.

Automated tests use injected `fetch`, an injected cipher, and values such as `refresh-token-one`. They do not use Google credentials.

## Manual acceptance

All four manual acceptance tests passed.

Real Google authorization: passed. The first attempt omitted the client secret. Google sign-in and the loopback page succeeded, then the token endpoint returned HTTP 400 `invalid_request`. The development diagnostic recorded that identifier and did not include a response body. After the Desktop Client ID and Client Secret were saved in Settings, a later authorization connected the account.

Account persistence after restart: passed. The connected account was still listed after Aurora was restarted.

Reconnect: passed.

Disconnect: passed.

A Testing-mode refresh token expires after 7 days and should surface as `needs_reauth` on the next refresh.

## Security

The callback page, IPC envelopes, error messages, and the service logs covered by tests do not contain the authorization code, state, refresh token, access token, or client secret. Unauthorized IPC is rejected before the service runs. Decrypt failures do not return the ciphertext. A blank client-secret field does not delete a stored secret.

DPAPI protects the refresh token and the client secret from another Windows user. It does not protect those values from code running as the same user. The loopback listener is reachable by another process of the same user during the authorization. A matching `state` is required, and the listener closes after the attempt or after 16 unmatched requests.

Revocation is the grant for that Google user and that client id. It is not limited to one Aurora row, and it does not cover every client id in the Cloud project.

If Google issues a replacement refresh token, invalidates the previous one, and the local transaction then fails, Aurora still holds the previous ciphertext. The next refresh becomes `needs_reauth`.

A shared public client id and Google verification of `gmail.readonly` remain a later phase.

Sandbox, context isolation, disabled Node integration, web security, the navigation block, and both content security policies are unchanged.

## Deviations

`operation-in-progress` is an additional error code. The approved error list did not name the concurrent-operation refusal, and the final requirements require that refusal.

A second connect cancels only an authorization that is still waiting on the browser. Token exchange and a database write stay exclusive and return `operation-in-progress`.

Account refresh is implemented and tested on the main-process service. It is not an IPC channel and Integrations has no Refresh control.

The schema stays version 1. No migration was required.
