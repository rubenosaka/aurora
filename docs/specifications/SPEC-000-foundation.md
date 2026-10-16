# SPEC-000 — Foundation

## Status

Accepted constraints for Aurora. This file was absent from the repository when SPEC-000.1 began. The text below transcribes only requirements stated in the approved assignment and in the conditional approval of SPEC-000.1. It does not add product behavior, screens, data models, or integrations.

## Product

Aurora is an open-source desktop application. The GitHub repository is public. The npm package stays private so it cannot be published by accident.

## Method

The project follows Spec Driven Development, Clean Architecture, and SOLID. Specifications live in `docs/specifications/`. An iteration must not invent requirements that its parent specification does not contain, and must not create empty architectural layers ahead of a specification that needs them.

Code and documentation are written in English.

## Stack

The approved toolchain is Electron, Vue 3, TypeScript, electron-vite, and pnpm.

## Security and privacy

- The repository must not contain secrets, personal data, credentials, or real API tokens.
- Renderer isolation stays on: `sandbox`, `contextIsolation`, and `webSecurity` are true, and `nodeIntegration` is false.
- Electron security controls are not disabled to work around build or development problems.
- A Content Security Policy is required for development and production. The development policy may allow Vite HMR. The production policy must not keep that allowance.
- No license file is present, and the project must not be described as MIT-licensed, until a license is explicitly adopted.

## Boundaries

Later specifications must authorize any of the following before it is implemented: a backend, a database, a plugin system, an installer, application routing, a state library, OAuth, or any external integration. SPEC-000 does not define those capabilities.
