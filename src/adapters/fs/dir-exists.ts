/**
 * `existsDir(path)` — true iff the path exists and is a directory. Used by
 * startup reconciliation (DESIGN §6.3, I14) to detect a task whose worktree has
 * been removed on disk (→ mark `Stale`). Never throws: a missing path or a
 * permission error is simply "not a usable directory".
 */

import { statSync } from 'node:fs'

export function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
