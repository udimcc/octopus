import { describe, it, expect, vi } from 'vitest'
import { SelectingWorktreeProvider, type ScriptProbe } from './selecting-worktree-provider'
import { CREATE_SCRIPT_NAME, DELETE_SCRIPT_NAME } from './script-worktree-provider'
import type {
  WorktreeProvider,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  RemoveWorktreeRequest
} from '../../ports/worktree-provider'
import { asTaskId } from '../../domain/ids'

/** A stub delegate that records the calls it received and returns a fixed result. */
function stubProvider(
  tag: string
): WorktreeProvider & { creates: CreateWorktreeRequest[]; removes: RemoveWorktreeRequest[] } {
  const creates: CreateWorktreeRequest[] = []
  const removes: RemoveWorktreeRequest[] = []
  return {
    creates,
    removes,
    async create(req: CreateWorktreeRequest): Promise<CreateWorktreeResult> {
      creates.push(req)
      return { path: `/wt/${tag}`, script: tag, args: [] }
    },
    async remove(req: RemoveWorktreeRequest): Promise<void> {
      removes.push(req)
    },
    async isDirty(): Promise<boolean> {
      return false
    }
  }
}

const createReq: CreateWorktreeRequest = {
  taskId: asTaskId('t1'),
  taskName: 'Alpha',
  repoDir: '/home/u/project',
  sourceBranch: 'main',
  newBranch: 'feature/x'
}

const removeReq: RemoveWorktreeRequest = {
  taskId: asTaskId('t1'),
  taskName: 'Alpha',
  path: '/wt/script',
  repoDir: '/home/u/project'
}

describe('SelectingWorktreeProvider.create dispatch (§6.4)', () => {
  it('routes to the script provider when <repoDir>/create_worktree.sh exists', async () => {
    const script = stubProvider('script')
    const native = stubProvider('native')
    const hasScript: ScriptProbe = (p) => p === `/home/u/project/${CREATE_SCRIPT_NAME}`

    const sel = new SelectingWorktreeProvider({ script, native, hasScript })
    const res = await sel.create(createReq)

    expect(res.script).toBe('script')
    expect(script.creates).toHaveLength(1)
    expect(native.creates).toEqual([])
  })

  it('routes to the native provider when the create script is absent', async () => {
    const script = stubProvider('script')
    const native = stubProvider('native')
    const hasScript: ScriptProbe = () => false

    const sel = new SelectingWorktreeProvider({ script, native, hasScript })
    const res = await sel.create(createReq)

    expect(res.script).toBe('native')
    expect(native.creates).toHaveLength(1)
    expect(script.creates).toEqual([])
  })

  it('probes the CREATE script name under the request repoDir', async () => {
    const hasScript = vi.fn().mockReturnValue(false)
    const sel = new SelectingWorktreeProvider({
      script: stubProvider('script'),
      native: stubProvider('native'),
      hasScript
    })
    await sel.create(createReq)
    expect(hasScript).toHaveBeenCalledWith(`/home/u/project/${CREATE_SCRIPT_NAME}`)
  })

  it('decides per call — a second task with a different repo re-probes', async () => {
    const script = stubProvider('script')
    const native = stubProvider('native')
    // Script only in /a; /b is script-less.
    const hasScript: ScriptProbe = (p) => p === `/a/${CREATE_SCRIPT_NAME}`

    const sel = new SelectingWorktreeProvider({ script, native, hasScript })
    await sel.create({ ...createReq, repoDir: '/a' })
    await sel.create({ ...createReq, repoDir: '/b' })

    expect(script.creates.map((c) => c.repoDir)).toEqual(['/a'])
    expect(native.creates.map((c) => c.repoDir)).toEqual(['/b'])
  })
})

describe('SelectingWorktreeProvider.remove dispatch (§6.4)', () => {
  it('routes to the script provider when delete_worktree.sh exists', async () => {
    const script = stubProvider('script')
    const native = stubProvider('native')
    const hasScript: ScriptProbe = (p) => p === `/home/u/project/${DELETE_SCRIPT_NAME}`

    const sel = new SelectingWorktreeProvider({ script, native, hasScript })
    await sel.remove(removeReq)

    expect(script.removes).toHaveLength(1)
    expect(native.removes).toEqual([])
  })

  it('routes to the native provider when the delete script is absent', async () => {
    const script = stubProvider('script')
    const native = stubProvider('native')
    const hasScript: ScriptProbe = () => false

    const sel = new SelectingWorktreeProvider({ script, native, hasScript })
    await sel.remove(removeReq)

    expect(native.removes).toHaveLength(1)
    expect(script.removes).toEqual([])
  })
})

describe('SelectingWorktreeProvider.isDirty (§6.4)', () => {
  it('is provider-neutral: never probes for a script, delegates once', async () => {
    const hasScript = vi.fn()
    const native = stubProvider('native')
    const isDirtySpy = vi.spyOn(native, 'isDirty')
    const sel = new SelectingWorktreeProvider({ script: stubProvider('script'), native, hasScript })

    await sel.isDirty('/wt')

    expect(hasScript).not.toHaveBeenCalled()
    expect(isDirtySpy).toHaveBeenCalledWith('/wt')
  })
})
