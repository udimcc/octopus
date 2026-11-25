# Rule: every OS difference lives in the OS layer

Octopus runs on Linux and macOS, with Windows planned. The differences between them
(Linux / macOS / Windows) live in **one place**: `src/shared/os/`. Don't scatter them
through the code.

## The layer

- `src/shared/os/profile.ts` defines `OsProfile`, with one group per concern:
  `paths`, `keyboard`, `terminal`, `proc`, `fs`, `tls`, `app`, `update`. Each value is
  data or a capability key, e.g. `proc.cwdProbe: 'proc' | 'lsof' | 'none'` or
  `tls.caSource: 'pem-file' | 'keychain' | 'none'`.
- `linux.ts`, `darwin.ts` and `win32.ts` hold one frozen profile each. `osProfile(id)`
  looks a profile up. `toOsId(raw)` maps anything unknown to `linux`.
- The layer is pure (no node, electron or DOM imports), so every process can import it.

## Reading the host OS

Only three places may read the platform. ESLint enforces this (`eslint.config.mjs`):

- `src/shared/node/os/host.ts`: `hostOs()` / `hostProfile()`, for main, preload, the
  daemon and the CLI.
- The renderer calls `rendererOs()` (`src/renderer/src/platform.ts`), which asks the
  preload's `getPlatform()`.
- Build scripts use `scripts/lib/host.mjs`.

Entry points (`main/index.ts`, `daemon/index.ts`, `cli/index.ts`) call `hostProfile()` once
and pass the profile, or the one member they need, down through constructors and deps.
Adapters never read the host themselves.

## Rules

- **Never compare against an OS name** outside `src/shared/os/`. That means no
  `process.platform`, no `=== 'darwin'` and no `case 'win32'`; lint rejects all of them.
  Instead, add or extend a capability in `OsProfile`, give it a value in **all three**
  profiles, and switch on that key.
- **Mechanisms stay in their adapters.** The profile says *which* mechanism to use
  (`'lsof'`). The adapter implements it (`proc-cwd.ts`). Pass the key in, not the profile,
  when that is all the adapter needs.
- **Linux is the reference.** A change for macOS or Windows must leave Linux values
  byte-identical. The golden tests (`keybindings.test.ts`, the settings serialization,
  the state-script hash) and `profiles.test.ts` pin them. Never edit their expected
  values to make a change pass.
- **A new profile key** must be added to the contract key lists in `profiles.test.ts`
  and pinned for each OS there.
- **Tests** build profiles with `osProfile('linux' | 'darwin' | 'win32')`. Real-OS
  integration tests use `hostProfile()`.
- **Exempt:** the embedded python in `octopus-claude-state.script.ts` runs inside
  Claude's hook process, so it probes at runtime (`/proc/self` vs `ps`).
  Windows gaps that are not yet modelled are listed in the `profile.ts` header.
