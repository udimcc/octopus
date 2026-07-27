import { describe, it, expect } from 'vitest'
import { WorktreeRef } from './worktree-ref'

const meta = {
  script: '/scripts/create.sh',
  args: ['my-task', 'feature/x'],
  repoRoot: '/repo',
  provisionedAt: 1000
}

describe('WorktreeRef (DESIGN §3.2, I2 immutability)', () => {
  it('holds the path verbatim and optional branch/baseRef', () => {
    const ref = WorktreeRef.create({
      path: '/repo/../worktrees/my-task-abc',
      branch: 'feature/x',
      baseRef: 'origin/main',
      provisionedBy: meta
    })
    expect(ref.path).toBe('/repo/../worktrees/my-task-abc')
    expect(ref.branch).toBe('feature/x')
    expect(ref.baseRef).toBe('origin/main')
    expect(ref.provisionedBy.script).toBe('/scripts/create.sh')
  })

  it('is frozen — assigning a field throws in strict mode (I2)', () => {
    const ref = WorktreeRef.create({ path: '/wt', provisionedBy: meta })
    expect(Object.isFrozen(ref)).toBe(true)
    expect(() => {
      // @ts-expect-error — path is readonly; this must also fail at runtime.
      ref.path = '/other'
    }).toThrow()
  })

  it('freezes the provenance meta and its args array', () => {
    const ref = WorktreeRef.create({ path: '/wt', provisionedBy: meta })
    expect(Object.isFrozen(ref.provisionedBy)).toBe(true)
    expect(Object.isFrozen(ref.provisionedBy.args)).toBe(true)
    expect(() => {
      // @ts-expect-error — args is readonly.
      ref.provisionedBy.args.push('injected')
    }).toThrow()
  })

  it('copies the args array so mutating the source does not leak in', () => {
    const args = ['a', 'b']
    const ref = WorktreeRef.create({ path: '/wt', provisionedBy: { ...meta, args } })
    args.push('c')
    expect(ref.provisionedBy.args).toEqual(['a', 'b'])
  })
})
