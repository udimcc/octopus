/**
 * The OS layer (see `.claude/rules/os-layer.md`). Every difference between operating
 * systems is recorded here, as data or as a capability key, in one frozen profile per
 * OS (`linux.ts`, `darwin.ts`, `win32.ts`). Code elsewhere never compares OS names: it
 * receives an `OsProfile` (entry points call `hostProfile()` once and pass it down) and
 * reads the member it needs. Mechanisms (lsof vs /proc, keychain vs PEM, …) stay in
 * their adapters and switch on the capability key.
 *
 * Pure: no node, electron or DOM imports, so main, preload, renderer, daemon and cli can
 * all import it.
 *
 * Windows TODO (not yet modelled; today's behaviour on win32 is preserved instead):
 *  - Unix-socket-as-path: `control.sock` and the daemon socket (`daemon-paths.ts`)
 *    would need named pipes.
 *  - chmod modes: `0o700` credentials dir (`paths.ts`), `0o755` scripts.
 *  - Signals / process groups: SIGHUP→SIGKILL grace, `killProcessGroup`.
 *  - The update installer runs via `sh` (`install-update.ts`).
 *  - win32's `update` group, `defaultShell` and `maxUnixSocketPathBytes` copy Linux
 *    (today's "non-darwin = Linux" behaviour), not real Windows values.
 */

export type OsId = 'linux' | 'darwin' | 'win32'
export type PathSeparator = '/' | '\\'
/** `xdg`: `$XDG_DATA_HOME` / `~/.local/share`; `appdata`: `%APPDATA%`. */
export type DataDirBase = 'xdg' | 'appdata'
export type PrimaryModifier = 'Ctrl' | 'Meta'
/** How chord modifiers are shown: `Ctrl+Shift+N` words or `⇧⌘N` glyphs. */
export type ModifierLabels = 'words' | 'glyphs'
/** How a process's cwd is read: `/proc/<pid>/cwd`, `lsof`, or not at all. */
export type CwdProbe = 'proc' | 'lsof' | 'none'
/** Path canonicalization for worktree delete-safety (case-insensitive APFS + symlinks). */
export type PathCanonical = 'exact' | 'realpath-casefold'
/** Where extra trusted CAs come from: a system PEM bundle, the macOS keychain, or none. */
export type CaSource = 'pem-file' | 'keychain' | 'none'
/** Application menu: none (Linux/Windows) or the minimal macOS app menu. */
export type AppMenuKind = 'none' | 'minimal'

export interface OsPaths {
  readonly separator: PathSeparator
  readonly dataDirBase: DataDirBase
  /** Usable Unix socket path bytes (`sun_path` minus the NUL). */
  readonly maxUnixSocketPathBytes: number
}

export interface OsKeyboard {
  /** The modifier app chords are built on: Cmd (`Meta`) on macOS, `Ctrl` elsewhere. */
  readonly primaryModifier: PrimaryModifier
  readonly modifierLabels: ModifierLabels
}

export interface OsTerminal {
  /** Last-resort shell when neither override, setting nor `$SHELL` names one. */
  readonly defaultShell: string
  /** `LANG` set when no locale var is inherited; `null` = never invent one. */
  readonly defaultLang: string | null
  readonly fontFamily: string
  /** xterm `macOptionIsMeta` + `macOptionClickForcesSelection`. */
  readonly optionIsMeta: boolean
  /** Every Meta chord skips xterm (it belongs to the app/menu accelerators). */
  readonly metaChordsSkipPty: boolean
}

export interface OsProc {
  readonly cwdProbe: CwdProbe
  /** Raise RLIMIT_NOFILE via `prlimit` at boot. */
  readonly raiseFileLimit: boolean
  /** Adopt the login shell's PATH/locale at boot (GUI apps start with a bare env). */
  readonly adoptLoginShellEnv: boolean
}

export interface OsFs {
  readonly pathCanonical: PathCanonical
}

export interface OsTls {
  readonly caSource: CaSource
}

export interface OsApp {
  readonly appMenu: AppMenuKind
  /** Set the dock icon for unpackaged (dev) builds. */
  readonly devDockIcon: boolean
}

export interface OsUpdate {
  /** Files (relative to a release dir) that mark a release for this OS. */
  readonly releaseMarkers: readonly string[]
  /** Install script at the release root, run via `sh`. */
  readonly installScript: string
  /** Binary relaunched after a successful install. */
  readonly relaunchExecutable: (home: string, programDir: string) => string
  /** Where releases are published when `settings.updates.dir` is unset. */
  readonly defaultUpdatesDir: (home: string) => string
}

export interface OsProfile {
  readonly id: OsId
  readonly paths: OsPaths
  readonly keyboard: OsKeyboard
  readonly terminal: OsTerminal
  readonly proc: OsProc
  readonly fs: OsFs
  readonly tls: OsTls
  readonly app: OsApp
  readonly update: OsUpdate
}

/** Recursively freeze plain objects/arrays (functions are left as-is). */
export function deepFreeze<T extends object>(o: T): T {
  for (const value of Object.values(o)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value as object)
    }
  }
  return Object.freeze(o)
}
