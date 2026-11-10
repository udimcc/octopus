import { describe, it, expect, vi, beforeEach } from 'vitest'

// The skip flag is module state, so each test loads a fresh copy of ./window.
const showMessageBoxSync = vi.fn(() => 1) // 1 = Cancel
let beforeQuit: ((e: { preventDefault: () => void }) => void) | undefined
let busy = true

vi.mock('electron', () => ({
  app: {
    on: vi.fn((name: string, cb: never) => {
      if (name === 'before-quit') beforeQuit = cb
    }),
    quit: vi.fn()
  },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: {
    showMessageBoxSync: (...a: unknown[]) =>
      (showMessageBoxSync as never as (...x: unknown[]) => number)(...a)
  },
  shell: { openExternal: vi.fn() }
}))
vi.mock('../application/queries/busy-sessions', () => ({
  busySessions: () => ({ working: busy ? 1 : 0, blocked: 0, tasks: busy ? 1 : 0 }),
  isBusy: (s: { working: number; blocked: number }) => s.working + s.blocked > 0
}))

async function load() {
  vi.resetModules()
  beforeQuit = undefined
  return import('./window')
}

function ctxStub() {
  return {
    isQuitting: false,
    daemonActive: () => false,
    deps: { workspace: {} },
    shutdown: vi.fn(),
    persistDaemonCwds: vi.fn()
  }
}

describe('skipBusyQuitWarning', () => {
  beforeEach(() => {
    showMessageBoxSync.mockClear()
    showMessageBoxSync.mockReturnValue(1)
    busy = true
  })

  it('without the flag, busy sessions prompt and Cancel blocks the quit', async () => {
    const w = await load()
    const ctx = ctxStub()
    w.registerQuitHandler(ctx as never)
    const preventDefault = vi.fn()
    beforeQuit!({ preventDefault })
    expect(showMessageBoxSync).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalled()
    expect(ctx.isQuitting).toBe(false)
    expect(ctx.shutdown).not.toHaveBeenCalled()
  })

  it('with the flag, busy sessions quit without prompting', async () => {
    const w = await load()
    const ctx = ctxStub()
    w.registerQuitHandler(ctx as never)
    w.skipBusyQuitWarning()
    const preventDefault = vi.fn()
    beforeQuit!({ preventDefault })
    expect(showMessageBoxSync).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(ctx.isQuitting).toBe(true)
    expect(ctx.shutdown).toHaveBeenCalled()
  })

  it('without busy sessions there is no prompt either way', async () => {
    busy = false
    const w = await load()
    const ctx = ctxStub()
    w.registerQuitHandler(ctx as never)
    beforeQuit!({ preventDefault: vi.fn() })
    expect(showMessageBoxSync).not.toHaveBeenCalled()
    expect(ctx.shutdown).toHaveBeenCalled()
  })
})
