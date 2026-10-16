# SPEC-000.4 — Quality and Tests

## Status

Implemented under the approval of SPEC-000.4. Parent specification: [SPEC-000-foundation.md](SPEC-000-foundation.md). Previous iteration: [SPEC-000.3-shell.md](SPEC-000.3-shell.md).

## Goal

A quality baseline that can run locally and in GitHub Actions before integrations are added. The existing Electron security settings, IPC contract, navigation, and theme behavior stay as delivered in SPEC-000.1, SPEC-000.2, and SPEC-000.3.

## Tools

Exact `devDependencies`:

| Package                  | Version |
| ------------------------ | ------- |
| `eslint`                 | 10.12.0 |
| `@eslint/js`             | 10.0.1  |
| `typescript-eslint`      | 8.71.2  |
| `eslint-plugin-vue`      | 10.11.1 |
| `vue-eslint-parser`      | 10.4.1  |
| `eslint-config-prettier` | 10.1.8  |
| `prettier`               | 3.9.10  |
| `vitest`                 | 5.0.4   |
| `@vue/test-utils`        | 2.5.1   |
| `happy-dom`              | 21.0.1  |

These versions accept the installed Vite 8.3.4, Vue 3.5.44, TypeScript 5.9.3, and Node 22.13.0. `vue-eslint-parser` is a required peer of `eslint-plugin-vue`. `@vue/compiler-dom` did not need a direct dependency. `@vitest/coverage-v8` is not installed.

ESLint 10.12.0 requires Node `^20.19.0 || ^22.13.0 || >=24`. The package `engines.node` is therefore `>=22.13.0`. The previous floor was `>=22.12.0`.

## Commands

```powershell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm check:build
```

`pnpm test` runs `node:test` on `src/**/*.test.ts`, then Vitest on `src/**/*.spec.ts`. Neither list is maintained by hand.

`pnpm test:coverage` uses Node's coverage reporter. The include list is only:

- `src/main/trusted-sender.ts`
- `src/main/app-info-handler.ts`
- `src/shared/app-info.ts`
- `src/preload/aurora-api.ts`
- `src/renderer/src/aurora-client.ts`

Thresholds, measured before they were enforced: lines 90, functions 90, branches 80. The summary line Node prints as `all files` is that include list, not the application.

## Tests

`*.test.ts` stays on `node:test` for pure TypeScript and security behavior. `*.spec.ts` is Vitest with Vue Test Utils and happy-dom, because Node does not transform `.vue` files. Component specs are included in `tsconfig.web.json` and are type-checked by `vue-tsc`. A `DefineComponent` shim for `*.vue` was tried and rejected: it hid a missing required prop from `vue-tsc`.

Node tests cover the IPC contract, the authorized sender, `theme-init.js` through `node:vm`, and the window and CSP functions the application calls.

`createAuroraWindow` is what `src/main/index.ts` uses to construct the `BrowserWindow`. The test supplies a fake window and checks sandbox, context isolation, disabled Node integration, web security, denied `window.open`, and `will-navigate` calling `preventDefault`. It also checks that the main file calls that function and does not set the insecure literals.

`contentSecurityPolicyPlugin` is what `electron.vite.config.ts` registers. Its handler is `applyContentSecurityPolicy`. The test calls that function for the development and production documents and checks that the production policy has no `unsafe-inline`. `pnpm check:build` then reads `out/renderer/index.html` and checks that the CSP meta is the first element in `head`, that the policy has no `unsafe-inline`, and that every script and stylesheet referenced by the HTML exists and is non-empty. It does not search the bundled JavaScript.

Vitest covers `StatusPanel`, sidebar `aria-current`, the theme radios, Dashboard loading and the safe error text, the integrations empty state, and the unknown-route redirect.

## Formatting

Prettier uses single quotes, semicolons, no trailing commas, width 100, CRLF, and `proseWrap: preserve`. The first format touched existing sources. It did not change security flags, routes, or theme values.

## GitHub Actions

`.github/workflows/quality.yml` runs on `ubuntu-latest` for `push` to `main` and for pull requests. `permissions` is `contents: read`. Node is 22.13.0. `actions/setup-node` sets `package-manager-cache` to false, so it does not look for `pnpm` before the next step installs it. pnpm 12.11.2 is activated afterwards with Corepack 0.36.0. That global install uses `--force` because a Windows runner already has Corepack shims, and a normal install stops on `EEXIST` for `yarn.cmd`. The job runs the commands above. It does not publish, release, or upload artifacts, and it does not read secrets.

The actions are pinned to commits:

- `actions/checkout` at `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` (tag `v5`)
- `actions/setup-node` at `a0853c24544627f65ddf259abe73b1d18a591444` (tag `v5`)

The first run, on commit `4d32276`, failed in Setup Node.js because `package-manager-cache` defaulted to true and `pnpm` was not on `PATH` yet.

## Verification

Host: Windows, Node `v22.13.0`, pnpm `12.11.2`.

`pnpm lint` (exit 0).

`pnpm format:check` (exit 0).

`pnpm typecheck` (exit 0). `tsc` and `vue-tsc` printed no errors.

`pnpm test` (exit 0): Node `45` tests, `13` suites, `0` failures; Vitest `9` tests, `6` files, `0` failures. The `32` tests that existed before this specification are included in the Node count and passed. Node printed `ExperimentalWarning: Type Stripping`, `MODULE_TYPELESS_PACKAGE_JSON`, and `glob`.

`pnpm test:coverage` (exit 0) with the thresholds above:

| Module                              | Lines | Branches | Functions |
| ----------------------------------- | ----- | -------- | --------- |
| `src/main/app-info-handler.ts`      | 100   | 100      | 100       |
| `src/main/trusted-sender.ts`        | 100   | 100      | 100       |
| `src/preload/aurora-api.ts`         | 100   | 100      | 100       |
| `src/renderer/src/aurora-client.ts` | 100   | 100      | 100       |
| `src/shared/app-info.ts`            | 100   | 95.35    | 100       |

`pnpm build` (exit 0): main `4.88 kB`, preload `2.44 kB`, renderer CSS `12.84 kB`, renderer JS `251.76 kB`. Vite still reports that `theme-init.js` is not bundled as a module. That script remains a classic script.

`pnpm check:build` (exit 0): `build output verified`.

## Deviations

`engines.node` is `>=22.13.0` so ESLint 10.12.0 is not installed on a Node release it rejects.

Coverage stays on the five security modules and Node's reporter. `@vitest/coverage-v8` was not kept, so there is no second coverage percentage.

ESLint's TypeScript program does not understand Vue single-file components. A module shim that made those imports type-check also stopped `vue-tsc` from requiring `StatusPanel` props. `no-unsafe-assignment` and `no-unsafe-argument` are disabled only in `src/renderer/src/main.ts` and `src/renderer/src/app/router.ts`. `vue-tsc` still checks the components and the specs.

`no-floating-promises` allows `describe`, `it`, `test`, and `suite` from `node:test`, because those calls return promises by type. `require-await` is off in `*.test.ts` and `*.spec.ts`. `no-control-regex` is off in `src/shared/app-info.ts` because the name check rejects ASCII control characters. `vue/multi-word-component-names` is off for `App.vue`.

## Remaining risks

happy-dom does not prove painted focus rings or the 880px sidebar. `app-info.ts` still has unnamed branches below 100 percent; they are above the 80 percent gate. Node's glob support is experimental.
