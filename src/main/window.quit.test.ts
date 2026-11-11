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
    persistDaemonCwds: vi.fn(),
    flushScrollbacks: vi.fn()
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

describe('registerQuitHandler scrollback flush + bounded cwd persist (§6.6)', () => {
  beforeEach(() => {
    showMessageBoxSync.mockClear()
    showMessageBoxSync.mockReturnValue(1)
    busy = false
  })

  it('flushes scrollback synchronously BEFORE awaiting the daemon cwd persist', async () => {
    const w = await load()
    const order: string[] = []
    const ctx = {
      ...ctxStub(),
      daemonActive: () => true,
      flushScrollbacks: vi.fn(() => order.push('flush')),
      persistDaemonCwds: vi.fn(() => {
        order.push('cwds')
        return new Promise<void>(() => {})
      })
    }
    w.registerQuitHandler(ctx as never)
    const preventDefault = vi.fn()
    beforeQuit!({ preventDefault })
    expect(order).toEqual(['flush', 'cwds'])
    expect(preventDefault).toHaveBeenCalled() // deferred for the cwd persist
    expect(ctx.shutdown).not.toHaveBeenCalled()
  })

  it('quits after PERSIST_CWDS_TIMEOUT_MS when the daemon never answers', async () => {
    vi.useFakeTimers()
    try {
      const w = await load()
      const { app } = await import('electron')
      vi.mocked(app.quit).mockClear()
      const ctx = {
        ...ctxStub(),
        daemonActive: () => true,
        persistDaemonCwds: vi.fn(() => new Promise<void>(() => {})) // wedged daemon
      }
      w.registerQuitHandler(ctx as never)
      beforeQuit!({ preventDefault: vi.fn() })
      await vi.advanceTimersByTimeAsync(w.PERSIST_CWDS_TIMEOUT_MS - 1)
      expect(app.quit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(app.quit).toHaveBeenCalledTimes(1)

      // The re-entered before-quit shuts down without flushing scrollback twice.
      beforeQuit!({ preventDefault: vi.fn() })
      expect(ctx.shutdown).toHaveBeenCalledTimes(1)
      expect(ctx.flushScrollbacks).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a cancelled busy-quit prompt flushes nothing', async () => {
    busy = true
    const w = await load()
    const ctx = ctxStub()
    w.registerQuitHandler(ctx as never)
    beforeQuit!({ preventDefault: vi.fn() })
    expect(ctx.flushScrollbacks).not.toHaveBeenCalled()
  })
})
