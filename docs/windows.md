# Windows distribution

The packaging configuration is `electron-builder.yml`. `pnpm package` runs the production build and electron-builder 26.17.0. `pnpm check:package` reads the installer and the unpacked application.

## Identity

| Property                             | Value                            |
| ------------------------------------ | -------------------------------- |
| Application id                       | `com.rubenosaka.aurora`          |
| Runtime name                         | `aurora`                         |
| Version                              | `0.0.0`                          |
| Executable                           | `Aurora.exe`                     |
| Shortcuts and uninstall display name | `Aurora`                         |
| Installer file                       | `release/Aurora-Setup-0.0.0.exe` |

`productName` stays `aurora`. Electron uses that name for `app.getName()`, so `app.getInfo().name` stays `aurora` and the data directory stays `%AppData%\Roaming\aurora`.

The installer is one-click and per-user. An assisted installer would offer a per-machine choice. This package does not.

## Directories

Installation writes:

- `%LocalAppData%\Programs\aurora`
- A desktop shortcut named Aurora
- A Start Menu shortcut named Aurora
- Per-user uninstall registration under `HKCU`

Uninstallation removes those installation files and shortcuts. `deleteAppDataOnUninstall` is false, so uninstallation leaves `%AppData%\Roaming\aurora` in place. The theme preference `aurora.theme` lives in that directory's session storage.

Launching the installed application uses that same data directory. Verification of the packaged window used a separate profile and did not write to the existing directory.

## Icon

`build/icon.ico` is the approved Aurora icon. It contains 16, 24, 32, 48, 64, 128, and 256 pixel images. If that file is missing, `pnpm package` exits before electron-builder runs. The Electron default icon is not a substitute.

## Signing and updates

The package is unsigned. `signExecutable` is false, and the Windows workflow sets `CSC_IDENTITY_AUTO_DISCOVERY` to false. There is no update feed and no `electron-updater`.

Windows SmartScreen shows "Windows protected your PC" for this installer. The publisher is Unknown. The message means the file has no Authenticode signature and no SmartScreen reputation. It is not a statement that the application is malware. A signed file can show the same style of warning until it gains reputation.

## Package contents

The archive `resources/app.asar` contains `package.json` and `out/`. The check rejects test files, environment files, certificates, `node_modules`, development source, and personal or machine-specific paths. It does not search minified JavaScript for strings.
