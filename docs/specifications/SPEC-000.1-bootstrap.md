# SPEC-000.1 — Bootstrap and Toolchain

## Status

Implemented under the conditional approval of SPEC-000.1. Parent specification: [SPEC-000-foundation.md](SPEC-000-foundation.md).

## Goal

A single-package Electron application that typechecks, builds, and opens a window titled Aurora on Windows. No product shell.

## Toolchain

Host requirement: Node.js `>=22.12.0`. This machine verified `v22.13.0`.

Package manager: `pnpm@12.11.2`, pinned with `packageManager` and activated through Corepack. pnpm 12 supports this Node 22 line. The previously installed global pnpm was `9.15.4` and is not the version the repository uses.

| Package            | Version | Role                                                       |
| ------------------ | ------- | ---------------------------------------------------------- |
| electron           | 44.7.2  | Desktop runtime. Bundles Node.js 24.21.0 and Chromium 152. |
| electron-vite      | 6.0.0   | Dev server and build for main, preload, and renderer       |
| vite               | 8.3.4   | Bundler used by electron-vite                              |
| @vitejs/plugin-vue | 6.0.10  | Vue single-file component support                          |
| vue                | 3.5.44  | Renderer UI runtime, bundled into the renderer output      |
| typescript         | 5.9.3   | Typecheck for main, preload, and config                    |
| vue-tsc            | 3.3.13  | Typecheck for Vue single-file components                   |
| @types/node        | 24.19.2 | Types for the Node 24 line embedded in Electron 44         |

TypeScript 7.0.2 is rejected. `vue-tsc@3.3.13` still needs the TypeScript 5.9/6 programmatic API, and TypeScript 7.0 does not export `./lib/tsc`.

`@types/node` 26 is rejected. It describes a newer Node than the one Electron 44 ships.

## Why these packages are devDependencies

Electron-vite bundles Vue into `out/renderer`. The production preview runs the Electron binary and those built files. It does not start a Node server that imports `vue`, `vite`, or `typescript` from `node_modules`. Keeping them in `devDependencies` matches that layout: a production install of the npm package is not how Aurora is launched. `pnpm build` must succeed, and `pnpm start` must open the built window, which is the production check for this iteration.

There is no `dependencies` field. Nothing is left for a future installer to copy as an unpacked runtime module.

## pnpm build scripts

pnpm 12 removed `onlyBuiltDependencies`. With `packageManager` pinned, writing that key in `pnpm-workspace.yaml` fails as an unrecognized setting. The supported replacement is `allowBuilds`.

`pnpm-workspace.yaml` allows the `electron` package to run build scripts. Electron 44.7.2 no longer ships a dependency `postinstall`, so that approval does not download the binary by itself. The project `postinstall` script runs the package bin `install-electron`, which is the download path Electron documents for this release. No other dependency build is approved. `packages` is omitted, so the workspace contains only this repository root.

The deprecated `pnpm` field in `package.json` is not used.

## Security controls in this iteration

`BrowserWindow` sets:

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `webSecurity: true`

The preload bundle is CommonJS and exports nothing. No `ipcMain`, no `contextBridge`, and no API on `window`.

New windows are denied. In-page navigations are cancelled. The initial `loadURL` / `loadFile` is unaffected because Electron does not emit `will-navigate` for those calls.

## Content Security Policy

A Vite plugin injects one policy as the first element in `<head>`, after other HTML transforms (`order: 'post'`). A meta policy that follows a script does not apply to that script. Development is detected with `ctx.server`, which is set only while the Vite dev server is running.

Development, so Vite HMR can connect:

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'none'
```

`style-src 'unsafe-inline'` is limited to development because Vue's dev transform inserts style elements. Scripts stay on `'self'`: the Vite client is a same-origin module, not an inline script.

Production drops the websocket origins and inline styles:

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'none'
```

The renderer `base` is `./` so built asset URLs resolve under `file://`.

## Layout

```text
electron.vite.config.ts
package.json
pnpm-workspace.yaml
tsconfig.json
tsconfig.node.json
tsconfig.web.json
src/main/index.ts
src/preload/index.ts
src/renderer/index.html
src/renderer/src/main.ts
src/renderer/src/App.vue
src/renderer/src/env.d.ts
```

Not created: `LICENSE`, router, Pinia, database, backend, plugins, installer, ESLint, Prettier, electron-builder, `@electron-toolkit/*`, and empty Clean Architecture directories.

## Scripts

- `pnpm install`
- `pnpm typecheck`
- `pnpm build`
- `pnpm dev`
- `pnpm start` (production preview of `out/`)

## Deviations

1. SPEC-000's original body was not in the repository or the searched local trees. [SPEC-000-foundation.md](SPEC-000-foundation.md) records only constraints that were stated and approved. Unseen requirements were not filled in.
2. `onlyBuiltDependencies` is not valid on pnpm 12.11.2. The supported key is `allowBuilds.electron: true`. Electron 44.7.2 has no dependency lifecycle script, so the binary is downloaded by the project `postinstall`.
3. The official electron-vite Vue template sets `sandbox: false` and registers a sample IPC channel. This iteration does neither.
4. No license is declared.
5. Node 22.13.0 ships Corepack 0.30.0, which rejects the signature of pnpm 12.11.2 (`Cannot find matching keyid`). Corepack 0.36.0 was installed globally on this machine and then activated pnpm 12.11.2. Corepack 0.36.0 declares `node: ^22.22.2 || ^24.15.0 || >=26.0.0` and printed `EBADENGINE` on Node 22.13.0, then ran successfully.
6. The preload bundle is an empty CommonJS file. `export {}` was tree-shaken. Electron still loaded it with `sandbox: true`.
7. Launching the app created `%AppData%\Roaming\aurora`. That directory is outside the repository.

## Verification

Host: Windows, Node `v22.13.0`, pnpm `12.11.2`.

`pnpm install` after a clean `node_modules` (exit 0):

```text
Progress: resolved 94, reused 94, downloaded 0, added 94, done
. postinstall$ install-electron
. postinstall: Done
Done in 14.3s using pnpm v12.11.2
```

`node_modules/electron/dist/electron.exe` was present (245,589,504 bytes). `path.txt` contains `electron.exe`.

`pnpm typecheck` (exit 0): `tsc --noEmit` and `vue-tsc --noEmit` printed no errors.

`pnpm build` (exit 0): wrote `out/main/index.js`, `out/preload/index.js`, and `out/renderer/` (`index.html`, one CSS asset, one JS asset, 152.99 kB). The renderer bundle does not contain a bare `vue` import. Built asset URLs are relative (`./assets/...`). The production CSP meta is the first tag in `<head>`.

`pnpm dev` (exit 0 after the window was closed): Vite reported `http://localhost:5173/`, then `starting electron app...`. The renderer console logged `[vite] connected.`. The page title and body text were `Aurora`. The document policy was the development policy, including the localhost websocket allowance and `style-src 'unsafe-inline'`. Closing the window with `WM_CLOSE` ended the process with exit code 0.

`pnpm start` (exit 0 after the window was closed): electron-vite rebuilt `out/` and started Electron. The window title was `Aurora`. Closing it with `WM_CLOSE` ended the process with exit code 0. A second preview of the same production output, with a remote debugging port, loaded `file:///C:/rga/aurora/out/renderer/index.html`. Title and body text were `Aurora`. The document policy was the production policy, with no websocket origins and no `'unsafe-inline'`. The renderer process command line included `--enable-sandbox`. No Content Security Policy console error was printed. Closing that window also exited 0.
