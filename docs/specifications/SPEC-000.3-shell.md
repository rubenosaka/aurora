# SPEC-000.3 — Application Shell and Design System

## Status

Implemented under the approval of SPEC-000.3. Parent specification: [SPEC-000-foundation.md](SPEC-000-foundation.md). Previous iteration: [SPEC-000.2-ipc.md](SPEC-000.2-ipc.md).

## Goal

A desktop shell with Dashboard, Integrations, and Settings. Presentation stays in the renderer. Application information still comes from `createRendererAppApi(window.aurora)`.

## Decisions

- Vue Router 4.6.4 with `createWebHashHistory`, because the production document is a `file:` URL.
- Tailwind CSS 4.3.3 and `@tailwindcss/vite` 4.3.3. Utilities read CSS variables, so light and dark swap without a rebuild.
- Icons come from `@lucide/vue` 1.56.0. `lucide-vue-next` 1.0.0 is deprecated by its publisher.
- No Pinia. The theme preference is one module ref. The router owns the route. Dashboard owns its request.
- No shadcn-vue and no Reka UI.
- Integrations is an empty state. The copy is "Integrations will appear here." No provider names and no integration API.
- No new IPC channel, database, or backend.

## Theme

The stored preference is `light`, `dark`, or `system` under `localStorage` key `aurora.theme`. Missing or invalid values resolve to `system`. `system` follows `prefers-color-scheme`. The resolved value is `document.documentElement.dataset.theme`, either `light` or `dark`.

`src/renderer/public/theme-init.js` is a parser-blocking classic script. It sets `data-theme` before the bundled stylesheet and the module script. It is served from the same origin, so production `script-src 'self'` allows it. There is no inline script and no `unsafe-inline` in the production policy.

The window stays hidden until `ready-to-show`. The main process does not read the theme, so `BrowserWindow` has no theme-specific `backgroundColor`. A native frame that does not match the document for one moment is the accepted limit. Teaching main the preference would need storage in the main process or a new IPC channel.

Development (`http://localhost:5173`) and production (`file:`) do not share `localStorage`.

## Navigation

Routes are `/` (Dashboard), `/integrations`, and `/settings`. Any other hash redirects to `/`.

Links are `RouterLink` elements. Tab, Shift+Tab, and Enter use the browser. There is no ArrowUp or ArrowDown handler. The active link has `aria-current="page"`. Focus uses a 2px solid accent outline, offset by 2px.

The theme control is a native radio group named `aurora-theme`.

At 880px and above the sidebar is 232px and shows labels. Below that it is a 64px rail; the labels stay available to assistive technology.

## Status

`StatusPanel` is only for loading, empty, and error. Loading sets `aria-busy`. Empty uses `role="status"`. Error uses `role="alert"`. A successful Dashboard renders the name, version, and platform directly.

## Tokens

The typeface is the system stack `Segoe UI Variable`, `Segoe UI`, `system-ui`, `sans-serif`. No font file is vendored. Spacing stays on the 4px Tailwind scale. Radii are 6px, 10px, and 14px. Content width is at most 720px.

Contrast was measured with the WCAG relative-luminance formula. Normal text needs 4.5:1. The focus ring and the accent control need 3:1 against the adjacent surface. Every pair below passes.

| Pair                    | Light                         | Dark                          |
| ----------------------- | ----------------------------- | ----------------------------- |
| Text on canvas          | 15.80 (`#1c1b19` / `#f6f5f3`) | 15.23 (`#eceae4` / `#141513`) |
| Text on sidebar         | 14.81 (`#1c1b19` / `#efeee9`) | 15.74 (`#eceae4` / `#10110f`) |
| Text on surface         | 16.83 (`#1c1b19` / `#fffcf8`) | 14.08 (`#eceae4` / `#1c1d1a`) |
| Muted on canvas         | 5.16 (`#6b6760` / `#f6f5f3`)  | 6.87 (`#a39e94` / `#141513`)  |
| Muted on sidebar        | 4.84 (`#6b6760` / `#efeee9`)  | 7.10 (`#a39e94` / `#10110f`)  |
| Muted on surface        | 5.50 (`#6b6760` / `#fffcf8`)  | 6.35 (`#a39e94` / `#1c1d1a`)  |
| Accent text on accent   | 8.81 (`#f7f6f3` / `#1f4d45`)  | 8.17 (`#10211d` / `#8fbfb3`)  |
| Focus accent on sidebar | 8.20 (`#1f4d45` / `#efeee9`)  | 9.26 (`#8fbfb3` / `#10110f`)  |
| Focus accent on canvas  | 8.74 (`#1f4d45` / `#f6f5f3`)  | 8.96 (`#8fbfb3` / `#141513`)  |
| Danger on canvas        | 6.69 (`#8f3d32` / `#f6f5f3`)  | 8.56 (`#e3a197` / `#141513`)  |
| Danger on surface       | 7.13 (`#8f3d32` / `#fffcf8`)  | 7.91 (`#e3a197` / `#1c1d1a`)  |

Borders are `#e2dfd8` in light and `#2c2d29` in dark.

## Navigation security

`will-navigate` still calls `preventDefault` for every navigation. Hash changes do not leave the document: in development and in the production `file:` build, clicking Integrations and Settings updated only the fragment, and `location.assign('https://example.com/')` stayed on the Aurora document. No origin-wide exception was added.

Hash routing does change the frame URL fragment. Sender authorization now compares the document with the fragment removed. The WebContents id and the main frame are still required. A query string, userinfo, different path, different origin, or different local file is still rejected. See [SPEC-000.2](SPEC-000.2-ipc.md).

## Verification

Host: Windows, Node `v22.13.0`, pnpm `12.11.2`.

`pnpm test` (exit 0): 32 tests, 9 suites, 0 failures. Node printed `ExperimentalWarning: Type Stripping` and `MODULE_TYPELESS_PACKAGE_JSON`. The sender suite now accepts a fragment on the authorized document and still rejects another path, a query string, and an external origin that only shares the fragment.

`pnpm typecheck` (exit 0): `tsc` and `vue-tsc` printed no errors.

`pnpm build` (exit 0): `out/main/index.js` 4.62 kB, `out/preload/index.js` 2.44 kB, renderer CSS 12.80 kB, renderer JS 251.76 kB. Vite printed that `theme-init.js` cannot be bundled without `type="module"`. That script is intentionally left as a classic script and is copied to `out/renderer/theme-init.js`. The production CSP meta is the first tag in `<head>`, with no `unsafe-inline`. The renderer bundle does not reference `ipcRenderer`.

`pnpm dev` opened a 1120×740 window. The page title was `Aurora`. Dashboard text was `aurora`, `0.0.0`, `win32`. `window.aurora` exposed only `app.getInfo`. `getInfo()` resolved to `{ ok: true, value: { name: "aurora", version: "0.0.0", platform: "win32" } }`. Integrations showed "Integrations will appear here." An unknown hash returned to Dashboard. Tab and Shift+Tab moved between the links. Enter activated Integrations. The focused control had a solid 2px accent outline and `:focus-visible`. The active link used accent `#1f4d45` with text `#f7f6f3` in the light theme. Choosing Dark set `data-theme` and `aurora.theme`, and both survived a reload; the canvas was `rgb(20, 21, 19)`. Choosing System on this machine resolved to light. The development CSP was unchanged, and the console showed `[vite] connected.` with no CSP error. The window used for that corrected session was closed through the debugger. The debugger port went down. That terminal did not record an exit code.

Below 880px the sidebar measured 64px. At the wide width it measured 232px.

`electron-vite preview` with a remote debugging port loaded `file:///C:/rga/aurora/out/renderer/index.html#/`. The production CSP matched the policy above. The same navigation, theme persistence, focus ring, and IPC result held. The renderer process was started with `--enable-sandbox`. No CSP message was printed. Closing that window is recorded with the preview process.

`pnpm start` (exit 0) opened the production window. Its title was `Aurora`. The window was closed from the shell, and the preview process exited 0. The DOM, CSP, sandbox, and IPC checks above used the same preview entry with a remote debugging port, because `pnpm start` does not receive that port.

A browser tab on the Vite server, which has no preload, showed the Dashboard error "Application information is unavailable" / "Request failed." That tab is not the Electron sandbox. It was used to click the shell, switch themes, and check the narrow sidebar.

## Deviations

`@lucide/vue` 1.56.0 replaces the deprecated `lucide-vue-next` 1.0.0. The publisher points Vue applications at `@lucide/vue`.

`theme-init.js` repeats the storage key and the light/dark/system rule in plain JavaScript so the first paint does not wait for the module bundle. `theme.ts` remains the tested source used after startup.

The sender comparison ignores only the fragment. SPEC-000.2 originally rejected every URL that contained a hash, which made `app.getInfo()` return `unauthorized` on `#/`, `#/integrations`, and `#/settings`.
