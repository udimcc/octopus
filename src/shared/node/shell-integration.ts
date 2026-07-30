/**
 * OSC 133 shell-integration injection (DESIGN §9.1 baseline, §12.1). This is the
 * **opt-out auto-injection** that makes phase-2 Waiting/Working icons work in any
 * terminal without the user hand-editing their shell rc: Octopus launches bash/zsh
 * against a generated rcfile that (1) sources the user's OWN interactive rc first —
 * never editing `~/.bashrc`/`~/.zshrc` — and (2) emits OSC 133 semantic prompt marks
 * (`A` prompt-start, `B` prompt-end, `C` command-start, `D;<exit>` command-end). The
 * {@link OscParser} maps `C` → Working and `A`/`D` → Waiting (Layer 2, structural),
 * far more reliable than tpgid polling for the exact transition moment.
 *
 * ## Why a generated rcfile (not editing the user's rc)
 * `--rcfile`/`ZDOTDIR` point the shell at OUR file, which sources the user's real rc.
 * The user's config is untouched on disk and survives an Octopus uninstall. Bash
 * IGNORES `--rcfile` for a LOGIN shell, so the bash path spawns an INTERACTIVE
 * (`-i`, not `-l`) shell; the generated rc replays what a login+interactive bash
 * would load by sourcing the user's `~/.bashrc` (via `$OCTOPUS_USER_BASHRC`). Zsh
 * honours `$ZDOTDIR`, so the zsh path sets it to our dir (remembering the user's
 * prior value in `$OCTOPUS_USER_ZDOTDIR`) and our `.zshrc` sources the user's files
 * then restores `$ZDOTDIR`.
 *
 * ## Scope
 * Only bash and zsh are auto-integrated ({@link resolveShellFamily}); every other
 * shell (fish, sh, …) is spawned unchanged as a login shell (`-l`) with no injection
 * — the at-prompt sentinel then relies on tcgetpgrp alone (OSC 133 just sharpens it),
 * exactly as when the user opts out. Claude's explicit signals are unaffected either
 * way. Gating on `terminal.stateDetection` happens in the session managers, not
 * here (this module is a pure text/args generator + effectful file writer, mirroring
 * the paths.ts resolver/wrapper split).
 *
 * Lives in `shared/node` (uses `node:fs`) so BOTH backends — the in-process PTY
 * manager and the out-of-process `octopusd` daemon — build the same args from the
 * same code (the daemon may import only `shared`, never `adapters`).
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

/** The shells Octopus knows how to inject OSC 133 into; everything else passes through. */
export type ShellFamily = 'bash' | 'zsh' | 'other'

/** Absolute paths to the generated integration files (written by {@link ensureShellIntegrationFiles}). */
export interface ShellIntegrationFiles {
  /** The bash rcfile passed via `--rcfile`. */
  readonly bashRcPath: string
  /** The dir set as `$ZDOTDIR` for zsh (holds the generated `.zshrc`). */
  readonly zshDotDir: string
}

/** How to launch a shell: extra argv plus env vars to layer onto the child env. */
export interface ShellSpawnPlan {
  readonly args: readonly string[]
  readonly envPatch: Readonly<Record<string, string>>
}

/**
 * Classify a shell path by its basename (`/bin/bash` → `bash`, `/usr/bin/zsh` →
 * `zsh`). Only an exact basename match integrates; anything else is `other`.
 */
export function resolveShellFamily(shell: string): ShellFamily {
  const name = basename(shell)
  if (name === 'bash') {
    return 'bash'
  }
  if (name === 'zsh') {
    return 'zsh'
  }
  return 'other'
}

/**
 * The generated bash rcfile: source the user's interactive rc, then wire OSC 133
 * via a DEBUG trap (command-start `C`) + PROMPT_COMMAND (command-end `D;<exit>`) +
 * PS1 markers (`A` prompt-start / `B` prompt-end). The `__octopus_at_prompt` flag
 * fires `C` exactly once per typed command — never for the PROMPT_COMMAND functions
 * themselves. Interactive-only guard keeps it inert if the file is ever sourced by
 * a non-interactive shell.
 */
export function bashIntegrationScript(): string {
  return `# Octopus terminal shell integration (OSC 133 semantic prompts) — generated, do not edit.
# Loaded via \`bash --rcfile\`; sources your own interactive rc first, then adds prompt marks.
case "$-" in *i*) ;; *) return ;; esac

if [ -n "$OCTOPUS_USER_BASHRC" ] && [ -r "$OCTOPUS_USER_BASHRC" ]; then
  . "$OCTOPUS_USER_BASHRC"
elif [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

__octopus_preexec() {
  # DEBUG fires before every command; emit command-start once per typed command.
  if [ -n "$__octopus_at_prompt" ]; then
    unset __octopus_at_prompt
    printf '\\033]133;C\\007'
  fi
}
__octopus_precmd() {
  printf '\\033]133;D;%s\\007' "$?"
  __octopus_at_prompt=1
}
trap '__octopus_preexec' DEBUG
PROMPT_COMMAND="__octopus_precmd\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
PS1="\\[\\033]133;A\\007\\]$PS1\\[\\033]133;B\\007\\]"
`
}

/**
 * The generated zsh `.zshrc` (loaded because we set `$ZDOTDIR` to its dir): source
 * the user's real startup files from `$OCTOPUS_USER_ZDOTDIR` (or `$HOME`), restore
 * `$ZDOTDIR` so later spawns see the user's value, then register OSC 133 via zsh's
 * native `precmd`/`preexec` hooks + a PS1 prompt-end marker.
 */
export function zshIntegrationScript(): string {
  return `# Octopus terminal shell integration (OSC 133 semantic prompts) — generated, do not edit.
# Loaded via $ZDOTDIR; sources your own zsh startup files first, then adds prompt marks.
() {
  local udir="\${OCTOPUS_USER_ZDOTDIR:-$HOME}"
  [ -r "$udir/.zshenv" ] && source "$udir/.zshenv"
  [ -r "$udir/.zshrc" ]  && source "$udir/.zshrc"
}
if [ -n "$OCTOPUS_USER_ZDOTDIR" ]; then
  export ZDOTDIR="$OCTOPUS_USER_ZDOTDIR"
else
  unset ZDOTDIR
fi

autoload -Uz add-zsh-hook 2>/dev/null
__octopus_precmd() { print -rn -- $'\\033]133;D;'"$?"$'\\007\\033]133;A\\007'; }
__octopus_preexec() { print -rn -- $'\\033]133;C\\007'; }
if whence add-zsh-hook > /dev/null 2>&1; then
  add-zsh-hook precmd __octopus_precmd
  add-zsh-hook preexec __octopus_preexec
fi
PS1="%{"$'\\033]133;B\\007'"%}$PS1"
`
}

/**
 * The argv + env patch to launch `shell` with OSC 133 integration, given the child
 * env (read for `HOME`/`ZDOTDIR`). Bash → interactive `--rcfile` (login is
 * incompatible with `--rcfile`); zsh → `-i` with `$ZDOTDIR` redirected; every other
 * shell → the unchanged login default `-l` with no patch (no injection).
 */
export function shellSpawnPlan(
  shell: string,
  files: ShellIntegrationFiles,
  env: Readonly<Record<string, string | undefined>>
): ShellSpawnPlan {
  switch (resolveShellFamily(shell)) {
    case 'bash': {
      const home = env.HOME
      const envPatch: Record<string, string> = {}
      if (home) {
        envPatch.OCTOPUS_USER_BASHRC = join(home, '.bashrc')
      }
      return { args: ['--rcfile', files.bashRcPath, '-i'], envPatch }
    }
    case 'zsh': {
      const envPatch: Record<string, string> = { ZDOTDIR: files.zshDotDir }
      // Remember the user's prior $ZDOTDIR so the generated .zshrc can source their
      // real files and restore it. Absent ⇒ the script falls back to $HOME.
      if (env.ZDOTDIR !== undefined && env.ZDOTDIR.length > 0) {
        envPatch.OCTOPUS_USER_ZDOTDIR = env.ZDOTDIR
      }
      return { args: ['-i'], envPatch }
    }
    default:
      return { args: ['-l'], envPatch: {} }
  }
}

/**
 * Write the generated integration files under `dir` and return their paths. Creates
 * `dir/` and `dir/zsh/` as needed (the ZDOTDIR must be a directory holding `.zshrc`).
 * Idempotent — rewriting the same content on every boot is cheap and keeps the files
 * current across upgrades. Throws on an I/O failure; the composition root treats a
 * failure as "no integration" and falls back to a plain login shell.
 */
export function ensureShellIntegrationFiles(dir: string): ShellIntegrationFiles {
  const bashRcPath = join(dir, 'octopus.bashrc')
  const zshDotDir = join(dir, 'zsh')
  mkdirSync(zshDotDir, { recursive: true })
  writeFileSync(bashRcPath, bashIntegrationScript(), 'utf8')
  writeFileSync(join(zshDotDir, '.zshrc'), zshIntegrationScript(), 'utf8')
  return { bashRcPath, zshDotDir }
}
