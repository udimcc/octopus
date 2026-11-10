/**
 * octopus-cli control socket, end to end: a REAL Unix socket (`createControlServer`) ->
 * `createControlHandlers` -> the REAL single-writer `CommandLoop` over the `test-fakes`
 * (fake worktree provider, persistence, session manager). The client side is the CLI's own
 * `sendRequest`/`buildRequest`. Covers the happy paths, unknown project, unknown / non-Ready
 * task ids, background (non-focus-stealing) semantics and concurrent callers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandLoop } from '../../src/application/command-loop'
import { listProjects } from '../../src/application/queries/list-projects'
import { makeDeps, type FakeDeps } from '../../src/application/use-cases/test-fakes'
import { createControlServer, type ControlServer } from '../../src/adapters/control/control-server'
import { createControlHandlers } from '../../src/main/control-handlers'
import { buildRequest, sendRequest } from '../../src/cli/client'
import {
  ControlErrorCode,
  type ControlMethod,
  type ControlReply
} from '../../src/shared/control-protocol'
import { TaskLifecycle } from '../../src/domain/lifecycle'

let dir: string
let sock: string
let fd: FakeDeps
let server: ControlServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'octopus-cs-int-'))
  sock = join(dir, 'control.sock')
  fd = makeDeps()
  fd.settings.save({
    projects: [{ path: '/repos/app', defaultBranch: 'main' }, { path: '/repos/nodefault' }]
  })
  const loop = new CommandLoop(fd.deps)
  server = createControlServer({
    socketPath: sock,
    handle: createControlHandlers({
      dispatch: (c) => loop.dispatch(c),
      listProjects: () => listProjects(fd.deps),
      getSnapshot: () => fd.deps.workspace.toSnapshot(fd.deps.aggregator)
    })
  })
  await server.listen()
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

async function call(
  method: ControlMethod,
  params: Record<string, unknown> = {}
): Promise<ControlReply> {
  const res = await sendRequest(sock, buildRequest(method, params))
  if (!('reply' in res)) throw new Error(`transport failure: ${JSON.stringify(res.failure)}`)
  return res.reply
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>

const ok = (r: ControlReply): Loose => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  return r.result as unknown as Loose
}
const err = (r: ControlReply): string => {
  if (r.ok) throw new Error('expected an error reply')
  return r.error.code
}

describe('control socket -> handlers -> CommandLoop', () => {
  it('projects.list returns the configured projects', async () => {
    expect(ok(await call('projects.list')).projects).toEqual([
      { name: 'app', path: '/repos/app', defaultBranch: 'main' },
      { name: 'nodefault', path: '/repos/nodefault' }
    ])
  })

  it('task.create provisions a Ready task through the fake worktree provider, in the background', async () => {
    const { taskId } = ok(await call('task.create', { project: 'app', branch: 'feat/x' }))

    expect(fd.worktrees.createCalls).toHaveLength(1)
    expect(fd.worktrees.createCalls[0]).toMatchObject({
      repoDir: '/repos/app',
      sourceBranch: 'main',
      newBranch: 'feat/x'
    })
    const task = fd.workspace.task(taskId)!
    expect(task.lifecycle).toBe(TaskLifecycle.Ready)
    expect(task.name).toBe('feat/x')
    // Did not steal the active task.
    expect(fd.workspace.activeTaskId).toBeUndefined()
    expect(fd.bus.ofType('activeTaskChanged')).toHaveLength(0)

    const { tasks } = ok(await call('task.list', { project: 'app' }))
    expect(tasks).toEqual([
      expect.objectContaining({ id: taskId, project: 'app', branch: 'feat/x', state: 'ready' })
    ])
  })

  it('task.create surfaces a provisioning failure as command_failed and leaves a non-Ready task', async () => {
    fd.worktrees.createRejectsWith = new Error('create.sh exited 1')
    const reply = await call('task.create', { project: 'app', branch: 'b' })
    expect(err(reply)).toBe(ControlErrorCode.CommandFailed)
    expect((reply as { error: { message: string } }).error.message).toContain('create.sh exited 1')
    expect(fd.workspace.tasks()[0].lifecycle).toBe(TaskLifecycle.ProvisionFailed)
  })

  it('unknown project is not_found and provisions nothing', async () => {
    expect(err(await call('task.create', { project: 'ghost', branch: 'b' }))).toBe(
      ControlErrorCode.NotFound
    )
    expect(fd.worktrees.createCalls).toHaveLength(0)
    expect(err(await call('issues.list', { project: 'ghost' }))).toBe(ControlErrorCode.NotFound)
  })

  it('a project with no default branch needs --source-branch (bad_request) and accepts one', async () => {
    expect(err(await call('task.create', { project: 'nodefault', branch: 'b' }))).toBe(
      ControlErrorCode.BadRequest
    )
    ok(await call('task.create', { project: 'nodefault', branch: 'b', sourceBranch: 'trunk' }))
    expect(fd.worktrees.createCalls[0].sourceBranch).toBe('trunk')
  })

  it('session.open with an unknown task id is not_found', async () => {
    expect(err(await call('session.open', { taskId: 'nope' }))).toBe(ControlErrorCode.NotFound)
    expect(fd.sessions.created).toHaveLength(0)
  })

  it('session.open on a non-Ready task is not_ready and starts nothing', async () => {
    fd.worktrees.createRejectsWith = new Error('x')
    await call('task.create', { project: 'app', branch: 'b' })
    const failedId = fd.workspace.tasks()[0].id
    expect(err(await call('session.open', { taskId: failedId, command: 'echo hello' }))).toBe(
      ControlErrorCode.NotReady
    )
    expect(fd.sessions.created).toHaveLength(0)
  })

  it('session.open writes the one-shot launch line to the fresh PTY and flags the event background', async () => {
    const { taskId } = ok(await call('task.create', { project: 'app', branch: 'b' }))
    const { sessionId } = ok(await call('session.open', { taskId, command: 'echo hi' }))

    const task = fd.workspace.task(taskId)!
    expect(task.sessions().map((s) => s.id)).toEqual([sessionId])
    const writes = fd.sessions.last()!.writes
    expect(writes).toHaveLength(1)
    expect(writes[0]).toBe('echo hi\n')
    expect(fd.bus.ofType('sessionCreated')[0].background).toBe(true)
    // Launch line never persisted.
    expect(JSON.stringify(fd.persistence.upsertedSessions)).not.toContain('echo hi')
  })

  it('session.open without a command is a plain shell: nothing written', async () => {
    const { taskId } = ok(await call('task.create', { project: 'app', branch: 'b' }))
    ok(await call('session.open', { taskId }))
    expect(fd.sessions.last()!.writes).toHaveLength(0)
  })

  it('session.open rejects an oversized or multi-line command as bad_request', async () => {
    const { taskId } = ok(await call('task.create', { project: 'app', branch: 'b' }))
    const big = await call('session.open', { taskId, command: 'x'.repeat(4001) })
    expect(err(big)).toBe(ControlErrorCode.BadRequest)
    const multi = await call('session.open', { taskId, command: 'a\nb' })
    expect(err(multi)).toBe(ControlErrorCode.BadRequest)
    expect(fd.sessions.created).toHaveLength(0)
  })

  it('a failed session start reports command_failed', async () => {
    const { taskId } = ok(await call('task.create', { project: 'app', branch: 'b' }))
    fd.sessions.failNextStartWith = new Error('spawn boom')
    expect(err(await call('session.open', { taskId, command: 'ls' }))).toBe(
      ControlErrorCode.CommandFailed
    )
  })

  it('issues.add / list / get round-trip, including project by name and path', async () => {
    const { issueId } = ok(
      await call('issues.add', {
        name: 'Bug',
        description: '# md',
        project: 'app',
        status: 'in_review'
      })
    )
    ok(await call('issues.add', { name: 'Other', description: '' }))

    const byName = ok(await call('issues.list', { project: 'app' })).issues
    expect(byName.map((i: { id: string }) => i.id)).toEqual([issueId])
    expect(ok(await call('issues.list', { project: '/repos/app' })).issues).toHaveLength(1)
    expect(ok(await call('issues.list', { status: 'in_review' })).issues).toHaveLength(1)
    expect(ok(await call('issues.list')).issues).toHaveLength(2)

    expect(ok(await call('issues.get', { issueId })).issue).toMatchObject({
      id: issueId,
      name: 'Bug',
      description: '# md',
      status: 'in_review',
      project: '/repos/app'
    })
    expect(err(await call('issues.get', { issueId: 'nope' }))).toBe(ControlErrorCode.NotFound)
  })

  it('malformed requests get structured errors over the wire', async () => {
    expect(err(await call('task.create', { project: 'app' }))).toBe(ControlErrorCode.BadRequest)
    expect(err(await call('issues.list', { status: 'wip' }))).toBe(ControlErrorCode.BadRequest)
  })
})

describe('concurrent callers', () => {
  it('N concurrent task.create calls all succeed with distinct ids, serialised by the loop', async () => {
    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call('task.create', { project: 'app', branch: `b${i}` }))
    )
    const ids = replies.map((r) => ok(r).taskId as string)
    expect(new Set(ids).size).toBe(10)
    expect(fd.workspace.tasks()).toHaveLength(10)
    expect(fd.workspace.tasks().every((t) => t.lifecycle === TaskLifecycle.Ready)).toBe(true)
    expect(fd.workspace.activeTaskId).toBeUndefined()
    expect(new Set(fd.worktrees.createCalls.map((c) => c.newBranch)).size).toBe(10)
  })

  it('concurrent session.open (with and without commands) on one task: distinct sessions', async () => {
    const { taskId } = ok(await call('task.create', { project: 'app', branch: 'b' }))
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call('session.open', i % 2 === 0 ? { taskId, command: `echo ${i}` } : { taskId })
      )
    )
    const ids = replies.map((r) => ok(r).sessionId as string)
    expect(new Set(ids).size).toBe(8)
    expect(fd.workspace.task(taskId)!.sessions()).toHaveLength(8)
    const withLaunch = fd.sessions.created.filter((r) => r.writes.length === 1)
    expect(withLaunch).toHaveLength(4)
  })

  it('mixed concurrent reads and writes from many clients all get their own reply', async () => {
    const calls = [
      call('projects.list'),
      call('task.create', { project: 'app', branch: 'm1' }),
      call('task.list'),
      call('issues.add', { name: 'n', description: 'd' }),
      call('task.create', { project: 'ghost', branch: 'x' }),
      call('issues.list'),
      call('session.open', { taskId: 'nope' })
    ]
    const r = await Promise.all(calls)
    expect(r.map((x) => (x.ok ? 'ok' : x.error.code))).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      ControlErrorCode.NotFound,
      'ok',
      ControlErrorCode.NotFound
    ])
  })

  it('a task.create queued behind a slower one does not interleave with it (FIFO)', async () => {
    const order: string[] = []
    const origCreate = fd.worktrees.create.bind(fd.worktrees)
    let slowEntered!: () => void
    const slowEnteredP = new Promise<void>((r) => (slowEntered = r))
    fd.worktrees.create = async (req, onProgress) => {
      order.push(`start:${req.newBranch}`)
      if (req.newBranch === 'slow') {
        slowEntered()
        await new Promise((r) => setTimeout(r, 80))
      }
      const res = await origCreate(req, onProgress)
      order.push(`end:${req.newBranch}`)
      return res
    }
    const slow = call('task.create', { project: 'app', branch: 'slow' })
    await slowEnteredP
    const fast = call('task.create', { project: 'app', branch: 'fast' })
    await Promise.all([slow, fast])
    expect(order).toEqual(['start:slow', 'end:slow', 'start:fast', 'end:fast'])
  })
})

describe('shutdown', () => {
  it('a client waiting on a slow task.create gets shutting_down when the server closes', async () => {
    const origCreate = fd.worktrees.create.bind(fd.worktrees)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const enteredP = new Promise<void>((r) => (entered = r))
    fd.worktrees.create = async (req, onProgress) => {
      entered()
      await gate
      return origCreate(req, onProgress)
    }
    const pending = call('task.create', { project: 'app', branch: 'b' })
    await enteredP
    const closing = server.close()
    expect(err(await pending)).toBe(ControlErrorCode.ShuttingDown)
    release()
    await closing
  })
})
