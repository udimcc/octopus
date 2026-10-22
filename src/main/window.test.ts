import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

// `window.ts` imports Electron's `app`/`BrowserWindow`/`dialog`/`shell` at module
// scope, which can't load outside a real Electron runtime. `openExternalSafely` only
// touches `shell.openExternal`, so (like `electron-clipboard.test.ts`/
// `notification-target.test.ts`) a minimal stub is enough to exercise it directly
// without constructing a real `BrowserWindow`.
//
// `isOwnRendererUrl` is a plain pure function (just `URL` parsing + `process.env`),
// callable directly. `wireNavigationSafety` only touches
// `window.webContents.on`/`setWindowOpenHandler`, so (§13.4) a minimal
// `{ webContents: { on, setWindowOpenHandler } }` fake stands in for a real
// `BrowserWindow` — no need for the full fake (bounds/close/crash-recovery wiring)
// `createWindow()` itself would require.
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  shell: { openExternal: vi.fn() }
}))

import { shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { openExternalSafely, isOwnRendererUrl, wireNavigationSafety } from './window'
import type { CreateWindowOptions } from './window'
import type { AppContext } from './composition-root'
import { asWindowId } from '../domain/ids'

const openExternal = vi.mocked(shell.openExternal)

describe('openExternalSafely (§13.4)', () => {
  beforeEach(() => {
    openExternal.mockReset()
  })

  it('opens a safe http URL via shell.openExternal, using the NORMALIZED href', async () => {
    openExternal.mockResolvedValueOnce(undefined)
    const ok = await openExternalSafely('http://example.com')
    expect(ok).toBe(true)
    // toSafeExternalUrl normalizes a bare host to add the trailing slash; the
    // wrapper must open exactly that normalized value, not the raw input.
    expect(openExternal).toHaveBeenCalledWith('http://example.com/')
  })

  it('opens a safe https URL unchanged when already normalized', async () => {
    openExternal.mockResolvedValueOnce(undefined)
    const ok = await openExternalSafely('https://example.com/path?q=1')
    expect(ok).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/path?q=1')
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>1</script>'])(
    'never calls shell.openExternal for the unsafe URL %s, and returns false',
    async (url) => {
      const ok = await openExternalSafely(url)
      expect(ok).toBe(false)
      expect(openExternal).not.toHaveBeenCalled()
    }
  )

  it('never calls shell.openExternal for a malformed/unparseable URL, and returns false', async () => {
    const ok = await openExternalSafely('not a url')
    expect(ok).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('returns false (rather than throwing) when shell.openExternal itself rejects', async () => {
    openExternal.mockRejectedValueOnce(new Error('no handler registered'))
    const ok = await openExternalSafely('https://example.com')
    expect(ok).toBe(false)
  })
})

describe('isOwnRendererUrl (§13.4)', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    // Restore exactly what was there before each test (dev-origin tests mutate
    // `ELECTRON_RENDERER_URL`).
    process.env = { ...originalEnv }
  })

  describe('dev-origin branch (ELECTRON_RENDERER_URL set)', () => {
    beforeEach(() => {
      process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    })

    it('passes a URL on the same origin, even with a different path/query', () => {
      expect(isOwnRendererUrl('http://localhost:5173/some/path?x=1')).toBe(true)
    })

    it('fails a URL on a different origin (different port)', () => {
      expect(isOwnRendererUrl('http://localhost:5174/')).toBe(false)
    })

    it('fails a malformed candidate URL', () => {
      expect(isOwnRendererUrl('not a url')).toBe(false)
    })

    it('fails every candidate when ELECTRON_RENDERER_URL itself is malformed', () => {
      process.env.ELECTRON_RENDERER_URL = 'not-a-valid-url'
      expect(isOwnRendererUrl('http://localhost:5173/')).toBe(false)
    })
  })

  describe('production branch (ELECTRON_RENDERER_URL unset, file:// index.html)', () => {
    beforeEach(() => {
      delete process.env.ELECTRON_RENDERER_URL
    })

    // Mirrors window.ts's own `join(__dirname, '../renderer/index.html')` — this
    // test file lives in the same directory (`src/main`), so the computation
    // resolves to the exact same path.
    const indexFileUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString()

    it('passes the built index.html path', () => {
      expect(isOwnRendererUrl(indexFileUrl)).toBe(true)
    })

    it('passes the same path with a query string (per-window ?windowId=) ignored', () => {
      expect(isOwnRendererUrl(`${indexFileUrl}?windowId=secondary-1`)).toBe(true)
    })

    it('fails a file:// URL with a host component', () => {
      expect(isOwnRendererUrl('file://some-host/renderer/index.html')).toBe(false)
    })

    it('fails a non-file scheme (e.g. https)', () => {
      expect(isOwnRendererUrl('https://example.com/renderer/index.html')).toBe(false)
    })

    it('fails a malformed URL', () => {
      expect(isOwnRendererUrl('not a url')).toBe(false)
    })
  })
})

describe('wireNavigationSafety (§13.4)', () => {
  type OpenHandler = (details: { url: string }) => { action: string }

  /**
   * Minimal fake standing in for a real `BrowserWindow` (see module header).
   * `on`/`setWindowOpenHandler` just record the callback `wireNavigationSafety`
   * registers, into the SAME boxes the caller holds — so a later reassignment
   * (once `wireNavigationSafety` actually calls `setWindowOpenHandler`) is visible
   * to the test without any getter/closure indirection.
   */
  function fakeWindow(): {
    window: BrowserWindow
    handlers: Map<string, (...args: unknown[]) => void>
    openHandlerBox: { current?: OpenHandler }
  } {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const openHandlerBox: { current?: OpenHandler } = {}
    const window = {
      webContents: {
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          handlers.set(event, cb)
        }),
        setWindowOpenHandler: vi.fn((cb: OpenHandler) => {
          openHandlerBox.current = cb
        })
      }
    } as unknown as BrowserWindow
    return { window, handlers, openHandlerBox }
  }

  beforeEach(() => {
    delete process.env.ELECTRON_RENDERER_URL
    openExternal.mockReset()
  })

  it('will-navigate: calls preventDefault for a foreign URL', () => {
    const { window, handlers } = fakeWindow()
    wireNavigationSafety(window)
    const willNavigate = handlers.get('will-navigate')!
    const event = { preventDefault: vi.fn() }
    willNavigate(event, 'https://evil.example.com')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('will-navigate: does NOT call preventDefault for the app’s own URL', () => {
    const { window, handlers } = fakeWindow()
    wireNavigationSafety(window)
    const willNavigate = handlers.get('will-navigate')!
    const event = { preventDefault: vi.fn() }
    const ownUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
    willNavigate(event, ownUrl)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('window-open handler: denies the new window and opens an http/https target externally', () => {
    const { window, openHandlerBox } = fakeWindow()
    wireNavigationSafety(window)
    openExternal.mockResolvedValueOnce(undefined)

    const result = openHandlerBox.current!({ url: 'https://example.com/' })

    expect(result).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('window-open handler: denies the new window but does NOT open a non-http/https target', () => {
    const { window, openHandlerBox } = fakeWindow()
    wireNavigationSafety(window)

    const result = openHandlerBox.current!({ url: 'file:///etc/passwd' })

    expect(result).toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()
  })
})

/**
 * `createWindow` itself (window.ts:100) needs a full `AppContext` (`ctx.registry`,
 * `ctx.deps.workspace`, `ctx.bus`, and everything `wireBoundsPersistence`/
 * `wireCloseSemantics`/`wireCrashRecovery` read from it) to run to completion — building
 * that scaffolding just to assert one constructor option is out of proportion. But
 * `new BrowserWindow(...)` is `createWindow`'s FIRST statement and reads only `opts` and
 * `app.getVersion()`, so a `BrowserWindow` mock that throws as soon as it's constructed
 * captures the real constructor call (and real options object) without ever touching
 * `ctx` — no fake `AppContext` needed, and no risk of a stale static-text check (e.g.
 * moving `icon` into `webPreferences` would still pass a source-text match but silently
 * break the taskbar icon).
 *
 * This is scoped via `vi.doMock` + `vi.resetModules()` + a dynamic `import()`, run only
 * inside this describe block, so the file-level `electron`/`./window` mock+imports (and
 * every other describe block's already-captured bindings) are unaffected.
 */
describe('createWindow wires the window/taskbar icon', () => {
  afterEach(() => {
    vi.doUnmock('electron')
    vi.resetModules()
  })

  /** Constructs `createWindow(fakeCtx, opts)` against a `BrowserWindow` that throws
   * immediately, and returns the options object the real constructor call received. */
  async function capturedBrowserWindowOptions(
    opts: CreateWindowOptions
  ): Promise<Record<string, unknown>> {
    const sentinel = new Error('stop before createWindow touches ctx')
    vi.resetModules()
    vi.doMock('electron', () => ({
      app: { getVersion: () => '9.9.9' },
      BrowserWindow: vi.fn(() => {
        throw sentinel
      }),
      dialog: {},
      shell: { openExternal: vi.fn() }
    }))

    const { createWindow } = await import('./window')
    const { BrowserWindow: MockedBrowserWindow } = await import('electron')
    const fakeCtx = {} as AppContext

    expect(() => createWindow(fakeCtx, opts)).toThrow(sentinel)

    const ctor = vi.mocked(MockedBrowserWindow)
    expect(ctor).toHaveBeenCalledTimes(1)
    return ctor.mock.calls[0]![0] as Record<string, unknown>
  }

  it('passes the packaged icon through to the BrowserWindow constructor for a main window', async () => {
    const options = await capturedBrowserWindowOptions({
      windowId: asWindowId('main'),
      role: 'main'
    })
    expect(options.icon).toBeTypeOf('string')
    expect(options.icon).toMatch(/icon\.png(\?.*)?$/)
  })

  it('passes the packaged icon through to the BrowserWindow constructor for a secondary window', async () => {
    const options = await capturedBrowserWindowOptions({
      windowId: asWindowId('secondary-1'),
      role: 'secondary',
      parentWindowId: asWindowId('main')
    })
    expect(options.icon).toBeTypeOf('string')
    expect(options.icon).toMatch(/icon\.png(\?.*)?$/)
  })
})

/** Reads just enough of a PNG's IHDR chunk (signature + length + "IHDR" + width + height,
 * all fixed-offset per the PNG spec) to get its pixel dimensions, without a decoding
 * dependency. */
function pngDimensions(path: string): { width: number; height: number } {
  const buf = readFileSync(path)
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`${path} is not a PNG (bad signature)`)
  }
  if (buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`${path}: expected IHDR as the first chunk`)
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('packaged app icons (electron-builder.yml / resources/icon.png?asset)', () => {
  it("build/icon.png (electron-builder's Linux icon source) is 512×512", () => {
    const path = join(__dirname, '../../build/icon.png')
    expect(pngDimensions(path)).toEqual({ width: 512, height: 512 })
  })

  it('resources/icon.png (the window/taskbar icon createWindow imports) is 256×256', () => {
    const path = join(__dirname, '../../resources/icon.png')
    expect(pngDimensions(path)).toEqual({ width: 256, height: 256 })
  })
})
