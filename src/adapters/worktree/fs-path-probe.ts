/**
 * Filesystem-backed {@link PathProbe} (DESIGN §6.4). The effectful counterpart to
 * the pure `path-safety.ts`: it performs the `stat`/existence I/O the validator
 * needs, and never throws — a missing or unreadable path simply reports `false`.
 */

import { statSync, existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { PathProbe } from './path-safety'

export const fsPathProbe: PathProbe = {
  isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  looksLikeGitWorktree(path: string): boolean {
    // A linked worktree has a `.git` FILE (gitdir pointer); a primary checkout
    // has a `.git` DIRECTORY. Either presence is enough for this advisory check.
    return existsSync(join(path, '.git'))
  }
}

/**
 * The `canonical` mapping for `assertSafeToDelete` (§6.4) on this host. Linux:
 * `undefined` (plain normalized-string compares, unchanged). macOS: resolve
 * symlinks via the deepest existing ancestor (the candidate may already be
 * gone) and case-fold, since APFS is case-insensitive by default.
 */
export function deleteSafetyCanonicalizer(
  platform: string = process.platform
): ((path: string) => string) | undefined {
  if (platform !== 'darwin') return undefined
  return (path) => realpathDeepest(path).toLowerCase()
}

function realpathDeepest(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return join(realpathDeepest(parent), basename(path))
  }
}
