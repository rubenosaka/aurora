# SPEC-000.2 — Architecture and Secure IPC

## Status

Implemented under the approval of SPEC-000.2. Parent specification: [SPEC-000-foundation.md](SPEC-000-foundation.md). Previous iteration: [SPEC-000.1-bootstrap.md](SPEC-000.1-bootstrap.md).

## Goal

One typed request, `app.getInfo()`, returning the application name, version, and operating system platform. The renderer does not import Electron.

## Channel

`app:get-info` accepts zero arguments. The preload calls `ipcRenderer.invoke` with that channel and nothing else. There is no generic invoke function on `window`.

## Contract

`AppInfo` is exactly `{ name, version, platform }`.

- `name` is a string of 1 to 64 characters without ASCII control characters.
- `version` matches `MAJOR.MINOR.PATCH` with an optional prerelease or build suffix.
- `platform` is one of `aix`, `android`, `cygwin`, `darwin`, `freebsd`, `haiku`, `linux`, `netbsd`, `openbsd`, `sunos`, `win32`.

`IpcResult<AppInfo>` is either `{ ok: true, value }` or `{ ok: false, error: { code } }`. Extra properties are rejected. The error code is `unauthorized`, `invalid-request`, `invalid-response`, or `internal`.

## Sender

A request is authorized only when all of the following are true:

- `event.sender.id` is the `webContents.id` of the Aurora main window this process created.
- `event.senderFrame` exists and is `event.sender.mainFrame`.
- The frame URL is the authorized document.

The development document is `ELECTRON_RENDERER_URL`. The production document is the `file:` URL of `out/renderer/index.html`. `http://localhost:5173` and `http://localhost:5173/` are the same document. A fragment on that document, such as `#/settings`, is still that document. A query string, userinfo, different path, different origin, or different local file is not. A matching URL on another WebContents is not enough, and the main frame of the Aurora window is not enough when the document differs.

## Errors

`AuroraIpcError` carries `code` and a fixed message. Callers use `code`. They do not parse the message.

The preload returns the plain `IpcResult`. It does not throw the original transport error across `contextBridge`, because that bridge copies `message` and `stack` and drops custom fields. A transport failure becomes `{ ok: false, error: { code: 'internal' } }`.

`createRendererAppApi(window.aurora).app.getInfo()` returns `Promise<AppInfo>`. On failure it rejects with `AuroraIpcError` created in the renderer from the envelope code. An unexpected throw from the bridge also becomes `internal`, and the original message is discarded.

## Boundaries

Sandbox, context isolation, disabled Node integration, both Content Security Policies, and the existing navigation block stay as in SPEC-000.1. No router, store, schema library, test runner package, database, or plugin system.

## Tests

`pnpm test` runs `node:test` with Node's type stripping. The package is not `"type": "module"` because the Electron main bundle is CommonJS. Node prints `MODULE_TYPELESS_PACKAGE_JSON` while reparsing the tests as ESM. That warning is expected.

## Verification

Host: Windows, Node `v22.13.0`, pnpm `12.11.2`.

`pnpm test` (exit 0): 26 tests, 7 suites, 0 failures. Node printed `ExperimentalWarning: Type Stripping` and `MODULE_TYPELESS_PACKAGE_JSON` for each file.

`pnpm typecheck` (exit 0): `tsc` and `vue-tsc` printed no errors.

`pnpm build` (exit 0): `out/main/index.js` 4.59 kB, `out/preload/index.js` 2.44 kB, renderer JS 158.50 kB. The built main process still sets `contextIsolation`, `sandbox`, and `webSecurity` to true and `nodeIntegration` to false. The renderer bundle does not reference `ipcRenderer`. The production CSP meta remains the first tag in `<head>`.

`pnpm dev` (exit 0 after the window closed): Vite served `http://localhost:5173/` and logged `[vite] connected.`. The document title was `Aurora`. The page text was `aurora`, `0.0.0`, `win32`. `window.aurora` keys were `app`, and `app` keys were `getInfo`. `ipcRenderer` was not on `window`. `getInfo()` resolved to `{ ok: true, value: { name: "aurora", version: "0.0.0", platform: "win32" } }`. The development CSP was unchanged. The renderer process was started with `--enable-sandbox` on the production check below; development used the same `webPreferences`.

`pnpm start` opened a window titled `Aurora`. That process was stopped after the title check, so it has no clean exit code. The same `electron-vite preview` entry, launched with a remote debugging port, loaded `file:///C:/rga/aurora/out/renderer/index.html`, showed the same page text and IPC result, kept the production CSP, and ran the renderer with `--enable-sandbox`. No Content Security Policy error was printed. Closing that window ended the process with exit code 0.

## Deviation

`contextBridge` does not preserve a custom `code` field on a thrown `Error`, and copying the stack would expose filesystem paths. The preload method therefore returns the plain `IpcResult` and never rethrows the transport error. `createRendererAppApi` is the renderer-facing `app.getInfo(): Promise<AppInfo>`; it rejects with `AuroraIpcError` using the envelope code, not the error message.
