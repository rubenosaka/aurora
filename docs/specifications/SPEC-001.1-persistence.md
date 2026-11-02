# SPEC-001.1 — Local Persistence & Secure Storage

## Status

Implemented under the approval of SPEC-001.1. Foundation specifications SPEC-000.1 through SPEC-000.5 stay in place. This specification does not add Gmail OAuth, Gmail API calls, or mail UI.

## Goal

Give the Electron main process a local SQLite database and an OS-backed place for OAuth refresh tokens and client secrets. The renderer does not receive a database connection, a credential, or a new IPC channel.

## Decisions

- Persistence uses `node:sqlite` `DatabaseSync` from the Electron runtime. No SQLite package and no ORM were added.
- Electron `safeStorage` encrypts refresh tokens and client secrets. The ciphertext is a blob in SQLite. There is no plaintext fallback.
- Development and packaged builds use different database files.
- A missing database file is created and migrated. A damaged file, an unreadable file, or a schema newer than this application is left in place. Startup shows a fixed message and quits. Recovery is a later specification.
- Theme preference remains in renderer `localStorage` under `aurora.theme`.
- `window.aurora` still exposes only `app.getInfo`.

## Schema

Migration 1 runs in one transaction. The version is stored in `schema_migrations`. A second open sees version 1 and does not apply the migration again. A higher version is rejected before any write to the original file.

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, client_id)
) STRICT;

CREATE TABLE connected_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  status TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_account_id),
  CHECK (status IN ('pending', 'connected', 'needs_reauth', 'disconnected'))
) STRICT;

CREATE TABLE credential_secrets (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES connected_accounts (id) ON DELETE CASCADE,
  oauth_client_id TEXT REFERENCES oauth_clients (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (account_id IS NOT NULL AND oauth_client_id IS NULL AND kind = 'refresh_token') OR
    (account_id IS NULL AND oauth_client_id IS NOT NULL AND kind = 'client_secret')
  ),
  UNIQUE (account_id, kind),
  UNIQUE (oauth_client_id, kind)
) STRICT;
```

`email` may be null. An OAuth client id is configuration and is stored in `oauth_clients.client_id`. A client secret and a refresh token are ciphertext. Access tokens are not stored. `app_settings` has no writer in this specification. Mail cache tables are not created.

Every connection sets `PRAGMA foreign_keys = ON` and reads the pragma back. It also sets a busy timeout and WAL mode after the file has been accepted.

## Locations

`app.getPath('userData')` is the profile directory. The runtime name remains `aurora`, so the installed profile is `%AppData%\Roaming\aurora`.

- Packaged database: `userData/aurora.sqlite`
- Development database: `userData/dev/aurora.sqlite`

The main process opens the database after `app.whenReady()` and before creating the window. `will-quit` closes it. If encryption is unavailable, startup stops before creating the directory or the file.

An existing file is inspected through a temporary copy. The copy is removed afterwards. Rejection does not rename, replace, or rewrite the original file or its `-wal` and `-shm` siblings. A failed migration rolls back and leaves the same file for a later open.

Startup errors use fixed sentences from `PersistenceError`. The dialog title is `Aurora`. The message does not include a path or the underlying exception text.

## Credentials

`createSafeStorageCipher` calls `safeStorage.encryptString` and `safeStorage.decryptString`. It does not call `setUsePlainTextEncryption`. If `isEncryptionAvailable()` is false, or encryption throws, the write is aborted and no credential row is inserted. A decryption failure becomes `decrypt-failed` and the ciphertext stays in place.

Reads name the owner and the kind:

- `saveAccountRefreshToken` / `readAccountRefreshToken` use `account_id` and `refresh_token`.
- `saveClientSecret` / `readClientSecret` use `oauth_client_id` and `client_secret`.

There is no read by secret id. Deleting an account deletes only that account's credential rows. Deleting an OAuth client is rejected while an account references it. Deleting a client with no accounts deletes its client secret.

Tests use an injected cipher and values such as `refresh-token-one`. They do not use Google credentials.

## Files

Created:

- `src/main/persistence/errors.ts`
- `src/main/persistence/database.ts`
- `src/main/persistence/accounts.ts`
- `src/main/persistence/credentials.ts`
- `src/main/persistence/safe-storage-cipher.ts`
- `src/main/persistence/startup.ts`
- tests beside those modules
- `docs/specifications/SPEC-001.1-persistence.md`

Modified:

- `src/main/index.ts` opens and closes the database and constructs the safeStorage cipher.
- `package.json` adds the persistence modules to the coverage include list.

No dependency was added. Preload, renderer, CSP, window preferences, and `electron-builder.yml` are unchanged.

## Verification

Host: Windows, Node `v22.13.0`, pnpm `12.11.2`. Electron `44.7.2` embeds Node `24.21.0`. `node:sqlite` opens on both. Node 22.13.0 prints `ExperimentalWarning: SQLite is an experimental feature`. Electron's Node did not print that warning in the earlier probe.

`pnpm lint` (exit 0).

`pnpm format:check` (exit 0).

`pnpm typecheck` (exit 0).

`pnpm test` (exit 0): Node `74` tests, `19` suites, `0` failures; Vitest `9` tests, `6` files, `0` failures. Node printed the existing type-stripping, module-type, and glob warnings, plus the SQLite experimental warning.

`pnpm test:coverage` (exit 0). The report covers the previous five security modules plus the persistence modules. Aggregate result: lines `96.89`, branches `86.14`, functions `100`. Thresholds remain lines 90, branches 80, functions 90. This is not coverage of the whole repository.

`pnpm build` (exit 0): main `14.90 kB`, preload `2.44 kB`, renderer CSS `12.84 kB`, renderer JS `251.76 kB`. The main bundle requires `node:sqlite` and calls `safeStorage`. The renderer bundle does not contain those names.

`pnpm check:build` (exit 0): `build output verified`.

`pnpm package` (exit 0): electron-builder `26.17.0`, `npmRebuild` false, signing skipped. Installer `release/Aurora-Setup-0.0.0.exe`, `109831419` bytes. Unpacked tree `385250983` bytes.

`pnpm check:package` (exit 0): `packaging verification passed`. `app.asar` contains `package.json` and `out/` only. The SQLite file is not in the archive.

## Manual Windows check

`safeStorage.isEncryptionAvailable()` was true after ready. A fixed test string round-tripped. A modified ciphertext threw, and the decrypted value was not returned. The probe printed no secret.

Development launch with a temporary `--user-data-dir` created `dev/aurora.sqlite`. The packaged `Aurora.exe`, with a different temporary directory, created `aurora.sqlite` at the profile root. Both files were schema version 1 and contained the five tables above. The processes were then stopped.

`%AppData%\Roaming\aurora` stayed at last write `2026-10-16T18:58:25.7616092Z` with `125` files. `aurora.sqlite` and `dev/aurora.sqlite` were absent there.

The modal startup dialog was not left on screen. Its text is the fixed `PersistenceError` message covered by the startup tests.

## Security

DPAPI protects the ciphertext from another Windows user and from a copy of the database opened under a different profile. It does not protect a refresh token from malware running as the same user. Client ids are not tokens. Secrets are not sent through IPC, `localStorage`, logs, or error messages. `loadExtension` is not enabled.

Sandbox, context isolation, disabled Node integration, web security, the navigation block, and both content security policies are unchanged.

## Deviations

An existing database is validated on a temporary copy so a rejected open does not create `-wal` or `-shm` files beside the original. The copy is deleted in a `finally` block. A crash during that probe can leave the copy in the temporary directory. It does not replace the profile database.

`node:sqlite` is Stability 1.2, release candidate, in the Node version embedded by Electron 44.7.2. Application code uses `DatabaseSync`, `exec`, `prepare`, and `close`, which also exist on Node 22.13.0.

Some defensive branches, including a SQL exception during account deletion and several SQLite primary codes, are outside the tests. The aggregate coverage thresholds still pass.

## Remaining risks

A reset Windows profile or a copied database cannot be decrypted. The account must be connected again by a later OAuth specification. This specification does not delete or rewrite that file.

`app_settings` is empty until a later specification defines keys. Theme migration has to keep a synchronous value for `theme-init.js`.

`quick_check` runs on every open. That cost is small for this schema and should be revisited when a mail cache exists.
