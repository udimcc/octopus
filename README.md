# Project Octopus

An IDE for running multiple software-development tasks in parallel. Each **task** owns an
isolated git worktree and groups one or more **sessions** (interactive terminals today; a
Jenkins pipeline viewer and more later). See [`PRD.md`](./PRD.md) for product requirements,
[`DESIGN.md`](./DESIGN.md) for the technical architecture, and [`TASKS.md`](./TASKS.md) for the
version-scoped task breakdown.

**Stack:** Electron + React 18 + TypeScript, built with electron-vite. Hexagonal (ports &
adapters) architecture: a pure domain surrounded by pluggable edges (DESIGN §2).

## Status

**V0 — Project Foundation & Bootstrap: complete.** The app boots to an empty React shell with the
three-process split (main / preload / renderer), the hexagonal folder skeleton, tooling, tests, the
dependency-rule lint boundary, and the runtime-environment bootstrap. No V1 features yet (tasks,
sessions, PTYs, persistence, terminals).

## Prerequisites

- **Node 20.17.x**, npm 10.x.
- Internal network access to the Artifactory npm registry (configured in the user's `~/.npmrc`).

## Air-gapped install (important)

We operate on an internal network with **no access to `github.com` or the public npm registry**.

- npm packages resolve through the internal Artifactory npm proxy.
- Electron's Chromium binary is normally downloaded from GitHub releases by `@electron/get`. The
  repo's [`.npmrc`](./.npmrc) redirects that download to the internal Artifactory `github-remote`
  mirror via `electron_mirror`. A plain `npm install` therefore works without GitHub.

```bash
npm install     # pulls the Electron binary from the internal mirror, no GitHub
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Launch the app with HMR (electron-vite dev). |
| `npm run build` | Typecheck, then build all three bundles to `out/`. |
| `npm run build:unpack` | Build + produce an unpacked app under `release/` (Linux `dir` target). |
| `npm run typecheck` | `tsc --noEmit` for both the node and web TS projects. |
| `npm run lint` | ESLint, including the architectural dependency-rule boundary. |
| `npm run format` / `format:check` | Prettier write / check. |
| `npm run test` | Vitest (unit + integration), node + jsdom projects. |

## Project layout

```
src/
  domain/        Pure domain — depends on nothing (empty in V0)
  application/   Use cases + single-writer command loop (empty in V0)
  ports/         Interfaces the application depends on (empty in V0)
  adapters/      Port implementations; V0: env/ (RLIMIT + XDG paths)
  main/          Electron main process + composition root (the only adapter-aware place)
  preload/       The single typed window.octopusAPI contextBridge
  renderer/      React UI
  shared/        Transport-agnostic IPC contract
test/            Integration tests + renderer test setup
```

The **dependency rule** (DESIGN §2 — UI → Application → Domain; adapters depend inward on ports;
only the composition root in `main` knows concrete adapters) is enforced by `eslint-plugin-boundaries`
in [`eslint.config.mjs`](./eslint.config.mjs). A violating import (e.g. `domain` importing `adapters`)
fails `npm run lint`.

## V0 notes & decisions

- **electron-vite pinned to 3.1.0.** electron-vite 4/5 require Node ≥20.19; we run 20.17. 3.1.0 is
  the newest compatible release and pairs cleanly with vite 5.4, `@vitejs/plugin-react` 4.7, and
  vitest 3.2. Bumping Node ≥20.19 later unlocks electron-vite 4/5. (Transitive deps emitting
  `EBADENGINE` warnings on install are harmless.)
- **Electron 33** chosen for stability (bundles Node 20, matches the host). All majors up to 43 are
  mirror-reachable if a bump is wanted.
- **Data locations** (DESIGN §6.3): `src/adapters/env/paths.ts` resolves `$XDG_DATA_HOME/octopus/`
  (Linux, fallback `~/.local/share`) / `%APPDATA%\octopus\` (Windows) — deliberately **not**
  Electron's `app.getPath('userData')` (`~/.config/octopus`, the XDG *config* dir). No consumers yet;
  the DB and log writers land in V1/V2. The directories are created at startup.
- **RLIMIT_NOFILE** (DESIGN §6.1): `src/adapters/env/raise-file-limit.ts` raises the soft open-file
  limit toward 65536 via `prlimit(1)` (Node has no `setrlimit`), before any window/child spawns so
  V1 PTYs inherit it. Raising *soft* up to the existing *hard* limit needs no privilege; best-effort,
  Linux-only, failures are logged and swallowed.

### Deferred to V1+

- **Native modules** (`node-pty`, `better-sqlite3`): `externalizeDepsPlugin` keeps `node_modules`
  external (so their `.node` binaries are not bundled) and `electron-builder.yml` already points at
  the Electron mirror. V1 adds the modules, flips `npmRebuild: true`, and adds `@electron/rebuild`.
- **Packaged installers** (AppImage/deb/…): electron-builder fetches its helper binaries from GitHub.
  Set `ELECTRON_BUILDER_BINARIES_MIRROR` to a verified Artifactory generic repo before building
  those. V0 ships only the unpacked `dir` target, which needs no extra binaries.
