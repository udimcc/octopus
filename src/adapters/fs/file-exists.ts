/**
 * `existsFile(path)` — true iff the path exists and is a regular file. The file
 * counterpart to {@link ./dir-exists}. Used by `SelectingWorktreeProvider` to
 * probe for a repo-local `create_worktree.sh` / `delete_worktree.sh` (DESIGN
 * §6.4). Never throws: a missing path or permission error is simply "not a file".
 */

import { statSync } from 'node:fs'

export function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
