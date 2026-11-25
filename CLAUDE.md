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
- `CLAUDE_STATE_PRD.md` — product spec for session/task **status** (states, icons, priority,
  ready-for-review, notifications). Authoritative for status *behavior*.

**Project rules** live in `.claude/rules/` and are binding when they apply:
@.claude/rules/claude-state-prd.md
@.claude/rules/modals-and-overlays.md
@.claude/rules/jira-import.md
@.claude/rules/control-socket.md
@.claude/rules/os-layer.md

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
| `npm run release` | Cut a release: build → stage → `Octopus-<version>-x86_64.tar.gz` (see **Releasing**). |
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
- `cli/` — `octopus-cli` control-socket client (own process); may import only `shared`.
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
with the React plugin. The `main` build has three entries: `index`, `daemon` (`octopusd`) and `cli`
(`out/main/cli.js`, the `octopus-cli` client, run via `ELECTRON_RUN_AS_NODE=1`; dev:
`ELECTRON_RUN_AS_NODE=1 npx electron out/main/cli.js --help` after `npm run build`). See `DESIGN §14`.

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

## Releasing

Octopus ships as a **`tar.gz` + install script**, not an apt package. The `dir` target
already builds offline-of-GitHub; AppImage remains the eventual primary once
`ELECTRON_BUILDER_BINARIES_MIRROR` is pointed at a verified Artifactory generic repo (its
helper binaries come from GitHub — the same deferral noted in `electron-builder.yml`).

**Cut a release:**
1. `npm version <x.y.z>` — bumps `package.json` and creates the `v<x.y.z>` git tag (single
   source of truth; mirrored into `release/${version}/` by electron-builder). Note this is
   the **release/semver** version — distinct from the feature-set integer `CURRENT_VERSION`
   in `src/shared/version.ts` (§10), which gates session types and must not be conflated.
2. `npm run release` (`scripts/release.mjs`) — refuses a dirty/untagged tree, asserts the
   native `.node` binaries are present, runs `build:unpack`, then stages and tars
   `release/<version>/Octopus-<version>-x86_64.tar.gz`. Inside: `octopus-<version>/` with
   the `linux-unpacked/` payload + `install.sh`/`uninstall.sh` + `CHANGELOG.md`.

`resources/octopus-cli` (launcher) is staged next to the `octopus` binary and `resources/claude-skill/octopus/`
is staged alongside; `install.sh` symlinks `octopus-cli` into `~/.local/bin` and copies the skill to
`~/.claude/skills/octopus` (`uninstall.sh` removes both).

**Install (user side):** extract, `cd octopus-<version>`, `./install.sh` — copies the app
to a per-user program dir and symlinks `octopus` into `~/.local/bin`. `uninstall.sh`
reverses it. Neither touches the **data** dir (`~/.local/share/octopus`). The tarball also
carries `icon.png` (staged by `scripts/release.mjs` from `build/icon.png`); `install.sh` adds
a per-user `.desktop` launcher entry and icon-theme icon (both removed by `uninstall.sh`).
`src/renderer/src/assets/octopus.svg` is the icon source — re-run `npm run render:icon` after
editing it.

**Publishing.** Extract the release under `/mnt/scratch/octopus/.incoming/`, then `mv` the
`octopus-X.Y.Z/` dir to `/mnt/scratch/octopus/octopus-X.Y.Z` (an atomic rename on the same
filesystem, so a running app never sees a half-copied release; dot-dirs are ignored by the
checker). It must contain the host profile's `update.releaseMarkers` (`src/shared/os/`): Linux
`install.sh` + `linux-unpacked/octopus`, macOS `install-mac.sh` + `Octopus.app/Contents/MacOS/Octopus`. Running apps find it from there.
**On macOS** the same convention applies in the Egnyte folder `~/Library/CloudStorage/Egnyte-finalisrael/Shared/Installation/octopus`, and a Mac release dir must
contain `install-mac.sh` and `Octopus.app/Contents/MacOS/Octopus`. Each platform only sees its own
releases (`LINUX_RELEASE_MARKERS` / `MAC_RELEASE_MARKERS` in `fs-update-source.ts`). Mac installs
run `install-mac.sh` and relaunch `~/Applications/Octopus.app`. A hidden `updates.dir` key in `settings.json` overrides that
directory (no UI; used for testing against a temp dir).

**In-app self-update.** Main checks the updates dir at boot and hourly (`update-scheduler.ts`); a
strictly newer `octopus-X.Y.Z` shows a popup (main window, once per dismissed version), a title
badge and a Settings tab. Install copies the release to a local staging dir next to the program dir
(`octopus-update-staging`, not /tmp), runs its `install.sh`, then
relaunches from the program dir without the busy-sessions prompt. Daemon-backed shells survive
the restart and re-attach. Dev builds behave the same as packaged ones.

**`install.sh` is a compatibility surface.** Older builds run the *new* release's `install.sh`
non-interactively (no TTY, no prompts), so keep its flags, exit codes and install layout stable.
It stages the payload into `octopus-app.new` and swaps by rename (`octopus-app` -> `.old`, `.new` ->
`octopus-app`), so a failed install leaves the previous one intact. Running it under a live Octopus is
safe because the running app keeps its already-open files and is relaunched promptly (files are not
guaranteed to stay valid under `.old`, which is deleted right after the swap).

**Upgrade/rollback semantics (important).** Installs replace the program dir by atomic rename and
share one data dir, so the DB is the compatibility surface. Migrations are **forward-only and
append-only** (`schema.ts` — add a new `MIGRATION` + bump `SCHEMA_VERSION`, never edit old
DDL). Upgrading auto-migrates (after writing an `octopus.db.bak-v<N>` backup). Rolling back
the binary is safe: an older build that meets a **newer** DB refuses to start with a fatal
dialog (`IncompatibleDbError`) rather than corrupting it — the user runs a newer build or
restores the `.bak`. See `CHANGELOG.md` and `DESIGN §6.3`.

## Version pins to respect

- **electron-vite is pinned to 3.1.0.** v4/5 require Node ≥20.19; the host runs **Node 20.17.x**. Pairs with
  vite 5.4, `@vitejs/plugin-react` 4.7, vitest 3.2. Don't bump these without also bumping Node.
- **Electron 33** (bundles Node 20, matches host). Majors up to 43 are mirror-reachable if a bump is wanted.
- **`build:unpack` runs electron-builder with `NODE_OPTIONS=--experimental-require-module`.** `electron-builder`
  26.x (`app-builder-lib`, compiled CJS) `require()`s `@noble/hashes/blake2.js`, which is ESM-only (`"type":
  "module"`). On **Node 20.17** `require(esm)` is off by default, so the load throws `ERR_REQUIRE_ESM` (the module
  is loaded eagerly even for the `dir` target, which never calls the blockmap code). The flag enables Node's
  own CJS→ESM interop — the same behavior that is **on by default from Node 22.12** — so it becomes a no-op once
  the host's Node is bumped. It is scoped to the electron-builder step only (typecheck/vite don't need it). This
  is the supported fix; do **not** patch `node_modules` or add a `@noble/hashes` `override` (all 2.x are ESM).

## Conventions

- **OS layer** (`.claude/rules/os-layer.md`): every Linux/macOS/Windows difference is `OsProfile` data in
  `src/shared/os/`. Only `hostOs()`/`hostProfile()` (`src/shared/node/os/host.ts`), `rendererOs()` and
  `scripts/lib/host.mjs` read the platform. Lint rejects `process.platform` and OS-name comparisons elsewhere.
- Prettier: no semicolons, single quotes, `printWidth` 100, no trailing commas, 2-space indent. ESLint config
  is flat (ESLint 9) and `eslint-config-prettier` is last so formatting rules don't conflict.
- Data locations (`DESIGN §6.3`) are resolved in `src/adapters/env/paths.ts` to `$XDG_DATA_HOME/octopus/`
  (Linux) / `%APPDATA%\octopus\` (Windows) — **deliberately not** Electron's `app.getPath('userData')` (the XDG
  *config* dir). The resolver is a pure function of `(env, os, home)` so it is unit-testable without
  Electron; the side-effecting `ensureAppDirs` is separate. Follow this pure-resolver / effectful-wrapper split. `paths.ts` also resolves `controlSocketPath`
  (`<dataDir>/control.sock`, §14).
- **Single instance** (`src/main/index.ts`): a relaunch only raises main. Electron keys the lock on `userData`,
  so unpackaged (dev) builds set `userData` to `<dataDir>/electron-dev`: a dev build on the same data dir as the
  running installed app exits (logged), one with its own `XDG_DATA_HOME` runs alongside it.
- **Window groups** (window-view feature): roots are `main` and each `view` window (pinned to one task); a
  secondary belongs to the view named by its `parentWindowId`, else to main. Use `windowGroupRoot`/`viewForTask`
  (`src/application/use-cases/window-groups.ts`, mirrored as store selectors) — never compare `parentWindowId`
  to `MAIN_WINDOW_ID`.
- **Runtime assets for main** live in `resources/` (`icon.png`, `octopus-cli` launcher, `claude-skill/`; the last two are staged by `release.mjs`, not imported), imported with electron-vite's
  `?asset` suffix (typed in `src/main/env.d.ts`). `?asset` does not copy the file into `out/`; it resolves to
  `resources/` at runtime, which is why `electron-builder.yml` packages `resources/**` and the lint boundaries
  rule ignores `resources/**`.
