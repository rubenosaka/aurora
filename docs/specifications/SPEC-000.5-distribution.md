# SPEC-000.5 — Distribution and Documentation

## Status

Implemented under the approval of SPEC-000.5. Parent specification: [SPEC-000-foundation.md](SPEC-000-foundation.md). Previous iteration: [SPEC-000.4-quality.md](SPEC-000.4-quality.md).

Packaging is complete. The per-user NSIS installer and the unpacked x64 application were produced and checked on this machine.

## Goal

Prepare a per-user Windows installer without changing the Electron security model, the IPC contract, `app.getName()`, or `app.getVersion()`, and without publishing the package.

## Identity

| Property                      | Value                            |
| ----------------------------- | -------------------------------- |
| Application id                | `com.rubenosaka.aurora`          |
| `productName`                 | `aurora`                         |
| Version                       | `0.0.0`                          |
| Executable                    | `Aurora.exe`                     |
| Shortcuts and uninstall label | `Aurora`                         |
| Installer file                | `release/Aurora-Setup-0.0.0.exe` |

`productName` stays `aurora`, so a future packaged build keeps `app.getName()` as `aurora` and application data in `%AppData%\Roaming\aurora`. The Windows version resource ProductName will also say `aurora`, because electron-builder copies `productName` into that resource.

The installer is one-click NSIS for x64, current user only. An assisted installer shows a page that can select a per-machine install. This package does not show that page. The default install directory is `%LocalAppData%\Programs\aurora`.

`deleteAppDataOnUninstall` is false. Uninstallation removes the install directory, the Aurora shortcuts, and the per-user uninstall registration. It leaves `%AppData%\Roaming\aurora` in place.

`signExecutable` is false. `publish` is null. `differentialPackage` is false. There is no auto-update.

## Icon

`win.icon` is `build/icon.ico`. `pnpm package` checks that file before electron-builder starts. A missing file exits with the blocking-prerequisite message. The Electron default icon is not used.

The approved artwork is the 1024×1024 aurora image. The file supplied with a `.ico` name was a JPEG, so `build/icon.ico` was written from that artwork. It contains PNG images at 16, 24, 32, 48, 64, 128, and 256 pixels. The largest image is 256×256, which satisfies electron-builder.

## Package contents

`files` includes `package.json` and `out/**/*`, and excludes maps, tests, environment files, and certificates. `asar` is true. `npmRebuild` and `nodeGypRebuild` are false.

`scripts/package-audit.ts` rejects test files, environment files, certificates, `node_modules`, development directories, and personal or machine-specific paths. `pnpm check:package` applies those rules to `app.asar` and to files outside the archive, and checks that the packaged `package.json` name is `aurora`, the version is `0.0.0`, and `productName` is absent or `aurora`.

`theme-init.test.ts` now lives at `src/renderer/theme-init.test.ts`. `pnpm check:build` fails if `out/` contains a test or spec file.

## Dependencies

| Package            | Version |
| ------------------ | ------- |
| `electron-builder` | 26.17.0 |
| `@electron/asar`   | 4.3.1   |

`pnpm-workspace.yaml` sets `electron-winstaller: false`. That package copies a Squirrel 7-Zip binary during install. The NSIS target does not use it. `electron` remains allowed to build.

`package.json` stays `"private": true`. No `LICENSE` file was added. MIT remains the recommended license after the copyright holder is confirmed.

## Commands

```powershell
pnpm package
pnpm check:package
```

`pnpm package` is the icon check, `pnpm build`, and `electron-builder --win --x64 --publish never`.

## Verification

Host: Windows, Node `v22.13.0`, pnpm `12.11.2`.

`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm test:coverage`, `pnpm build`, and `pnpm check:build` exited 0.

`pnpm test`: Node `49` tests, `14` suites, `0` failures; Vitest `9` tests, `6` files, `0` failures. The Node count includes the previous `45` tests and `4` package-audit tests.

`pnpm test:coverage` for the five security modules, with thresholds 90/90/80:

| Module                              | Lines | Branches | Functions |
| ----------------------------------- | ----- | -------- | --------- |
| `src/main/app-info-handler.ts`      | 100   | 100      | 100       |
| `src/main/trusted-sender.ts`        | 100   | 100      | 100       |
| `src/preload/aurora-api.ts`         | 100   | 100      | 100       |
| `src/renderer/src/aurora-client.ts` | 100   | 100      | 100       |
| `src/shared/app-info.ts`            | 100   | 95.35    | 100       |

The reporter line `all files` is only that include list.

`pnpm build` wrote main `4.88 kB`, preload `2.44 kB`, renderer CSS `12.84 kB`, and renderer JS `251.76 kB`. `pnpm check:build` printed `build output verified`. `out/renderer/theme-init.test.ts` is absent.

`pnpm package` exited 0 with electron-builder 26.17.0, `archs=x64`, `oneClick=true`, and `perMachine=false`. Signing was skipped.

`pnpm check:package` exited 0:

```text
installer: release/Aurora-Setup-0.0.0.exe
installer-bytes: 109825639
unpacked-bytes: 385240965
packaging verification passed
```

`Aurora.exe` is PE machine `0x8664` (x64), 245755904 bytes. The NSIS installer stub is PE machine `0x014C`, which is the normal 32-bit NSIS loader for an x64 payload.

`resources/app.asar` is 275287 bytes and contains only `package.json` and `out/`: the main bundle, the preload bundle, `index.html`, `theme-init.js`, and the renderer assets. The packaged `package.json` has `name` `aurora`, `version` `0.0.0`, and `private` `true`. It has no `productName`. The archive has no tests, environment files, certificates, `node_modules`, or development source. Files beside the archive are the Electron runtime, `LICENSE.electron.txt`, `LICENSES.chromium.html`, and `resources/elevate.exe`. `release/builder-debug.yml` is a local builder log and is gitignored.

## Manual Windows check

The unpacked `Aurora.exe` was started with a temporary `--user-data-dir` and a remote debugging port. It was not pointed at `%AppData%\Roaming\aurora`.

- `app.getInfo()` returned `{ name: "aurora", version: "0.0.0", platform: "win32" }`.
- `window.aurora` exposed only `app`, and `app` exposed only `getInfo`. `ipcRenderer` was not on `window`.
- The document title was `Aurora`. Integrations showed "Integrations will appear here." Settings opened the theme radios. An unknown hash returned to Dashboard.
- Choosing Dark set `data-theme` and `aurora.theme`. Both were still dark after reload.
- The packaged CSP has no `unsafe-inline`.

There was no existing Aurora shortcut. A silent install used `C:\rga\aurora-install-test` and created the desktop shortcut, the Start Menu shortcut, and `Uninstall Aurora.exe`. The installed executable is x64. The silent uninstaller then removed that directory and both shortcuts. No Aurora uninstall key remained under `HKCU`.

`%AppData%\Roaming\aurora` kept the last write time `2026-10-16T15:49:16.2118929Z` and its 116 files. It was not deleted or reset. The installed application was not launched against that directory.

## GitHub Actions

`.github/workflows/package.yml` runs on `windows-latest` for `push` to `main` and for pull requests. `permissions` is `contents: read`. `CSC_IDENTITY_AUTO_DISCOVERY` is false. `actions/setup-node` sets `package-manager-cache` to false, so it does not look for `pnpm` before Corepack installs it. The job runs `pnpm package` and `pnpm check:package`. It does not sign, publish, release, or upload artifacts.

The actions use the same commits as the quality workflow:

- `actions/checkout` at `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09`
- `actions/setup-node` at `a0853c24544627f65ddf259abe73b1d18a591444`

The first run failed in Setup Node.js with the same missing `pnpm` error as the quality workflow, before packaging started. The icon check can pass locally.

## Repository audit

No `.env` file, certificate, or credential is in the project sources. `process.env.ELECTRON_RENDERER_URL` is the electron-vite development URL. Test fixtures use fake `C:\secret\...` paths and are not part of `out/`. `.gitignore` now covers `release/`, environment files, certificates, blockmaps, and `latest.yml`.

## Deviations

The installer is one-click so it cannot offer a per-machine install.

`electron-winstaller` install scripts are explicitly disabled.

The generated Windows version resource will contain `Copyright © <year> aurora` until a copyright string is approved. That string is not a license.

## Unresolved

- The copyright holder is not confirmed, so no `LICENSE` file exists.
- GitHub Actions has not executed the package workflow.
- The default install directory `%LocalAppData%\Programs\aurora` was not used. The install test passed an explicit directory to the installer.
