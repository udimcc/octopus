import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

/**
 * xterm needs a real canvas/WebGL context that jsdom lacks, so the whole xterm
 * surface is mocked. The point of this test is the WIRING TerminalPane owns:
 * create-once, register the pty-router sink, forward keystrokes to `pty.write`,
 * fit → `pty.resize`, and dispose + unregister on unmount. The xterm internals
 * themselves are exercised by the live M5 demo, not here.
 *
 * The shared mock state lives in a `vi.hoisted` block so the (hoisted) `vi.mock`
 * factories can close over it without a temporal-dead-zone error.
 */

const h = vi.hoisted(() => {
  const onDataDispose = vi.fn()
  // Default to a real GPU so the WebGL/Canvas tier assertions below hold; the
  // software-GL cases override this per-test.
  const gpuTier = vi.fn(() => 'hardware' as 'hardware' | 'software' | 'none')
  interface FakeTerm {
    cols: number
    rows: number
    unicode: { activeVersion: string }
    onDataCb: ((d: string) => void) | null
    keyHandler: ((e: KeyboardEvent) => boolean) | null
    loadAddon: ReturnType<typeof vi.fn>
    open: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    refresh: ReturnType<typeof vi.fn>
    scrollToBottom: ReturnType<typeof vi.fn>
    scrollToLine: ReturnType<typeof vi.fn>
    buffer: { active: { viewportY: number; baseY: number } }
    focus: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    parser: { registerCsiHandler: ReturnType<typeof vi.fn> }
    onData(cb: (d: string) => void): { dispose: () => void }
  }
  const instances: FakeTerm[] = []
  // When set, the FitAddon mock's `fit()` applies these dims to the newest terminal,
  // simulating a reflow so the on-show `scrollToBottom` branch can be exercised. Null
  // (the default) makes `fit()` a no-op, so mount/resize assertions see 80×24.
  const fitDims: { value: { cols: number; rows: number } | null } = { value: null }
  // Captures the handler `TerminalPane` passes to `new WebLinksAddon(handler)`, so a
  // test can invoke it directly without a real xterm link-matcher.
  const webLinksHandler: { value: ((event: MouseEvent, uri: string) => void) | null } = {
    value: null
  }
  return { onDataDispose, instances, gpuTier, fitDims, webLinksHandler }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '6' }
    onDataCb: ((d: string) => void) | null = null
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null
    loadAddon = vi.fn()
    open = vi.fn()
    write = vi.fn()
    refresh = vi.fn()
    scrollToBottom = vi.fn()
    scrollToLine = vi.fn()
    buffer = { active: { viewportY: 0, baseY: 0 } }
    focus = vi.fn()
    dispose = vi.fn()
    // `installCursorBlinkGuard` runs at mount and registers parser handlers. Its real
    // behavior is covered by `cursor-blink-guard.test.ts` against the REAL xterm; here we
    // only need the surface to exist, plus the assertion below that the pane installs it.
    parser = { registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })) }
    attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean): void {
      this.keyHandler = cb
    }
    onData(cb: (d: string) => void): { dispose: () => void } {
      this.onDataCb = cb
      return { dispose: h.onDataDispose }
    }
    constructor() {
      h.instances.push(this as unknown as (typeof h.instances)[number])
    }
  }
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn(() => {
      const dims = h.fitDims.value
      const term = h.instances.at(-1)
      if (dims && term) {
        term.cols = dims.cols
        term.rows = dims.rows
      }
    })
  }
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(handler: (event: MouseEvent, uri: string) => void) {
      h.webLinksHandler.value = handler
    }
  }
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    static constructed = 0
    onContextLoss = vi.fn()
    dispose = vi.fn()
    constructor() {
      ;(this.constructor as unknown as { constructed: number }).constructed++
    }
  }
}))
vi.mock('@xterm/addon-canvas', () => ({
  CanvasAddon: class {
    static constructed = 0
    dispose = vi.fn()
    constructor() {
      ;(this.constructor as unknown as { constructed: number }).constructed++
    }
  }
}))
vi.mock('./gpu-capability', () => ({ probeGpuTier: h.gpuTier }))
vi.mock('../pty/pty-router', () => ({
  registerTerminalSink: vi.fn(),
  unregisterTerminalSink: vi.fn()
}))
vi.mock('./terminal-search', () => ({
  registerSearchOpener: vi.fn(),
  unregisterSearchOpener: vi.fn()
}))
vi.mock('./terminal-focus', () => ({
  registerTerminalFocuser: vi.fn(),
  unregisterTerminalFocuser: vi.fn()
}))

// Imported AFTER the mocks are registered.
import { TerminalPane } from './TerminalPane'
import { useStore, initialData } from '../store/store'
import { registerTerminalSink, unregisterTerminalSink } from '../pty/pty-router'
import { registerSearchOpener, unregisterSearchOpener } from './terminal-search'
import { registerTerminalFocuser, unregisterTerminalFocuser } from './terminal-focus'
import { webglBudget } from './webgl-budget'
import { measurePane, _resetPaneMetrics } from './terminal-metrics'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'

describe('<TerminalPane> wiring (§5.3/§6.1)', () => {
  beforeEach(() => {
    h.instances.length = 0
    vi.clearAllMocks()
    // Reset the store so `attachCustomKeyEventHandler` reads the default chords.
    useStore.setState(initialData())
    // Default every test to a real GPU (WebGL/Canvas tiers active); reset the
    // addon-construction counters the software-GL test inspects.
    h.gpuTier.mockReturnValue('hardware')
    ;(WebglAddon as unknown as { constructed: number }).constructed = 0
    ;(CanvasAddon as unknown as { constructed: number }).constructed = 0
    // The WebGL budget is a module-level singleton — release any leases held from a
    // prior test so lease-exhaustion tests start from a known-empty pool.
    for (let i = 0; i < 64; i++) webglBudget.release(`s${i}`)
    webglBudget.release('s1')
    webglBudget.release('s2')
    window.octopusAPI = {
      pty: { write: vi.fn(), resize: vi.fn() },
      shell: { openExternal: vi.fn() }
    } as unknown as typeof window.octopusAPI
    h.webLinksHandler.value = null
    // jsdom has no layout: every element reports offsetWidth/Height === 0, which
    // TerminalPane's "is the host laid out?" guard would read as hidden and skip the
    // fit. Force a non-zero box so the mount/on-show fit runs (the 0×0 hidden case is
    // covered explicitly by overriding these back to 0 in its own test).
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      value: 600
    })
    // Default `fit()` to a no-op (keeps 80×24); reflow-sensitive tests opt in.
    h.fitDims.value = null
  })

  afterEach(() => {
    // Undo the `clientWidth`/`clientHeight` override one test below stubs onto
    // `HTMLElement.prototype` — neither jsdom nor the `offsetWidth`/`offsetHeight`
    // reset above touches these, so left in place they'd leak into every later test
    // in this process (including other files sharing the worker).
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
  })

  it('creates one Terminal, opens it, registers the sink, and fits → resizes', () => {
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    expect(h.instances).toHaveLength(1)
    const term = h.instances[0]
    expect(term.open).toHaveBeenCalledOnce()
    // Sink registered so backend output can reach this terminal.
    expect(registerTerminalSink).toHaveBeenCalledWith('s1', expect.any(Function))
    // Initial fit told the backend the grid size.
    expect(window.octopusAPI.pty.resize).toHaveBeenCalledWith({
      sessionId: 's1',
      cols: 80,
      rows: 24
    })
  })

  it('installs the cursor-blink guard before anything can write to the terminal', () => {
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    const term = h.instances[0]
    // Both DECSET (`?h`) and DECRST (`?l`) are guarded — an alternating blink toggle is
    // what killed the renderer process (see `cursor-blink-guard.ts`).
    const finals = term.parser.registerCsiHandler.mock.calls.map((c) => c[0])
    expect(finals).toEqual([
      { prefix: '?', final: 'h' },
      { prefix: '?', final: 'l' }
    ])
    // Installed before `open()` and before the sink could replay a re-attach backlog.
    expect(term.parser.registerCsiHandler.mock.invocationCallOrder[0]).toBeLessThan(
      term.open.mock.invocationCallOrder[0]
    )
    expect(vi.mocked(registerTerminalSink).mock.invocationCallOrder[0]).toBeGreaterThan(
      term.parser.registerCsiHandler.mock.invocationCallOrder[0]
    )
  })

  it('the registered sink writes incoming data to the terminal', () => {
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    const sink = vi.mocked(registerTerminalSink).mock.calls[0][1]
    sink('output-bytes')
    expect(h.instances[0].write).toHaveBeenCalledWith('output-bytes')
  })

  it('forwards terminal keystrokes to pty.write', () => {
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    h.instances[0].onDataCb?.('ls\r')
    expect(window.octopusAPI.pty.write).toHaveBeenCalledWith({ sessionId: 's1', data: 'ls\r' })
  })

  it('drops Ctrl+Shift chords before the PTY, but passes everything else (§5.4)', () => {
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    const handler = h.instances[0].keyHandler
    expect(handler).toBeTypeOf('function')
    // A global Ctrl+Shift chord is swallowed (returns false → never becomes onData).
    expect(
      handler?.({ type: 'keydown', code: 'KeyT', ctrlKey: true, shiftKey: true } as KeyboardEvent)
    ).toBe(false)
    // Bare terminal keys and non-keydown events pass through untouched.
    expect(
      handler?.({ type: 'keydown', code: 'KeyC', ctrlKey: true, shiftKey: false } as KeyboardEvent)
    ).toBe(true)
    expect(
      handler?.({ type: 'keyup', code: 'KeyT', ctrlKey: true, shiftKey: true } as KeyboardEvent)
    ).toBe(true)
  })

  it('also drops a configured non-Ctrl+Shift session-switch chord (§5.4)', () => {
    // Bind next=Alt+K; a custom chord must not leak into the shell either.
    useStore.setState((s) => ({
      settings: { ...s.settings, sessionNextKey: 'Alt+KeyK', sessionPrevKey: 'Alt+KeyJ' }
    }))
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    const handler = h.instances[0].keyHandler
    expect(handler?.({ type: 'keydown', code: 'KeyK', altKey: true } as KeyboardEvent)).toBe(false)
    expect(handler?.({ type: 'keydown', code: 'KeyJ', altKey: true } as KeyboardEvent)).toBe(false)
    // An unbound bare key still reaches the terminal.
    expect(handler?.({ type: 'keydown', code: 'KeyL', altKey: true } as KeyboardEvent)).toBe(true)
  })

  it('also drops the configured issuesKey chord (Alt+Shift+I default), so it reaches the window-level shortcut handler instead of the shell', () => {
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    const handler = h.instances[0].keyHandler
    expect(
      handler?.({ type: 'keydown', code: 'KeyI', altKey: true, shiftKey: true } as KeyboardEvent)
    ).toBe(false)
  })

  it('routes safe http/https web links through shell.openExternal, and ignores unsafe schemes', () => {
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    const onLink = h.webLinksHandler.value
    expect(onLink).toBeTypeOf('function')

    onLink?.({} as MouseEvent, 'https://example.com/path')
    expect(window.octopusAPI.shell.openExternal).toHaveBeenCalledWith({
      url: 'https://example.com/path'
    })

    onLink?.({} as MouseEvent, 'javascript:alert(1)')
    onLink?.({} as MouseEvent, 'file:///etc/passwd')
    expect(window.octopusAPI.shell.openExternal).toHaveBeenCalledTimes(1)
  })

  it('activates Unicode 11', () => {
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    expect(h.instances[0].unicode.activeVersion).toBe('11')
  })

  it('disposes the terminal, its onData sub, and unregisters the sink + search on unmount', () => {
    const { unmount } = render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    unmount()
    expect(h.instances[0].dispose).toHaveBeenCalledOnce()
    expect(h.onDataDispose).toHaveBeenCalledOnce()
    expect(unregisterTerminalSink).toHaveBeenCalledWith('s1')
    expect(unregisterSearchOpener).toHaveBeenCalledWith('s1')
    expect(unregisterTerminalFocuser).toHaveBeenCalledWith('s1')
  })

  it('registers a search opener for the session', () => {
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    expect(registerSearchOpener).toHaveBeenCalledWith('s1', expect.any(Function))
  })

  it('registers a terminal focuser for the session (the Issues drawer close-restore fallback, §5.4)', () => {
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    expect(registerTerminalFocuser).toHaveBeenCalledWith('s1', expect.any(Function))
    // Invoke the registered focuser: it must focus xterm's textarea with preventScroll.
    const textareaFocus = vi.fn()
    ;(h.instances.at(-1) as unknown as { textarea: { focus: typeof textareaFocus } }).textarea = {
      focus: textareaFocus
    }
    ;(vi.mocked(registerTerminalFocuser).mock.calls.at(-1)![1] as () => void)()
    expect(textareaFocus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('an active pane leases a WebGL slot; a hidden one holds none (Canvas tier)', () => {
    cleanup()
    // Active pane takes a lease.
    const active = render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    expect(webglBudget.has('s1')).toBe(true)
    active.unmount()
    // Its lease is returned on unmount.
    expect(webglBudget.has('s1')).toBe(false)

    // A pane mounted hidden takes no WebGL lease (renders via Canvas).
    render(<TerminalPane sessionId="s2" visible={false} focused={false} />)
    expect(webglBudget.has('s2')).toBe(false)
  })

  it('releases its WebGL lease when it becomes hidden, so another pane can claim it', () => {
    cleanup()
    const { rerender } = render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    expect(webglBudget.has('s1')).toBe(true)
    rerender(<TerminalPane sessionId="s1" visible={false} focused={false} />)
    expect(webglBudget.has('s1')).toBe(false)
  })

  it('on a software-GL display loads NEITHER WebGL nor Canvas (DOM renderer), taking no lease', () => {
    cleanup()
    h.gpuTier.mockReturnValue('software')
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    // Both accelerated tiers stall on ReadPixels under software GL — skip them.
    expect((WebglAddon as unknown as { constructed: number }).constructed).toBe(0)
    expect((CanvasAddon as unknown as { constructed: number }).constructed).toBe(0)
    // No WebGL lease taken, so the pool stays free for a real-GPU pane.
    expect(webglBudget.has('s1')).toBe(false)
  })

  it('with a real GPU an active pane still loads the WebGL addon', () => {
    cleanup()
    h.gpuTier.mockReturnValue('hardware')
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    expect((WebglAddon as unknown as { constructed: number }).constructed).toBe(1)
  })

  it('refits, refreshes and focuses when it becomes the active pane', () => {
    cleanup()
    const { rerender } = render(<TerminalPane sessionId="s2" visible={false} focused={false} />)
    vi.mocked(window.octopusAPI.pty.resize).mockClear()
    rerender(<TerminalPane sessionId="s2" visible={true} focused={true} />)
    // Becoming active triggers an on-show refit → refresh + focus (§5.3).
    expect(window.octopusAPI.pty.resize).toHaveBeenCalled()
    expect(h.instances[0].refresh).toHaveBeenCalled()
    expect(h.instances[0].focus).toHaveBeenCalled()
    // The hidden→visible rerender must not remount the terminal.
    expect(h.instances).toHaveLength(1)
    expect(h.instances[0].dispose).not.toHaveBeenCalled()
  })

  it('focuses on mount when it mounts already-active (freshly opened session — bug guard)', () => {
    cleanup()
    // A new session becomes the active tab, so its pane mounts with active=true. The
    // user must be able to type without clicking in. The on-show layout effect can't
    // do this on first render (termRef still null in the commit phase), so the mount
    // effect focuses directly.
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    expect(h.instances[0].focus).toHaveBeenCalled()
  })

  it('does not focus a focused-on-mount pane whose session carries the no-focus hint, and consumes it', async () => {
    cleanup()
    useStore.setState({ noFocusOnMount: { s1: true } })
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    expect(h.instances[0].focus).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 5))
    expect(useStore.getState().noFocusOnMount).toEqual({})
  })

  it('still focuses on mount when the hint belongs to another session', () => {
    cleanup()
    useStore.setState({ noFocusOnMount: { other: true } })
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    expect(h.instances[0].focus).toHaveBeenCalled()
  })

  it('does not focus a pane that mounts hidden (inactive tab of another task)', () => {
    cleanup()
    render(<TerminalPane sessionId="s1" visible={false} focused={false} />)
    expect(h.instances[0].focus).not.toHaveBeenCalled()
  })

  it('never fits while the host has no layout box (the hidden 0×0 pane — bug guard)', () => {
    cleanup()
    // Simulate the hidden task: TaskView collapses the pane to 0×0.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 0 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 0 })
    // Even mounted "active", a 0×0 host must NOT resize — fitting there shrinks xterm
    // to 2×1 and reflows the scrollback, the top-scroll bug.
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    expect(window.octopusAPI.pty.resize).not.toHaveBeenCalled()
  })

  it('re-pins to the bottom on show when the pane was at the bottom before hiding', () => {
    cleanup()
    // Start active, at the bottom (viewportY === baseY). The mount fit re-pins once.
    const { rerender } = render(<TerminalPane sessionId="s2" visible={true} focused={true} />)
    const term = h.instances[0]
    term.buffer.active = { viewportY: 500, baseY: 500 }
    term.scrollToBottom.mockClear()
    // Hide (captures atBottom=true), then show again.
    rerender(<TerminalPane sessionId="s2" visible={false} focused={false} />)
    rerender(<TerminalPane sessionId="s2" visible={true} focused={true} />)
    // Following output, not a restore to an exact line.
    expect(term.scrollToBottom).toHaveBeenCalled()
    expect(term.scrollToLine).not.toHaveBeenCalled()
    // The visible/focused toggling above (§5.3) must never remount: still the one
    // xterm instance created at mount, never disposed.
    expect(h.instances).toHaveLength(1)
    expect(term.dispose).not.toHaveBeenCalled()
  })

  it('restores the exact scrolled-up line on show, without yanking to the bottom', () => {
    cleanup()
    // Active but scrolled UP reading history (viewportY < baseY).
    const { rerender } = render(<TerminalPane sessionId="s2" visible={true} focused={true} />)
    const term = h.instances[0]
    term.buffer.active = { viewportY: 10, baseY: 500 }
    term.scrollToBottom.mockClear()
    term.scrollToLine.mockClear()
    // Hide (captures atBottom=false, viewportY=10), then show again.
    rerender(<TerminalPane sessionId="s2" visible={false} focused={false} />)
    rerender(<TerminalPane sessionId="s2" visible={true} focused={true} />)
    expect(term.scrollToLine).toHaveBeenCalledWith(10)
    expect(term.scrollToBottom).not.toHaveBeenCalled()
    // Same keep-alive guarantee as the "re-pins to the bottom" case above.
    expect(h.instances).toHaveLength(1)
    expect(term.dispose).not.toHaveBeenCalled()
  })

  it('re-applies the scroll restore in a rAF, to win the spurious late scroll event', async () => {
    cleanup()
    const { rerender } = render(<TerminalPane sessionId="s2" visible={true} focused={true} />)
    const term = h.instances[0]
    term.buffer.active = { viewportY: 500, baseY: 500 }
    rerender(<TerminalPane sessionId="s2" visible={false} focused={false} />)
    rerender(<TerminalPane sessionId="s2" visible={true} focused={true} />)
    term.scrollToBottom.mockClear()
    // Flush the scheduled rAF: the restore runs a second time, overriding any bogus
    // scrollTop=0 the browser fired between the sync restore and this frame.
    await new Promise((r) => requestAnimationFrame(r))
    expect(term.scrollToBottom).toHaveBeenCalled()
  })

  // --- §5.7 split panes: `visible`/`focused` are independent flags ------------------

  it('a visible-but-unfocused pane fits and leases WebGL, but does NOT focus (§5.7)', () => {
    cleanup()
    // A split's non-marked leaf: on screen (several panes of the same task can be
    // visible at once) but not the one holding keyboard focus.
    render(<TerminalPane sessionId="s1" visible={true} focused={false} />)
    expect(window.octopusAPI.pty.resize).toHaveBeenCalledWith({
      sessionId: 's1',
      cols: 80,
      rows: 24
    })
    expect(webglBudget.has('s1')).toBe(true)
    expect(h.instances[0].focus).not.toHaveBeenCalled()
  })

  it('a focused change alone (visible unchanged) focuses WITHOUT re-fitting or re-syncing the tier (§5.7)', () => {
    cleanup()
    const { rerender } = render(<TerminalPane sessionId="s1" visible={true} focused={false} />)
    const term = h.instances[0]
    expect(term.focus).not.toHaveBeenCalled()
    vi.mocked(window.octopusAPI.pty.resize).mockClear()
    term.refresh.mockClear()
    rerender(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    // Only term.focus() — no refit, no refresh (the on-show effect didn't re-run).
    expect(term.focus).toHaveBeenCalled()
    expect(window.octopusAPI.pty.resize).not.toHaveBeenCalled()
    expect(term.refresh).not.toHaveBeenCalled()
    expect(h.instances).toHaveLength(1)
    expect(term.dispose).not.toHaveBeenCalled()
  })

  it('drops the six default (Ctrl+Shift) split-pane chords before the PTY (§5.4/§5.7)', () => {
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    const handler = h.instances[0].keyHandler
    const chords: Array<Partial<KeyboardEvent>> = [
      { code: 'KeyE' }, // splitRightKey
      { code: 'KeyO' }, // splitDownKey
      { code: 'KeyH' }, // focusPaneLeftKey
      { code: 'KeyL' }, // focusPaneRightKey
      { code: 'KeyK' }, // focusPaneUpKey
      { code: 'KeyJ' } // focusPaneDownKey
    ]
    for (const chord of chords) {
      expect(
        handler?.({
          type: 'keydown',
          ctrlKey: true,
          shiftKey: true,
          ...chord
        } as KeyboardEvent)
      ).toBe(false)
    }
  })

  it('also drops a configured non-Ctrl+Shift split-pane chord rebind (§5.4/§5.7)', () => {
    // Rebind focusPaneLeftKey off the Ctrl+Shift family — only the explicit
    // `configurable` list (not the blanket Ctrl+Shift net) can catch this.
    useStore.setState((s) => ({
      settings: { ...s.settings, focusPaneLeftKey: 'Alt+KeyH' }
    }))
    render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    const handler = h.instances[0].keyHandler
    expect(handler?.({ type: 'keydown', code: 'KeyH', altKey: true } as KeyboardEvent)).toBe(false)
    // An unbound Alt+key still reaches the terminal.
    expect(handler?.({ type: 'keydown', code: 'KeyZ', altKey: true } as KeyboardEvent)).toBe(true)
  })

  it('registers a pane-metrics measurer on mount, reflecting the host box and cell size, and unregisters it on unmount (§5.7)', () => {
    cleanup()
    _resetPaneMetrics()
    // `registerPaneMetrics`'s measurer reads `clientWidth`/`clientHeight`, distinct
    // from the `offsetWidth`/`offsetHeight` the fit guard reads.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      value: 800
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600
    })
    const { unmount } = render(<TerminalPane sessionId="s1" visible={true} focused={true} />)
    // term.cols/rows default to 80x24 (the FitAddon mock is a no-op here).
    expect(measurePane('s1')).toEqual({
      widthPx: 800,
      heightPx: 600,
      cellWidthPx: 10,
      cellHeightPx: 25
    })
    unmount()
    expect(measurePane('s1')).toBeUndefined()
  })
})
