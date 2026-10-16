# Aurora

Desktop application. SPEC-000.1 bootstraps the Electron window. SPEC-000.2 reads the application name, version, and platform through one typed IPC method. SPEC-000.3 adds the application shell: Dashboard, Integrations, and Settings, with a light, dark, or system theme stored in the browser.

The GitHub repository is public. `package.json` sets `"private": true`, so the package cannot be published to npm by accident.

No license has been adopted. This repository is not MIT-licensed. MIT is the recommended license once the copyright holder is confirmed. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Requirements

- Node.js 22.13 or newer
- pnpm 12.11.2, selected by the `packageManager` field

Enable Corepack once, then install from the repository root:

```powershell
corepack enable
corepack prepare pnpm@12.11.2 --activate
pnpm install
```

Node.js 22.13 ships Corepack 0.30.0, which cannot verify the pnpm 12.11.2 package signature. Update Corepack before `corepack prepare` if it reports `Cannot find matching keyid`. Corepack 0.36.0 does verify that release. It warns that it prefers Node.js 22.22.2 or newer, and it still activated pnpm 12.11.2 on Node.js 22.13.0.

`pnpm install` runs `install-electron`, which downloads the Electron binary into `node_modules`. Electron 44 does not do that from its own dependency lifecycle script.

## Scripts

```powershell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm check:build
pnpm package
pnpm check:package
pnpm dev
pnpm start
```

`pnpm dev` starts the Electron window with the Vite dev server. `pnpm build` writes the bundled application to `out/`. `pnpm check:build` reads that output. `pnpm start` opens the production build. `pnpm test` runs the Node tests and the Vue component tests. `pnpm package` builds the Windows installer. It stops when `build/icon.ico` is missing. The approved icon is `build/icon.ico`. `pnpm check:package` reads `release/`.

## Windows packaging

The installer is a per-user NSIS package for x64. The application id is `com.rubenosaka.aurora`. The runtime name stays `aurora`, so application data stays in `%AppData%\Roaming\aurora`. The executable, shortcuts, and installer file use the name Aurora. The installer does not remove that data directory. There is no code signing and no auto-update.

`build/icon.ico` is required. Packaging does not substitute the Electron icon. Windows SmartScreen shows "Windows protected your PC" for an unsigned installer, with publisher Unknown. Details are in [docs/windows.md](docs/windows.md).

Vue, Vite, TypeScript, and Electron are `devDependencies`. electron-vite bundles the renderer into `out/`, and the preview runs that output with the Electron binary. There is no Node server importing those packages at runtime.

## Specifications

- [SPEC-000 — Foundation](docs/specifications/SPEC-000-foundation.md)
- [SPEC-000.1 — Bootstrap and Toolchain](docs/specifications/SPEC-000.1-bootstrap.md)
- [SPEC-000.2 — Architecture and Secure IPC](docs/specifications/SPEC-000.2-ipc.md)
- [SPEC-000.3 — Application Shell and Design System](docs/specifications/SPEC-000.3-shell.md)
- [SPEC-000.4 — Quality and Tests](docs/specifications/SPEC-000.4-quality.md)
- [SPEC-000.5 — Distribution and Documentation](docs/specifications/SPEC-000.5-distribution.md)
