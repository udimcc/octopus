# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Project Octopus — a desktop **IDE for running multiple development tasks in parallel**. Each **task**
owns an isolated git worktree and groups one or more **sessions** (interactive terminals today; a Jenkins
pipeline viewer later). Stack: **Electron + React 18 + TypeScript**, built with **electron-vite**.

Three source-of-truth docs govern all work — read the relevant one before changing behavior:
- `PRD.md` — product requirements (what the app does).
- `DESIGN.md` — the technical architecture. **Sections are cited throughout the code** (e.g. `DESIGN §6.4`);
  when a comment references a `§`, that section is the authority for the decision.
- `TASKS.md` — version-scoped task breakdown with `[ ]`/`[~]`/`[x]` status.

## Current status: V0 (foundation only)

The app boots to an empty React shell. **No V1 features exist yet** — no tasks, sessions, PTYs, persistence,
or terminals. The IPC surface is a single `ping` health check. Most `src/` layer folders contain only
`.gitkeep`. When implementing, consult `TASKS.md` for the version-scoped plan and `DESIGN.md §10` for the
roadmap principle: **define interfaces/enums in V1; add implementations in V2/V3 — signatures never change
across versions.** V1 leaves explicit dormant "seams" (documented in `src/shared/ipc.ts` and `DESIGN §10`)
that V2/V3 fill, so later versions stay additive rather than rewrites.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Launch the app with HMR (needs a display; it's a GUI Electron app). |
| `npm run build` | `typecheck` then build all three bundles to `out/`. |
| `npm run build:unpack` | Build + unpacked app under `release/` (Linux `dir` target only). |
| `npm run typecheck` | `typecheck:node` + `typecheck:web` (two separate TS projects — see below). |
| `npm run lint` / `lint:fix` | ESLint, **including the architectural dependency-rule boundary**. |
| `npm run format` / `format:check` | Prettier. |
| `npm run test` | Vitest, both projects, once. |
| `npm run test:watch` | Vitest watch mode. |
| `npm run test:coverage` | Vitest with v8 coverage. |

Run a single test file: `npx vitest run src/adapters/env/paths.test.ts`
Run tests matching a name: `npx vitest run -t "idempotent"`

## Architecture: hexagonal, with a hard dependency rule

The design is **Ports & Adapters** (`DESIGN §2`): a pure domain surrounded by pluggable edges. The layout under
`src/` maps 1:1 to layers, and the **dependency rule is machine-enforced by `eslint-plugin-boundaries`** in
`eslint.config.mjs` — a violating import fails `npm run lint`, not just review. Allowed dependencies:

- `domain/` — pure; may import **nothing** but itself.
- `ports/` — interfaces the application needs; may import `domain`.
- `application/` — use cases + the single-writer command loop; may import `application`, `ports`, `domain`.
- `adapters/` — concrete port implementations; may import `adapters`, `ports`, `domain`, `shared`.
- `main/` — Electron main process **and the composition root**; the *only* layer allowed to import `adapters`
  (plus `application`, `ports`, `domain`, `shared`). Wiring concrete adapters to ports happens here and
  nowhere else (`src/main/composition-root.ts`).
- `preload/` — the single typed `window.octopusAPI` contextBridge; may import only `shared`.
- `renderer/` — React UI; may import `renderer`, `application`, `shared` (**never** adapters or ports directly).
- `shared/` — transport-agnostic IPC contract (`src/shared/ipc.ts`); may import only `shared`.

**Consequences when adding code:** put OS/framework/IO code behind a port + adapter; keep domain logic free of
Electron/node/React imports; register new adapters only in the composition root. The renderer talks to the
backend exclusively through `window.octopusAPI` (defined by the `OctopusAPI` interface in `src/shared/ipc.ts`,
implemented in `src/preload/index.ts`, handled in the main process). Keeping the message set in `shared/`
transport-agnostic is deliberate: `DESIGN §6.2/§6.5` plans a V2 durable-session daemon that carries the same
protocol over a Unix socket unchanged.

### Three processes, two TS projects, two test projects

The build produces **three bundles**, one per Electron process (`electron.vite.config.ts`): `main` and
`preload` build as Node (with `externalizeDepsPlugin` so `node_modules` stay unbundled — this is what lets V1's
native modules `node-pty`/`better-sqlite3` ship their `.node` binaries), `renderer` builds as a browser context
with the React plugin.

Because the two runtimes differ, the repo has **two TS configs** and typechecks each separately:
- `tsconfig.node.json` — main, preload, and the process-agnostic layers (domain/application/ports/adapters),
  shared, and tests. Node types, ES2023 lib.
- `tsconfig.web.json` — renderer + shared. DOM lib, `react-jsx`, `vite/client` types.

Vitest mirrors this with **two projects** (`vitest.config.ts`): a `node` project (`environment: 'node'`, all
`*.test.ts` outside `renderer/`) and a `renderer` project (`environment: 'jsdom'`, `src/renderer/**/*.test.{ts,tsx}`,
with `test/setup-renderer.ts` adding jest-dom matchers). **Tests live next to the code** (`*.test.ts[x]`);
`test/integration/` holds cross-cutting integration tests.

## Air-gapped environment (important)

This runs on an internal network with **no access to `github.com` or the public npm registry**. `.npmrc`
redirects everything to the internal Artifactory: npm packages via the npm proxy, and Electron's Chromium
binary (normally from GitHub releases) via `electron_mirror` → the `github-remote` mirror. A plain `npm install`
therefore works offline-of-GitHub. Do **not** introduce dependencies or build steps that fetch from GitHub or
the public registry at build or runtime. `EBADENGINE` warnings on install are harmless (see below).

`electron-builder.yml` mirrors the Electron download similarly and currently ships only the Linux `dir` target
(`npmRebuild: false`); packaged installers (AppImage/deb) need `ELECTRON_BUILDER_BINARIES_MIRROR` pointed at a
verified Artifactory generic repo first — deferred to V1+.

## Version pins to respect

- **electron-vite is pinned to 3.1.0.** v4/5 require Node ≥20.19; the host runs **Node 20.17.x**. Pairs with
  vite 5.4, `@vitejs/plugin-react` 4.7, vitest 3.2. Don't bump these without also bumping Node.
- **Electron 33** (bundles Node 20, matches host). Majors up to 43 are mirror-reachable if a bump is wanted.

## Conventions

- Prettier: no semicolons, single quotes, `printWidth` 100, no trailing commas, 2-space indent. ESLint config
  is flat (ESLint 9) and `eslint-config-prettier` is last so formatting rules don't conflict.
- Data locations (`DESIGN §6.3`) are resolved in `src/adapters/env/paths.ts` to `$XDG_DATA_HOME/octopus/`
  (Linux) / `%APPDATA%\octopus\` (Windows) — **deliberately not** Electron's `app.getPath('userData')` (the XDG
  *config* dir). The resolver is a pure function of `(env, platform, home)` so it is unit-testable without
  Electron; the side-effecting `ensureAppDirs` is separate. Follow this pure-resolver / effectful-wrapper split.
