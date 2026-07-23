/**
 * Filesystem-backed {@link PathProbe} (DESIGN §6.4). The effectful counterpart to
 * the pure `path-safety.ts`: it performs the `stat`/existence I/O the validator
 * needs, and never throws — a missing or unreadable path simply reports `false`.
 */

import { statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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
