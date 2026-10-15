import { describe, it, expect, vi, beforeEach } from 'vitest'

// `ipc-handlers.ts` imports `electron` (ipcMain/app/dialog/BrowserWindow) at
// module scope, which can't load outside an Electron runtime. We stub `ipcMain`
// with a minimal fake that just records registered handlers so each one can be
// invoked directly, bypassing the real IPC transport entirely (same pattern as
// `notification-target.test.ts`'s `vi.mock('electron', ...)`).
const handlers = new Map<string, (e: unknown, input?: unknown) => unknown>()
const listeners = new Map<string, (e: unknown, input?: unknown) => unknown>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, input?: unknown) => unknown) => {
      handlers.set(channel, fn)
    },
    on: (channel: string, fn: (e: unknown, input?: unknown) => unknown) => {
      listeners.set(channel, fn)
    }
  }
}))

import { registerIpcHandlers, type IpcHandlerHooks } from './ipc-handlers'
import { CHANNELS } from '../shared/ipc'
import { makeDeps } from '../application/use-cases/test-fakes'
import { createTask } from '../application/use-cases/create-task'
import { openSession } from '../application/use-cases/open-session'
import { asTaskId, asWindowId, MAIN_WINDOW_ID } from '../domain/ids'
import type { CommandLoop } from '../application/command-loop'
import type { Command, CommandResult } from '../application/commands'
import type { Clipboard } from '../ports/clipboard'

/** A fake `CommandLoop` that records every dispatched command and returns a canned result. */
function fakeLoop(result: CommandResult = { ok: true }): {
  loop: CommandLoop
  dispatched: Command[]
} {
  const dispatched: Command[] = []
  const loop = {
    dispatch: async (command: Command): Promise<CommandResult> => {
      dispatched.push(command)
      return result
    }
  } as unknown as CommandLoop
  return { loop, dispatched }
}

const fakeClipboard: Clipboard = { readText: () => '', writeText: () => {} }

const fakeJira: IpcHandlerHooks['jira'] = {
  listProjects: async () => [],
  listSprints: async () => [],
  search: async () => ({ issues: [], total: 0 }),
  getIssues: async () => []
}

const fakeCredentials: IpcHandlerHooks['credentials'] = {
  resolve: async () => {
    throw new Error('no credential')
  },
  set: async () => {},
  has: async () => false
}

function setup(result?: CommandResult) {
  handlers.clear()
  listeners.clear()
  const fd = makeDeps()
  const { loop, dispatched } = fakeLoop(result)
  const hooks: IpcHandlerHooks = {
    windowIds: new Map([[1, MAIN_WINDOW_ID]]),
    clipboard: fakeClipboard,
    jira: fakeJira,
    credentials: fakeCredentials
  }
  registerIpcHandlers(loop, fd.deps, hooks)
  return { fd, dispatched, hooks }
}

beforeEach(() => {
  handlers.clear()
  listeners.clear()
})

const fakeEvent = { sender: { id: 1 } }

describe('registerIpcHandlers — group command validation (DESIGN §5.7, defensive wire guards)', () => {
  it('group:join rejects malformed input without reaching the command loop', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupJoin)!

    const ack = await handler(fakeEvent, {
      sessionId: 's1',
      anchorSessionId: 's2',
      dir: 'diagonal'
    })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:join forwards well-formed input to the loop as a joinGroup command', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupJoin)!

    const ack = await handler(fakeEvent, { sessionId: 's1', anchorSessionId: 's2', dir: 'row' })

    expect(ack).toMatchObject({ ok: true })
    expect(dispatched).toEqual([
      { kind: 'joinGroup', input: { sessionId: 's1', anchorSessionId: 's2', dir: 'row' } }
    ])
  })

  it('group:join rejects an empty-string sessionId, not just a missing one (review I4)', async () => {
    // `isNonEmptyString` is `typeof v === 'string' && v.length > 0` — a mutant
    // that weakened the check to merely `v !== undefined` would still reject the
    // MISSING-field cases covered elsewhere in this file but let an empty string
    // (falsy, but defined) straight through to the loop.
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupJoin)!

    const ack = await handler(fakeEvent, { sessionId: '', anchorSessionId: 's2', dir: 'row' })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:join rejects an empty-string anchorSessionId (review I8)', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupJoin)!

    const ack = await handler(fakeEvent, { sessionId: 's1', anchorSessionId: '', dir: 'row' })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:leave rejects a missing sessionId', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupLeave)!

    const ack = await handler(fakeEvent, {})

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:leave rejects an empty-string sessionId (review I4)', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupLeave)!

    const ack = await handler(fakeEvent, { sessionId: '' })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:leave forwards well-formed input to the loop as a leaveGroup command (review I2)', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupLeave)!

    const ack = await handler(fakeEvent, { sessionId: 's1' })

    expect(ack).toMatchObject({ ok: true })
    expect(dispatched).toEqual([{ kind: 'leaveGroup', input: { sessionId: 's1' } }])
  })

  it('group:ungroup rejects a missing groupId', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupUngroup)!

    const ack = await handler(fakeEvent, { taskId: 't1' })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:ungroup rejects an empty-string taskId (review I4)', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupUngroup)!

    const ack = await handler(fakeEvent, { taskId: '', groupId: 'g1' })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:ungroup forwards taskId and groupId to the loop without swapping them (review I1)', async () => {
    // Distinct, non-symmetric ids: a mutant that swapped the two fields when
    // building the command's `input` would still pass a test using matching or
    // palindromic ids.
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupUngroup)!

    const ack = await handler(fakeEvent, { taskId: 'task-xyz', groupId: 'group-abc' })

    expect(ack).toMatchObject({ ok: true })
    expect(dispatched).toEqual([
      { kind: 'ungroup', input: { taskId: 'task-xyz', groupId: 'group-abc' } }
    ])
  })

  it('group:reorder rejects a negative toIndex', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupReorder)!

    const ack = await handler(fakeEvent, { taskId: 't1', groupId: 'g1', toIndex: -1 })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:reorder rejects a non-integer toIndex', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupReorder)!

    const ack = await handler(fakeEvent, { taskId: 't1', groupId: 'g1', toIndex: 1.5 })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:reorder rejects an empty-string taskId (review I4)', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupReorder)!

    const ack = await handler(fakeEvent, { taskId: '', groupId: 'g1', toIndex: 0 })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:reorder forwards the actual non-zero toIndex to the loop (review I3)', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupReorder)!

    const ack = await handler(fakeEvent, { taskId: 't1', groupId: 'g1', toIndex: 3 })

    expect(ack).toMatchObject({ ok: true })
    expect(dispatched).toEqual([
      { kind: 'reorderGroup', input: { taskId: 't1', groupId: 'g1', toIndex: 3 } }
    ])
  })

  it('group:resize rejects a non-finite ratio', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupResize)!

    const ack = await handler(fakeEvent, { taskId: 't1', groupId: 'g1', path: [], ratio: Infinity })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:resize rejects a malformed path (not an array of "a"/"b")', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupResize)!

    const ack = await handler(fakeEvent, { taskId: 't1', groupId: 'g1', path: ['x'], ratio: 0.5 })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('group:resize forwards a well-formed input to the loop as a resizeGroup command', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.groupResize)!

    const ack = await handler(fakeEvent, { taskId: 't1', groupId: 'g1', path: ['a'], ratio: 0.5 })

    expect(ack).toMatchObject({ ok: true })
    expect(dispatched).toEqual([
      { kind: 'resizeGroup', input: { taskId: 't1', groupId: 'g1', path: ['a'], ratio: 0.5 } }
    ])
  })
})

describe('registerIpcHandlers — session:create split validation (DESIGN §5.7)', () => {
  it('rejects a null split without reaching the loop', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.sessionCreate)!

    const ack = await handler(fakeEvent, { taskId: 't1', split: null })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('rejects a split with a bad dir', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.sessionCreate)!

    const ack = await handler(fakeEvent, {
      taskId: 't1',
      split: { anchorSessionId: 's1', dir: 'diagonal' }
    })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('rejects a split with an empty-string anchorSessionId, not just a missing one (review I7)', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.sessionCreate)!

    const ack = await handler(fakeEvent, {
      taskId: 't1',
      split: { anchorSessionId: '', dir: 'row' }
    })

    expect(ack).toMatchObject({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('forwards a well-formed split and stamps the sender window id', async () => {
    const { dispatched } = setup()
    const handler = handlers.get(CHANNELS.sessionCreate)!

    const ack = await handler(fakeEvent, {
      taskId: 't1',
      split: { anchorSessionId: 's1', dir: 'row' }
    })

    expect(ack).toMatchObject({ ok: true })
    expect(dispatched).toEqual([
      {
        kind: 'createSession',
        input: {
          taskId: 't1',
          typeId: undefined,
          title: undefined,
          config: undefined,
          windowId: MAIN_WINDOW_ID,
          split: { anchorSessionId: 's1', dir: 'row' }
        }
      }
    ])
  })
})

describe('registerIpcHandlers — app:getState initialMark one-shot (DESIGN §3.7, §5.7 round 2)', () => {
  it('consumes the mark recorded by window:createWithSession on the very next getState for that window, not again after', async () => {
    const { fd, hooks } = setup({ ok: true, windowId: asWindowId('win-2') })
    await createTask(fd.deps, { mode: 'none', name: 'T' })
    const taskId = asTaskId('task-1')
    await openSession(fd.deps, { taskId })
    const sessionId = fd.workspace.task(taskId)!.sessions()[0].id

    // `window:createWithSession` records an initial mark for the new window id
    // the fake loop's canned result reports — mirroring what the real
    // `createWindowWithSession` use case does before this handler ever runs.
    const createHandler = handlers.get(CHANNELS.windowCreateWithSession)!
    await createHandler(fakeEvent, { sessionId })

    hooks.windowIds.set(2, asWindowId('win-2'))
    const getStateHandler = handlers.get(CHANNELS.appGetState)!

    const first = (await getStateHandler({ sender: { id: 2 } })) as {
      initialMark?: { taskId: string; sessionId: string }
    }
    expect(first.initialMark).toEqual({ taskId, sessionId })

    const second = (await getStateHandler({ sender: { id: 2 } })) as {
      initialMark?: { taskId: string; sessionId: string }
    }
    expect(second.initialMark).toBeUndefined()
  })

  it('drops a pending mark when the window closes before its first getState', async () => {
    const { fd, hooks } = setup({ ok: true, windowId: asWindowId('win-2') })
    await createTask(fd.deps, { mode: 'none', name: 'T' })
    const taskId = asTaskId('task-1')
    await openSession(fd.deps, { taskId })
    const sessionId = fd.workspace.task(taskId)!.sessions()[0].id

    const createHandler = handlers.get(CHANNELS.windowCreateWithSession)!
    await createHandler(fakeEvent, { sessionId })

    // The window closes (publishes windowClosed) before ever calling getState.
    fd.bus.publish({ type: 'windowClosed', windowId: asWindowId('win-2') })

    // That same window id later re-registers (a brand-new OS window reusing the
    // id would be unusual, but what matters is: once closed, its pending mark is
    // gone for good — a subsequent getState for that id must fall through to the
    // normal (markless) hydrate path.
    hooks.windowIds.set(2, asWindowId('win-2'))
    const getStateHandler = handlers.get(CHANNELS.appGetState)!
    const result = (await getStateHandler({ sender: { id: 2 } })) as {
      initialMark?: unknown
    }
    expect(result.initialMark).toBeUndefined()
  })

  it('keys marks per window — two windows opened via createWithSession each keep their OWN mark (review I5)', async () => {
    // A single-slot "last mark wins" bug (or a `.get` that ignores its key) would
    // still pass the single-window tests above; it takes two windows racing to
    // register marks to see one window's mark leak into the other's getState.
    handlers.clear()
    listeners.clear()
    const fd = makeDeps()
    await createTask(fd.deps, { mode: 'none', name: 'T' })
    const taskId = asTaskId('task-1')
    await openSession(fd.deps, { taskId })
    await openSession(fd.deps, { taskId })
    const [sessionA, sessionB] = fd.workspace
      .task(taskId)!
      .sessions()
      .map((s) => s.id)

    const dispatched: Command[] = []
    const loop = {
      dispatch: async (command: Command): Promise<CommandResult> => {
        dispatched.push(command)
        if (command.kind === 'createWindowWithSession') {
          const windowId =
            command.input.sessionId === sessionA ? asWindowId('win-A') : asWindowId('win-B')
          return { ok: true, windowId }
        }
        return { ok: true }
      }
    } as unknown as CommandLoop
    const hooks: IpcHandlerHooks = {
      windowIds: new Map([[1, MAIN_WINDOW_ID]]),
      clipboard: fakeClipboard,
      jira: fakeJira,
      credentials: fakeCredentials
    }
    registerIpcHandlers(loop, fd.deps, hooks)

    const createHandler = handlers.get(CHANNELS.windowCreateWithSession)!
    await createHandler(fakeEvent, { sessionId: sessionA })
    await createHandler(fakeEvent, { sessionId: sessionB })

    hooks.windowIds.set(2, asWindowId('win-A'))
    hooks.windowIds.set(3, asWindowId('win-B'))
    const getStateHandler = handlers.get(CHANNELS.appGetState)!

    // Query B FIRST, while BOTH marks are still pending: a mutant that served
    // "whatever mark happens to be first in the map" instead of looking it up
    // by `windowId` would hand B window A's (earlier-inserted) mark here —
    // querying A first would consume+delete A's mark before B's turn, letting
    // "first remaining in the map" coincide with "keyed by window" by
    // elimination (review I5).
    const stateB = (await getStateHandler({ sender: { id: 3 } })) as {
      initialMark?: { taskId: string; sessionId: string }
    }
    const stateA = (await getStateHandler({ sender: { id: 2 } })) as {
      initialMark?: { taskId: string; sessionId: string }
    }
    expect(stateB.initialMark).toEqual({ taskId, sessionId: sessionB })
    expect(stateA.initialMark).toEqual({ taskId, sessionId: sessionA })
  })
})
