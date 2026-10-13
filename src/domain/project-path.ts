/**
 * Pure path-identity helper (DESIGN §6.3/§6.4). Produces a comparison key used to tie a
 * task (`worktree.provisionedBy.repoRoot`) to a project (`settings.projects[].path`), so
 * use cases such as `taskMatchesProject` and the project add/remove flows can compare paths
 * without caring how either one was originally spelled (trailing slash, repeated slashes,
 * surrounding whitespace).
 *
 * This exists because the equivalent canonicalizer in the adapter layer
 * (`canonPath` in `src/adapters/worktree/native-git-worktree-provider.ts`) is private and
 * built on `node:path`, which `domain/`/`application/` must not import (DESIGN §2 — the
 * dependency rule is machine-enforced). This helper is lexical only: it does not touch the
 * filesystem, resolve symlinks, or normalize `.`/`..` segments the way `node:path.normalize`
 * does. For the normal case it compares — an absolute path, with or without a trailing
 * slash — it agrees with the adapter's `canonPath`.
 */

export function canonProjectPath(p: string): string {
  const trimmed = p.trim()
  if (trimmed === '') {
    return ''
  }
  const collapsed = trimmed.replace(/\/+/g, '/')
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1)
  }
  return collapsed
}
