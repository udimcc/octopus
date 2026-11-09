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
import {
  registerIpcHandlers,
  parseJiraFilters,
  parseImportKeys,
  type IpcHandlerHooks
} from './ipc-handlers'
import { CHANNELS } from '../shared/ipc'
import type { CommandLoop } from '../application/command-loop'
import type { AppDependencies } from '../application/dependencies'
import type { Command, CommandResult } from '../application/commands'
import { asIssueId, asWindowId, type WindowId } from '../domain/ids'
import { makeDeps, FakeJiraIssueSource } from '../application/use-cases/test-fakes'
import { JiraSourceError } from '../ports/jira-issue-source'
import { JIRA_API_KEY_REF } from '../ports/credentials-provider'
import type { JiraIssue } from '../domain/jira-import'

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

/**
 * Minimal deps: `registerIpcHandlers` subscribes to the bus at registration (to drop a
 * pending `initialMark` when its window closes, §5.7); nothing here reads anything else.
 */
function noDeps(): AppDependencies {
  return { bus: { subscribe: vi.fn() } } as unknown as AppDependencies
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
  clipboard: { readText: () => '', writeText: () => {} },
  jira: {
    listProjects: vi.fn(async () => []),
    listSprints: vi.fn(async () => []),
    search: vi.fn(async () => ({ issues: [], total: 0 })),
    getIssues: vi.fn(async () => [])
  },
  credentials: {
    resolve: vi.fn(async () => {
      throw new Error('no credential')
    }),
    set: vi.fn(async () => {}),
    has: vi.fn(async () => false)
  }
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
    registerIpcHandlers(loop, noDeps(), hooks)
  })

  describe('issue:create', () => {
    const create = (): ((event: unknown, input: unknown) => unknown) =>
      handlerFor(CHANNELS.issueCreate)

    it.each(['todo', 'in_progress', 'blocked', 'in_review', 'done'])(
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

    it.each(['todo', 'in_progress', 'blocked', 'in_review', 'done'])(
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

    it('forwards a string blockedReasons (including empty) to the command loop', async () => {
      for (const blockedReasons of ['why', '']) {
        dispatched.length = 0
        const ack = (await update()({}, { issueId: 'i1', blockedReasons, status: 'blocked' })) as {
          ok: boolean
        }
        expect(ack.ok).toBe(true)
        expect(dispatched[0]).toMatchObject({
          kind: 'updateIssue',
          input: { issueId: 'i1', blockedReasons, status: 'blocked' }
        })
      }
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
      ],
      [
        'blockedReasons is a number',
        { issueId: 'i1', blockedReasons: 42 },
        'Invalid issue blocked reasons'
      ],
      [
        'blockedReasons is an object',
        { issueId: 'i1', blockedReasons: { not: 'a string' } },
        'Invalid issue blocked reasons'
      ],
      [
        'blockedReasons is null',
        { issueId: 'i1', blockedReasons: null },
        'Invalid issue blocked reasons'
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
    registerIpcHandlers(loop, noDeps(), hooks)
    const create = handlerFor(CHANNELS.issueCreate)

    const result = (await create({}, { name: 'n', description: 'd' })) as {
      ok: boolean
      issueId?: string
    }

    expect(result.issueId).toBe('issue-42')
  })

  it('taskCreate maps a provided issueId string to a branded IssueId in the dispatched command', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), hooks)
    const create = handlerFor(CHANNELS.taskCreate)

    await create({}, { mode: 'none', name: 'n', issueId: 'issue-7' })

    expect(dispatched).toHaveLength(1)
    expect((dispatched[0] as { input: { issueId?: unknown } }).input.issueId).toBe('issue-7')
  })

  it('taskCreate leaves issueId undefined when omitted, rather than coercing it to a branded value', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), hooks)
    const create = handlerFor(CHANNELS.taskCreate)

    await create({}, { mode: 'none', name: 'n' })

    expect(dispatched).toHaveLength(1)
    expect((dispatched[0] as { input: { issueId?: unknown } }).input.issueId).toBeUndefined()
  })

  it('taskDelete forwards alsoDeleteIssue through to the dispatched command input', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), hooks)
    const del = handlerFor(CHANNELS.taskDelete)

    await del({}, { taskId: 't1', alsoDeleteIssue: true })

    expect(dispatched).toHaveLength(1)
    expect((dispatched[0] as { input: { alsoDeleteIssue?: unknown } }).input.alsoDeleteIssue).toBe(
      true
    )
  })

  it('issueDelete maps issueId to the dispatched deleteIssue command', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), hooks)
    const del = handlerFor(CHANNELS.issueDelete)

    await del({}, { issueId: 'issue-1' })

    expect(dispatched).toEqual([{ kind: 'deleteIssue', input: { issueId: 'issue-1' } }])
  })

  it('issueBind maps issueId and taskId to the dispatched bindIssue command', async () => {
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), hooks)
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
    registerIpcHandlers(loop, noDeps(), hooks)
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
    registerIpcHandlers(loop, noDeps(), hooks)
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
    registerIpcHandlers(loop, noDeps(), hooks)
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
    registerIpcHandlers(loop, noDeps(), hooks)
    const unbind = handlerFor(CHANNELS.issueUnbind)

    await unbind({}, { issueId: 'issue-1' })

    expect(dispatched).toEqual([{ kind: 'unbindIssue', input: { issueId: 'issue-1' } }])
  })

  it('issuesToggleDrawer listener calls the toggleIssuesDrawer hook', () => {
    const { loop } = fakeLoop()
    const toggleIssuesDrawer = vi.fn()
    registerIpcHandlers(loop, noDeps(), { ...hooks, toggleIssuesDrawer })
    const listener = listenerFor(CHANNELS.issuesToggleDrawer)

    listener({}, undefined)

    expect(toggleIssuesDrawer).toHaveBeenCalledTimes(1)
  })

  it('shellOpenExternal calls through to openExternalSafely, opening a valid https URL', async () => {
    const { loop } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), hooks)
    ;(shell.openExternal as Mock).mockClear()
    ;(shell.openExternal as Mock).mockResolvedValueOnce(undefined)
    const openExternalHandler = handlerFor(CHANNELS.shellOpenExternal)

    const ok = await openExternalHandler({}, { url: 'https://example.com' })

    expect(ok).toBe(true)
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('shellOpenExternal never reaches shell.openExternal for a non-http(s) URL', async () => {
    const { loop } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), hooks)
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
      registerIpcHandlers(loop, noDeps(), hooks)
      ;(shell.openExternal as Mock).mockClear()
      const openExternalHandler = handlerFor(CHANNELS.shellOpenExternal)

      const ok = await openExternalHandler({}, payload)

      expect(ok).toBe(false)
      expect(shell.openExternal).not.toHaveBeenCalled()
    }
  )
})

describe('window-view sender-identity checks (window-view feature, §6.7)', () => {
  beforeEach(() => {
    ;(ipcMain.handle as Mock).mockClear()
    ;(ipcMain.on as Mock).mockClear()
  })

  /** A fake `e` whose `sender.id` resolves via `hooksFor`'s windowIds map. */
  function senderEvent(id: number): { sender: { id: number } } {
    return { sender: { id } }
  }

  function hooksFor(windowIds: Map<number, WindowId>): IpcHandlerHooks {
    return { ...hooks, windowIds }
  }

  describe('window:close', () => {
    it('allows the window itself to close itself', async () => {
      const { loop, dispatched } = fakeLoop()
      const windowIds = new Map([[7, asWindowId('win-2')]])
      registerIpcHandlers(loop, noDeps(), hooksFor(windowIds))
      const close = handlerFor(CHANNELS.windowClose)

      const result = (await close(senderEvent(7), {
        windowId: 'win-2',
        disposition: 'move-to-main'
      })) as { ok: boolean }

      expect(result.ok).toBe(true)
      expect(dispatched).toEqual([
        { kind: 'closeWindow', input: { windowId: 'win-2', disposition: 'move-to-main' } }
      ])
    })

    it('allows main to close ANY window', async () => {
      const { loop, dispatched } = fakeLoop()
      // Unmapped webContents id defaults to MAIN_WINDOW_ID (senderWindowId's fallback).
      const windowIds = new Map<number, WindowId>()
      registerIpcHandlers(loop, noDeps(), hooksFor(windowIds))
      const close = handlerFor(CHANNELS.windowClose)

      const result = (await close(senderEvent(999), {
        windowId: 'win-2',
        disposition: 'move-to-main'
      })) as { ok: boolean }

      expect(result.ok).toBe(true)
      expect(dispatched).toHaveLength(1)
    })

    it("rejects a THIRD window closing a window that isn't its own, without reaching the command loop", async () => {
      const { loop, dispatched } = fakeLoop()
      const windowIds = new Map([[7, asWindowId('win-3')]])
      registerIpcHandlers(loop, noDeps(), hooksFor(windowIds))
      const close = handlerFor(CHANNELS.windowClose)

      const result = (await close(senderEvent(7), {
        windowId: 'win-2',
        disposition: 'move-to-main'
      })) as { ok: boolean; error?: string }

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/only the window itself or the main window/)
      expect(dispatched).toEqual([])
    })
  })

  describe('view:create', () => {
    it('allows main to create a view', async () => {
      const { loop, dispatched } = fakeLoop()
      const windowIds = new Map<number, WindowId>()
      registerIpcHandlers(loop, noDeps(), hooksFor(windowIds))
      const create = handlerFor(CHANNELS.viewCreate)

      const result = (await create(senderEvent(999), { taskId: 'task-1' })) as { ok: boolean }

      expect(result.ok).toBe(true)
      expect(dispatched).toHaveLength(1)
      expect((dispatched[0] as { kind: string }).kind).toBe('createView')
    })

    it('rejects any non-main sender, without reaching the command loop', async () => {
      const { loop, dispatched } = fakeLoop()
      const windowIds = new Map([[7, asWindowId('win-2')]])
      registerIpcHandlers(loop, noDeps(), hooksFor(windowIds))
      const create = handlerFor(CHANNELS.viewCreate)

      const result = (await create(senderEvent(7), { taskId: 'task-1' })) as {
        ok: boolean
        error?: string
      }

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/only the main window may open a view/)
      expect(dispatched).toEqual([])
    })
  })

  describe('view:close', () => {
    it('allows the view itself to close itself', async () => {
      const { loop, dispatched } = fakeLoop()
      const windowIds = new Map([[7, asWindowId('view-1')]])
      registerIpcHandlers(loop, noDeps(), hooksFor(windowIds))
      const close = handlerFor(CHANNELS.viewClose)

      const result = (await close(senderEvent(7), { windowId: 'view-1' })) as { ok: boolean }

      expect(result.ok).toBe(true)
      expect(dispatched).toEqual([{ kind: 'closeView', input: { windowId: 'view-1' } }])
    })

    it('allows main to close a view', async () => {
      const { loop, dispatched } = fakeLoop()
      const windowIds = new Map<number, WindowId>()
      registerIpcHandlers(loop, noDeps(), hooksFor(windowIds))
      const close = handlerFor(CHANNELS.viewClose)

      const result = (await close(senderEvent(999), { windowId: 'view-1' })) as { ok: boolean }

      expect(result.ok).toBe(true)
      expect(dispatched).toHaveLength(1)
    })

    it("rejects a secondary (or another view) closing a view it doesn't own", async () => {
      const { loop, dispatched } = fakeLoop()
      const windowIds = new Map([[7, asWindowId('win-2')]])
      registerIpcHandlers(loop, noDeps(), hooksFor(windowIds))
      const close = handlerFor(CHANNELS.viewClose)

      const result = (await close(senderEvent(7), { windowId: 'view-1' })) as {
        ok: boolean
        error?: string
      }

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/only the view itself or the main window/)
      expect(dispatched).toEqual([])
    })
  })
})

describe('parseJiraFilters ("Jira import" validator, exported for direct testing)', () => {
  it('rejects a non-object', () => {
    expect(parseJiraFilters(null)).toBeUndefined()
    expect(parseJiraFilters('PROJ')).toBeUndefined()
    expect(parseJiraFilters(42)).toBeUndefined()
  })

  it('rejects an empty object: neither project nor issueKey present', () => {
    expect(parseJiraFilters({})).toBeUndefined()
  })

  it('accepts a bare project key', () => {
    expect(parseJiraFilters({ project: 'PROJ' })).toEqual({ project: 'PROJ' })
  })

  it('trims project/assignee, treating empty-after-trim as absent', () => {
    expect(parseJiraFilters({ project: '  PROJ  ', assignee: '   ' })).toEqual({ project: 'PROJ' })
  })

  it('rejects a project not matching the uppercase-key pattern', () => {
    expect(parseJiraFilters({ project: 'proj' })).toBeUndefined()
    expect(parseJiraFilters({ project: '1PROJ' })).toBeUndefined()
    expect(parseJiraFilters({ project: 'PROJ-1' })).toBeUndefined()
  })

  it('rejects a project longer than the max key length (64)', () => {
    expect(parseJiraFilters({ project: 'A'.repeat(65) })).toBeUndefined()
    expect(parseJiraFilters({ project: 'A'.repeat(64) })).toEqual({ project: 'A'.repeat(64) })
  })

  it('rejects an assignee longer than the max text length (200)', () => {
    expect(parseJiraFilters({ project: 'PROJ', assignee: 'a'.repeat(201) })).toBeUndefined()
    expect(parseJiraFilters({ project: 'PROJ', assignee: 'a'.repeat(200) })).toEqual({
      project: 'PROJ',
      assignee: 'a'.repeat(200)
    })
  })

  it('normalizes a valid issueKey and allows it to stand in for project', () => {
    expect(parseJiraFilters({ issueKey: 'proj-7' })).toEqual({ issueKey: 'PROJ-7' })
  })

  it('rejects a malformed issueKey', () => {
    expect(parseJiraFilters({ issueKey: 'not a key' })).toBeUndefined()
  })

  it('treats an issueKey that is empty after trimming as absent, not malformed', () => {
    expect(parseJiraFilters({ project: 'PROJ', issueKey: '   ' })).toEqual({ project: 'PROJ' })
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 1.5],
    ['over the 3650 cap', 3651]
  ])('rejects days that is %s', (_label, days) => {
    expect(parseJiraFilters({ project: 'PROJ', days })).toBeUndefined()
  })

  it('accepts days at the 3650 cap', () => {
    expect(parseJiraFilters({ project: 'PROJ', days: 3650 })).toEqual({
      project: 'PROJ',
      days: 3650
    })
  })

  it('accepts a sprint by id, carrying id/name through', () => {
    expect(
      parseJiraFilters({ project: 'PROJ', sprint: { kind: 'id', id: 5, name: 'Sprint 5' } })
    ).toEqual({ project: 'PROJ', sprint: { kind: 'id', id: 5, name: 'Sprint 5' } })
  })

  it('accepts a free-text sprint name', () => {
    expect(
      parseJiraFilters({ project: 'PROJ', sprint: { kind: 'name', text: 'Sprint 5' } })
    ).toEqual({ project: 'PROJ', sprint: { kind: 'name', text: 'Sprint 5' } })
  })

  it('rejects a sprint of an unknown kind', () => {
    expect(parseJiraFilters({ project: 'PROJ', sprint: { kind: 'bogus' } })).toBeUndefined()
  })
})

describe('parseImportKeys ("Jira import" validator, exported for direct testing)', () => {
  it('rejects a non-array, an empty array, and over the 500-key cap', () => {
    expect(parseImportKeys('PROJ-1')).toBeUndefined()
    expect(parseImportKeys([])).toBeUndefined()
    expect(parseImportKeys(Array.from({ length: 501 }, (_, i) => `PROJ-${i + 1}`))).toBeUndefined()
  })

  it('accepts exactly 500 keys', () => {
    const keys = Array.from({ length: 500 }, (_, i) => `PROJ-${i + 1}`)
    expect(parseImportKeys(keys)).toEqual(keys)
  })

  it('normalizes each key (trim/uppercase)', () => {
    expect(parseImportKeys(['  proj-1  '])).toEqual(['PROJ-1'])
  })

  it('rejects when any entry is not a string', () => {
    expect(parseImportKeys(['PROJ-1', 42])).toBeUndefined()
  })

  it('rejects when any entry fails Jira issue key validation', () => {
    expect(parseImportKeys(['PROJ-1', 'not a key'])).toBeUndefined()
  })

  it('dedupes, first occurrence winning, preserving order', () => {
    expect(parseImportKeys(['PROJ-1', 'PROJ-2', 'proj-1'])).toEqual(['PROJ-1', 'PROJ-2'])
  })
})

describe('jira:projects / jira:sprints / jira:search bypass the command loop ("Jira import")', () => {
  function setupJira(jira: IpcHandlerHooks['jira']) {
    ;(ipcMain.handle as Mock).mockClear()
    ;(ipcMain.on as Mock).mockClear()
    const { loop, dispatched } = fakeLoop()
    const fd = makeDeps()
    registerIpcHandlers(loop, fd.deps, { ...hooks, jira })
    return { dispatched, fd }
  }

  it('jira:projects calls the port and never dispatches to the command loop', async () => {
    const jira: IpcHandlerHooks['jira'] = {
      listProjects: vi.fn(async () => [{ key: 'PROJ', ticketCount: 3 }]),
      listSprints: vi.fn(async () => []),
      search: vi.fn(async () => ({ issues: [], total: 0 })),
      getIssues: vi.fn(async () => [])
    }
    const { dispatched } = setupJira(jira)
    const handler = handlerFor(CHANNELS.jiraProjects)

    const result = await handler({}, undefined)

    expect(result).toEqual({ ok: true, value: [{ key: 'PROJ', ticketCount: 3 }] })
    expect(jira.listProjects).toHaveBeenCalledTimes(1)
    expect(dispatched).toEqual([])
  })

  it('jira:sprints rejects a malformed project before ever calling the port', async () => {
    const jira: IpcHandlerHooks['jira'] = {
      listProjects: vi.fn(async () => []),
      listSprints: vi.fn(async () => []),
      search: vi.fn(async () => ({ issues: [], total: 0 })),
      getIssues: vi.fn(async () => [])
    }
    const { dispatched } = setupJira(jira)
    const handler = handlerFor(CHANNELS.jiraSprints)

    const result = await handler({}, '   ')

    expect(result).toEqual({
      ok: false,
      error: { kind: 'invalid', message: 'invalid Jira project' }
    })
    expect(jira.listSprints).not.toHaveBeenCalled()
    expect(dispatched).toEqual([])
  })

  it('jira:sprints forwards the trimmed project and never dispatches to the loop', async () => {
    const jira: IpcHandlerHooks['jira'] = {
      listProjects: vi.fn(async () => []),
      listSprints: vi.fn(async () => [{ id: 1, name: 'Sprint 1', state: 'active' as const }]),
      search: vi.fn(async () => ({ issues: [], total: 0 })),
      getIssues: vi.fn(async () => [])
    }
    const { dispatched } = setupJira(jira)
    const handler = handlerFor(CHANNELS.jiraSprints)

    const result = await handler({}, '  PROJ  ')

    expect(jira.listSprints).toHaveBeenCalledWith('PROJ')
    expect(result).toEqual({
      ok: true,
      value: [{ id: 1, name: 'Sprint 1', state: 'active' }]
    })
    expect(dispatched).toEqual([])
  })

  it('jira:search rejects an invalid cursor before ever calling the port', async () => {
    const jira: IpcHandlerHooks['jira'] = {
      listProjects: vi.fn(async () => []),
      listSprints: vi.fn(async () => []),
      search: vi.fn(async () => ({ issues: [], total: 0 })),
      getIssues: vi.fn(async () => [])
    }
    const { dispatched } = setupJira(jira)
    const handler = handlerFor(CHANNELS.jiraSearch) as (
      event: unknown,
      filters: unknown,
      cursor: unknown
    ) => unknown

    const result = await handler({}, { project: 'PROJ' }, 'not-a-cursor')

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    expect(jira.search).not.toHaveBeenCalled()
    expect(dispatched).toEqual([])
  })

  it('jira:search accepts an undefined cursor and a valid numeric-string cursor', async () => {
    const jira: IpcHandlerHooks['jira'] = {
      listProjects: vi.fn(async () => []),
      listSprints: vi.fn(async () => []),
      search: vi.fn(async () => ({ issues: [], total: 0 })),
      getIssues: vi.fn(async () => [])
    }
    const { dispatched } = setupJira(jira)
    const handler = handlerFor(CHANNELS.jiraSearch) as (
      event: unknown,
      filters: unknown,
      cursor: unknown
    ) => unknown

    await handler({}, { project: 'PROJ' }, undefined)
    await handler({}, { project: 'PROJ' }, '42')

    expect(jira.search).toHaveBeenCalledTimes(2)
    expect(dispatched).toEqual([])
  })

  const jiraIssue: JiraIssue = {
    key: 'PROJ-1',
    summary: 'Fix the thing',
    descriptionMarkdown: 'desc',
    dodMarkdown: '',
    status: 'In Progress',
    priority: 'High',
    type: 'Bug',
    created: '2026-01-01T00:00:00.000Z',
    projectKey: 'PROJ',
    sprints: []
  }

  it('jira:search runs the port result through previewJiraIssues, classifying a fresh issue as "new"', async () => {
    const jiraSource = new FakeJiraIssueSource([jiraIssue])
    const { loop, dispatched } = fakeLoop()
    const fd = makeDeps()
    ;(ipcMain.handle as Mock).mockClear()
    ;(ipcMain.on as Mock).mockClear()
    registerIpcHandlers(loop, fd.deps, { ...hooks, jira: jiraSource })
    const handler = handlerFor(CHANNELS.jiraSearch) as (
      event: unknown,
      filters: unknown,
      cursor: unknown
    ) => unknown

    const result = (await handler({}, { project: 'PROJ' }, undefined)) as {
      ok: boolean
      value?: { rows: Array<{ key: string; classification: { kind: string } }> }
    }

    expect(result.ok).toBe(true)
    expect(result.value?.rows).toEqual([
      expect.objectContaining({ key: 'PROJ-1', classification: { kind: 'new' } })
    ])
    expect(jiraSource.searchCalls).toHaveLength(1)
    expect(dispatched).toEqual([])
  })

  it('jira:search maps a thrown JiraSourceError to its JiraErrorDTO kind', async () => {
    const jiraSource = new FakeJiraIssueSource()
    jiraSource.failWith = new JiraSourceError('unauthorized', 'bad credentials')
    const { loop, dispatched } = fakeLoop()
    const fd = makeDeps()
    ;(ipcMain.handle as Mock).mockClear()
    ;(ipcMain.on as Mock).mockClear()
    registerIpcHandlers(loop, fd.deps, { ...hooks, jira: jiraSource })
    const handler = handlerFor(CHANNELS.jiraSearch) as (
      event: unknown,
      filters: unknown,
      cursor: unknown
    ) => unknown

    const result = await handler({}, { project: 'PROJ' }, undefined)

    expect(result).toEqual({
      ok: false,
      error: { kind: 'unauthorized', message: 'bad credentials' }
    })
    expect(dispatched).toEqual([])
  })
})

describe('jira:import ordering and skip reporting ("Jira import")', () => {
  const jiraIssueA: JiraIssue = {
    key: 'PROJ-1',
    summary: 'A',
    descriptionMarkdown: '',
    dodMarkdown: '',
    status: 'To Do',
    priority: 'Low',
    type: 'Task',
    created: '2026-01-01T00:00:00.000Z',
    projectKey: 'PROJ',
    sprints: []
  }

  beforeEach(() => {
    ;(ipcMain.handle as Mock).mockClear()
    ;(ipcMain.on as Mock).mockClear()
  })

  it('rejects malformed keys without ever calling the Jira port or the command loop', async () => {
    const jiraSource = new FakeJiraIssueSource([jiraIssueA])
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), { ...hooks, jira: jiraSource })
    const handler = handlerFor(CHANNELS.jiraImport)

    const result = await handler({}, { keys: ['not a key'] })

    expect(result).toMatchObject({ ok: false, importedCount: 0, skippedKeys: [] })
    expect(jiraSource.getIssuesCalls).toEqual([])
    expect(dispatched).toEqual([])
  })

  it('rejects more than 500 keys with a distinct message, before calling the port', async () => {
    const jiraSource = new FakeJiraIssueSource()
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), { ...hooks, jira: jiraSource })
    const handler = handlerFor(CHANNELS.jiraImport)

    const tooMany = Array.from({ length: 501 }, (_, i) => `PROJ-${i + 1}`)
    const result = await handler({}, { keys: tooMany })

    expect(result).toMatchObject({
      ok: false,
      importedCount: 0,
      skippedKeys: [],
      error: { kind: 'invalid', message: 'at most 500 issues per import' }
    })
    expect(jiraSource.getIssuesCalls).toEqual([])
    expect(dispatched).toEqual([])
  })

  it('calls jira.getIssues BEFORE dispatching importJiraIssues to the loop, in that order', async () => {
    const callOrder: string[] = []
    const jiraSource = new FakeJiraIssueSource([jiraIssueA])
    const originalGetIssues = jiraSource.getIssues.bind(jiraSource)
    jiraSource.getIssues = async (keys: readonly string[]) => {
      callOrder.push('getIssues')
      return originalGetIssues(keys)
    }
    const dispatched: Command[] = []
    const loop = {
      dispatch: async (command: Command): Promise<CommandResult> => {
        callOrder.push('dispatch')
        dispatched.push(command)
        return { ok: true, importedCount: 1, skippedKeys: [] }
      }
    } as unknown as CommandLoop
    registerIpcHandlers(loop, noDeps(), { ...hooks, jira: jiraSource })
    const handler = handlerFor(CHANNELS.jiraImport)

    await handler({}, { keys: ['PROJ-1'] })

    expect(callOrder).toEqual(['getIssues', 'dispatch'])
    expect(dispatched).toEqual([{ kind: 'importJiraIssues', input: { issues: [jiraIssueA] } }])
  })

  it('never dispatches when the Jira port throws, surfacing its error instead', async () => {
    const jiraSource = new FakeJiraIssueSource([jiraIssueA])
    jiraSource.failWith = new JiraSourceError('unreachable', 'network down')
    const { loop, dispatched } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), { ...hooks, jira: jiraSource })
    const handler = handlerFor(CHANNELS.jiraImport)

    const result = await handler({}, { keys: ['PROJ-1'] })

    expect(result).toEqual({
      ok: false,
      importedCount: 0,
      skippedKeys: [],
      error: { kind: 'unreachable', message: 'network down' }
    })
    expect(dispatched).toEqual([])
  })

  it('reports a key the gateway did not return as skipped, alongside the loop-reported skips', async () => {
    const jiraSource = new FakeJiraIssueSource([jiraIssueA])
    const dispatched: Command[] = []
    const scripted = {
      dispatch: async (command: Command): Promise<CommandResult> => {
        dispatched.push(command)
        return { ok: true, importedCount: 1, skippedKeys: ['PROJ-9'] }
      }
    } as unknown as CommandLoop
    registerIpcHandlers(scripted, noDeps(), { ...hooks, jira: jiraSource })
    const handler = handlerFor(CHANNELS.jiraImport)

    // PROJ-1 is in the fake source's seed; PROJ-9 (the loop's own skip) and
    // PROJ-404 (never fetched by the gateway) both end up reported as skipped.
    const result = (await handler({}, { keys: ['PROJ-1', 'PROJ-404'] })) as {
      ok: boolean
      importedCount: number
      skippedKeys: string[]
    }

    expect(result.ok).toBe(true)
    expect(result.importedCount).toBe(1)
    expect(result.skippedKeys.sort()).toEqual(['PROJ-404', 'PROJ-9'])
    // Only the keys the gateway actually returned are forwarded to the loop.
    expect(dispatched).toEqual([{ kind: 'importJiraIssues', input: { issues: [jiraIssueA] } }])
  })

  it('maps a command-loop failure to a gateway-kind JiraErrorDTO carrying the loop error message', async () => {
    const jiraSource = new FakeJiraIssueSource([jiraIssueA])
    const failingLoop = {
      dispatch: async (): Promise<CommandResult> => ({ ok: false, error: 'disk full' })
    } as unknown as CommandLoop
    registerIpcHandlers(failingLoop, noDeps(), { ...hooks, jira: jiraSource })
    const handler = handlerFor(CHANNELS.jiraImport)

    const result = await handler({}, { keys: ['PROJ-1'] })

    expect(result).toEqual({
      ok: false,
      importedCount: 0,
      skippedKeys: [],
      error: { kind: 'gateway', message: 'disk full' }
    })
  })
})

describe('credentials:setJiraKey / credentials:hasJiraKey never leak the key ("Jira import", I16)', () => {
  beforeEach(() => {
    ;(ipcMain.handle as Mock).mockClear()
    ;(ipcMain.on as Mock).mockClear()
  })

  function setupCredentials(credentials: IpcHandlerHooks['credentials']) {
    const { loop } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), { ...hooks, credentials })
    return { setHandler: handlerFor(CHANNELS.credentialsSetJiraKey) }
  }

  it('stores a valid key via the credentials provider and acks ok without echoing it', async () => {
    const set = vi.fn(async () => {})
    const { setHandler } = setupCredentials({
      resolve: vi.fn(async () => {
        throw new Error('no credential')
      }),
      set,
      has: vi.fn(async () => false)
    })

    const result = await setHandler({}, { key: 'sk-super-secret-123' })

    expect(result).toEqual({ ok: true })
    expect(JSON.stringify(result)).not.toContain('sk-super-secret-123')
    expect(set).toHaveBeenCalledWith(JIRA_API_KEY_REF, 'sk-super-secret-123')
  })

  it('strips a pasted "Bearer " prefix before storing', async () => {
    const set = vi.fn(async () => {})
    const { setHandler } = setupCredentials({
      resolve: vi.fn(async () => {
        throw new Error('no credential')
      }),
      set,
      has: vi.fn(async () => false)
    })

    await setHandler({}, { key: 'Bearer abc123' })

    expect(set).toHaveBeenCalledWith(JIRA_API_KEY_REF, 'abc123')
  })

  it('clears the key when given null, never calling set with a string', async () => {
    const set = vi.fn(async () => {})
    const { setHandler } = setupCredentials({
      resolve: vi.fn(async () => {
        throw new Error('no credential')
      }),
      set,
      has: vi.fn(async () => false)
    })

    const result = await setHandler({}, { key: null })

    expect(result).toEqual({ ok: true })
    expect(set).toHaveBeenCalledWith(JIRA_API_KEY_REF, null)
  })

  it.each([
    ['the empty string', ''],
    ['whitespace only', '   '],
    ['a non-ASCII character', 'sëcret'],
    ['an embedded space', 'has a space'],
    ['a control byte', 'bad\tkey'],
    ['too long (4097 chars)', 'a'.repeat(4097)],
    ['a number', 42],
    ['an object', { not: 'a key' }]
  ])('rejects %s as invalid and never calls credentials.set', async (_label, key) => {
    const set = vi.fn(async () => {})
    const { setHandler } = setupCredentials({
      resolve: vi.fn(async () => {
        throw new Error('no credential')
      }),
      set,
      has: vi.fn(async () => false)
    })

    const result = (await setHandler({}, { key })) as { ok: boolean; error?: string }

    expect(result.ok).toBe(false)
    expect(set).not.toHaveBeenCalled()
    // The rejection message never echoes the bad key back to the renderer.
    if (typeof key === 'string' && key !== '') {
      expect(result.error ?? '').not.toContain(key)
    }
  })

  it('accepts a key at the 4096-char boundary', async () => {
    const set = vi.fn(async () => {})
    const { setHandler } = setupCredentials({
      resolve: vi.fn(async () => {
        throw new Error('no credential')
      }),
      set,
      has: vi.fn(async () => false)
    })
    const key = 'a'.repeat(4096)

    const result = await setHandler({}, { key })

    expect(result).toEqual({ ok: true })
    expect(set).toHaveBeenCalledWith(JIRA_API_KEY_REF, key)
  })

  it('surfaces a storage failure without leaking the key in the error message', async () => {
    const set = vi.fn(async () => {
      throw new Error('disk write failed')
    })
    const { setHandler } = setupCredentials({
      resolve: vi.fn(async () => {
        throw new Error('no credential')
      }),
      set,
      has: vi.fn(async () => false)
    })

    const result = (await setHandler({}, { key: 'sk-super-secret-123' })) as {
      ok: boolean
      error?: string
    }

    expect(result).toEqual({ ok: false, error: 'disk write failed' })
    expect(result.error).not.toContain('sk-super-secret-123')
  })

  it('credentials:hasJiraKey resolves only a boolean, never the key itself', async () => {
    const has = vi.fn(async () => true)
    const { loop } = fakeLoop()
    registerIpcHandlers(loop, noDeps(), {
      ...hooks,
      credentials: {
        resolve: vi.fn(async () => {
          throw new Error('no credential')
        }),
        set: vi.fn(async () => {}),
        has
      }
    })
    const handler = handlerFor(CHANNELS.credentialsHasJiraKey)

    const result = await handler({}, undefined)

    expect(result).toBe(true)
    expect(has).toHaveBeenCalledTimes(1)
  })
})
