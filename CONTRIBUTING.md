# Contributing

Aurora follows the specifications in `docs/specifications/`. A change that adds behavior needs a specification that authorizes it. Code and documentation are written in English.

## Checks

From the repository root, with Node.js 22.13 or newer and pnpm 12.11.2:

```powershell
pnpm install
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm check:build
```

`pnpm package` and `pnpm check:package` produce and read the Windows installer. They require `build/icon.ico`.

## Repository contents

Do not commit secrets, credentials, OAuth tokens, certificates, `.env` files, or generated output (`out/`, `release/`). `package.json` stays `"private": true`.

No license file is present. Do not describe the project as MIT-licensed until a license is added and the copyright holder is named. MIT is the recommended license for that decision.
