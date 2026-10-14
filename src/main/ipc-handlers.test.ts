import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// `ipc-handlers.ts` imports `ipcMain`/`app`/`dialog`/`BrowserWindow` directly, and
// (via `./window`) `shell` too; none of these load outside a real Electron runtime, so
// we stub the module the same way `notification-target.test.ts`/
// `electron-clipboard.test.ts` do — just enough shape for the handlers to register and
// run, with `ipcMain.handle`/`ipcMain.on` recording the registered callback so tests can
// invoke it directly instead of going through a real IPC transport.
vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0') },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []), fromWebContents: vi.fn(() => undefined) },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

import { ipcMain, shell } from 'electron'
import { registerIpcHandlers, type IpcHandlerHooks } from './ipc-handlers'
import { CHANNELS } from '../shared/ipc'
import type { CommandLoop } from '../application/command-loop'
import type { AppDependencies } from '../application/dependencies'
import type { Command, CommandResult } from '../application/commands'
import { asIssueId } from '../domain/ids'

/** Pull the handler registered for `channel` out of the mocked `ipcMain.handle` calls. */
function handlerFor(channel: string): (event: unknown, input: unknown) => unknown {
  const call = (ipcMain.handle as Mock).mock.calls.find((args: unknown[]) => args[0] === channel)
  if (!call) {
    throw new Error(`no handler registered for channel ${channel}`)
  }
  return call[1] as (event: unknown, input: unknown) => unknown
}

/**
 * Pull the listener registered for `channel` out of the mocked `ipcMain.on` calls
 * (I4) — the fire-and-forget counterpart of `handlerFor`, for `issue:toggleDrawer`/
 * `pty:write`/etc., which register via `ipcMain.on` (no reply) rather than
 * `ipcMain.handle`.
 */
function listenerFor(channel: string): (event: unknown, input: unknown) => void {
  const call = (ipcMain.on as Mock).mock.calls.find((args: unknown[]) => args[0] === channel)
  if (!call) {
    throw new Error(`no listener registered for channel ${channel}`)
  }
  return call[1] as (event: unknown, input: unknown) => void
}

/** A fake command loop that records every dispatched command and acks `{ ok: true }`. */
function fakeLoop(): { loop: CommandLoop; dispatched: Command[] } {
  const dispatched: Command[] = []
  const dispatch = vi.fn(async (command: Command): Promise<CommandResult> => {
    dispatched.push(command)
    return { ok: true }
  })
  return { loop: { dispatch } as unknown as CommandLoop, dispatched }
}

/**
 * A fake command loop whose dispatch instead replays one `CommandResult` per
 * call, in order (I4's `ack()`-forwarding tests need to control what the use
 * case "returned", not just record the command).
 */
function scriptedLoop(results: readonly CommandResult[]): {
  loop: CommandLoop
  dispatched: Command[]
} {
  const dispatched: Command[] = []
  let i = 0
  const dispatch = vi.fn(async (command: Command): Promise<CommandResult> => {
    dispatched.push(command)
    const result = results[i] ?? { ok: true }
    i++
    return result
  })
  return { loop: { dispatch } as unknown as CommandLoop, dispatched }
}

const hooks: IpcHandlerHooks = {
  windowIds: new Map(),
  clipboard: { readText: () => '', writeText: () => {} }
}

describe('issue status validation at the IPC edge ("Issues", §13.4)', () => {
  let loop: CommandLoop
  let dispatched: Command[]

  beforeEach(() => {
    ;(ipcMain.handle as Mock).mockClear()
    ;(ipcMain.on as Mock).mockClear()
    const fake = fakeLoop()
    loop = fake.loop
    dispatched = fake.dispatched
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
  })

  describe('issue:create', () => {
    const create = (): ((event: unknown, input: unknown) => unknown) =>
      handlerFor(CHANNELS.issueCreate)

    it.each(['todo', 'in_progress', 'in_review', 'done'])(
      'accepts the valid status %s and forwards it to the command loop unchanged',
      async (status) => {
        const ack = (await create()({}, { name: 'n', description: 'd', status })) as {
          ok: boolean
          error?: string
        }
        expect(ack.ok).toBe(true)
        expect(ack.error).toBeUndefined()
        expect(dispatched).toHaveLength(1)
        expect(dispatched[0]).toMatchObject({
          kind: 'createIssue',
          input: { status }
        })
      }
    )

    it('treats an OMITTED status as absent, not malformed: dispatches with status undefined', async () => {
      const ack = (await create()({}, { name: 'n', description: 'd' })) as { ok: boolean }
      expect(ack.ok).toBe(true)
      expect(dispatched).toHaveLength(1)
      expect((dispatched[0] as { input: { status?: unknown } }).input.status).toBeUndefined()
    })

    it.each([
      ['an unknown string', 'bogus'],
      ['the empty string', ''],
      ['null', null],
      ['a number', 42],
      ['an object', { not: 'a status' }]
    ])('rejects %s as the status and never reaches the command loop', async (_label, status) => {
      const ack = (await create()({}, { name: 'n', description: 'd', status })) as {
        ok: boolean
        error?: string
      }
      expect(ack.ok).toBe(false)
      expect(ack.error).toContain('Invalid issue status')
      expect(dispatched).toHaveLength(0)
    })

    // m8: shape rejection for name/description themselves, not just status.
    it.each([
      ['name is a number', { name: 42, description: 'd' }],
      ['name is missing', { description: 'd' }],
      ['description is a number', { name: 'n', description: 42 }],
      ['description is missing', { name: 'n' }]
    ])('rejects when %s, never reaching the command loop', async (_label, input) => {
      const ack = (await create()({}, input)) as { ok: boolean; error?: string }
      expect(ack.ok).toBe(false)
      expect(ack.error).toBe('Invalid issue name or description')
      expect(dispatched).toHaveLength(0)
    })
  })

  describe('issue:update', () => {
    const update = (): ((event: unknown, input: unknown) => unknown) =>
      handlerFor(CHANNELS.issueUpdate)

    it.each(['todo', 'in_progress', 'in_review', 'done'])(
      'accepts the valid status %s and forwards it to the command loop unchanged',
      async (status) => {
        const ack = (await update()({}, { issueId: 'i1', status })) as {
          ok: boolean
          error?: string
        }
        expect(ack.ok).toBe(true)
        expect(ack.error).toBeUndefined()
        expect(dispatched).toHaveLength(1)
        expect(dispatched[0]).toMatchObject({
          kind: 'updateIssue',
          input: { issueId: 'i1', status }
        })
      }
    )

    it('treats an OMITTED status as absent, not malformed: dispatches with status undefined', async () => {
      const ack = (await update()({}, { issueId: 'i1' })) as { ok: boolean }
      expect(ack.ok).toBe(true)
      expect(dispatched).toHaveLength(1)
      expect((dispatched[0] as { input: { status?: unknown } }).input.status).toBeUndefined()
    })

    it.each([
      ['an unknown string', 'bogus'],
      ['the empty string', ''],
      ['null', null],
      ['a number', 42],
      ['an object', { not: 'a status' }]
    ])('rejects %s as the status and never reaches the command loop', async (_label, status) => {
      const ack = (await update()({}, { issueId: 'i1', status })) as {
        ok: boolean
        error?: string
      }
      expect(ack.ok).toBe(false)
      expect(ack.error).toContain('Invalid issue status')
      expect(dispatched).toHaveLength(0)
    })

    it('status is checked after name/description pass, and still blocks dispatch on its own', async () => {
      // name/description checks run before the status check in the real handler;
      // this asserts status still blocks dispatch on its own when those are fine.
      const ack = (await update()({}, { issueId: 'i1', name: 'ok', status: 'nope' })) as {
        ok: boolean
        error?: string
      }
      expect(ack.ok).toBe(false)
      expect(ack.error).toBe('Invalid issue status: nope')
      expect(dispatched).toHaveLength(0)
    })

    // MINOR 2: the name/description type guards (ipc-handlers.ts:~427-432) reject a
    // present-but-wrongly-typed field with the exact error, before ever touching the loop.
    it.each([
      ['name is a number', { issueId: 'i1', name: 42 }, 'Invalid issue name'],
      ['name is an object', { issueId: 'i1', name: { not: 'a name' } }, 'Invalid issue name'],
      ['name is a boolean', { issueId: 'i1', name: true }, 'Invalid issue name'],
      ['description is a number', { issueId: 'i1', description: 42 }, 'Invalid issue description'],
      [
        'description is an object',
        { issueId: 'i1', description: { not: 'a description' } },
        'Invalid issue description'
      ]
    ])('rejects when %s, never reaching the command loop', async (_label, input, expectedError) => {
      const ack = (await update()({}, input)) as { ok: boolean; error?: string }
      expect(ack).toEqual({ ok: false, error: expectedError })
      expect(dispatched).toHaveLength(0)
    })
  })
})

describe('ipc-handlers field forwarding and command mapping (I4)', () => {
  beforeEach(() => {
    ;(ipcMain.handle as Mock).mockClear()
    ;(ipcMain.on as Mock).mockClear()
  })

  it('ack() copies issueId through from a CommandResult that sets it', async () => {
    const { loop } = scriptedLoop([{ ok: true, issueId: asIssueId('issue-42') }])
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    const create = handlerFor(CHANNELS.issueCreate)

    const result = (await create({}, { name: 'n', description: 'd' })) as {
      ok: boolean
      issueId?: string
    }

    expect(result.issueId).toBe('issue-42')
  })

  it('taskCreate maps a provided issueId string to a branded IssueId in the dispatched command', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    const create = handlerFor(CHANNELS.taskCreate)

    await create({}, { mode: 'none', name: 'n', issueId: 'issue-7' })

    expect(dispatched).toHaveLength(1)
    expect((dispatched[0] as { input: { issueId?: unknown } }).input.issueId).toBe('issue-7')
  })

  it('taskCreate leaves issueId undefined when omitted, rather than coercing it to a branded value', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    const create = handlerFor(CHANNELS.taskCreate)

    await create({}, { mode: 'none', name: 'n' })

    expect(dispatched).toHaveLength(1)
    expect((dispatched[0] as { input: { issueId?: unknown } }).input.issueId).toBeUndefined()
  })

  it('taskDelete forwards alsoDeleteIssue through to the dispatched command input', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    const del = handlerFor(CHANNELS.taskDelete)

    await del({}, { taskId: 't1', alsoDeleteIssue: true })

    expect(dispatched).toHaveLength(1)
    expect((dispatched[0] as { input: { alsoDeleteIssue?: unknown } }).input.alsoDeleteIssue).toBe(
      true
    )
  })

  it('issueDelete maps issueId to the dispatched deleteIssue command', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    const del = handlerFor(CHANNELS.issueDelete)

    await del({}, { issueId: 'issue-1' })

    expect(dispatched).toEqual([{ kind: 'deleteIssue', input: { issueId: 'issue-1' } }])
  })

  it('issueBind maps issueId and taskId to the dispatched bindIssue command', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    const bind = handlerFor(CHANNELS.issueBind)

    await bind({}, { issueId: 'issue-1', taskId: 'task-1' })

    expect(dispatched).toEqual([
      { kind: 'bindIssue', input: { issueId: 'issue-1', taskId: 'task-1' } }
    ])
  })

  // IMPORTANT: field forwarding for issue:create / issue:update — exact dispatched
  // command shape, including `null` vs `undefined` on `projectPath`.
  it('issueUpdate forwards an explicit projectPath: null through, not undefined', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    const update = handlerFor(CHANNELS.issueUpdate)

    await update({}, { issueId: 'i1', name: 'n', description: 'd', projectPath: null })

    expect(dispatched).toEqual([
      {
        kind: 'updateIssue',
        input: {
          issueId: 'i1',
          name: 'n',
          description: 'd',
          projectPath: null,
          status: undefined
        }
      }
    ])
  })

  it('issueUpdate leaves projectPath undefined (not null) when omitted', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    const update = handlerFor(CHANNELS.issueUpdate)

    await update({}, { issueId: 'i1', name: 'n', description: 'd' })

    expect(dispatched).toEqual([
      {
        kind: 'updateIssue',
        input: {
          issueId: 'i1',
          name: 'n',
          description: 'd',
          projectPath: undefined,
          status: undefined
        }
      }
    ])
  })

  it('issueCreate forwards name/description/projectPath/status exactly', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    const create = handlerFor(CHANNELS.issueCreate)

    await create({}, { name: 'n', description: 'd', projectPath: '/repo', status: 'todo' })

    expect(dispatched).toEqual([
      {
        kind: 'createIssue',
        input: { name: 'n', description: 'd', projectPath: '/repo', status: 'todo' }
      }
    ])
  })

  it('issueUnbind maps issueId to the dispatched unbindIssue command', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    const unbind = handlerFor(CHANNELS.issueUnbind)

    await unbind({}, { issueId: 'issue-1' })

    expect(dispatched).toEqual([{ kind: 'unbindIssue', input: { issueId: 'issue-1' } }])
  })

  it('issuesToggleDrawer listener calls the toggleIssuesDrawer hook', () => {
    const { loop } = fakeLoop()
    const toggleIssuesDrawer = vi.fn()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, { ...hooks, toggleIssuesDrawer })
    const listener = listenerFor(CHANNELS.issuesToggleDrawer)

    listener({}, undefined)

    expect(toggleIssuesDrawer).toHaveBeenCalledTimes(1)
  })

  it('shellOpenExternal calls through to openExternalSafely, opening a valid https URL', async () => {
    const { loop } = fakeLoop()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    ;(shell.openExternal as Mock).mockClear()
    ;(shell.openExternal as Mock).mockResolvedValueOnce(undefined)
    const openExternalHandler = handlerFor(CHANNELS.shellOpenExternal)

    const ok = await openExternalHandler({}, { url: 'https://example.com' })

    expect(ok).toBe(true)
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('shellOpenExternal never reaches shell.openExternal for a non-http(s) URL', async () => {
    const { loop } = fakeLoop()
    registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
    ;(shell.openExternal as Mock).mockClear()
    const openExternalHandler = handlerFor(CHANNELS.shellOpenExternal)

    const ok = await openExternalHandler({}, { url: 'file:///etc/passwd' })

    expect(ok).toBe(false)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  // MINOR 2: a non-object or malformed payload is rejected before ever reaching
  // `openExternalSafely`/`shell.openExternal`.
  it.each([
    ['null', null],
    ['a bare string', 'https://example.com'],
    ['an object with a non-string url', { url: 42 }]
  ])(
    'shellOpenExternal returns false and never calls shell.openExternal for %s',
    async (_label, payload) => {
      const { loop } = fakeLoop()
      registerIpcHandlers(loop, {} as unknown as AppDependencies, hooks)
      ;(shell.openExternal as Mock).mockClear()
      const openExternalHandler = handlerFor(CHANNELS.shellOpenExternal)

      const ok = await openExternalHandler({}, payload)

      expect(ok).toBe(false)
      expect(shell.openExternal).not.toHaveBeenCalled()
    }
  )
})
