import { describe, it, expect, beforeEach, vi } from 'vitest'
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
    loadAddon: ReturnType<typeof vi.fn>
    open: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    refresh: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    onData(cb: (d: string) => void): { dispose: () => void }
  }
  const instances: FakeTerm[] = []
  return { onDataDispose, instances, gpuTier }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '6' }
    onDataCb: ((d: string) => void) | null = null
    loadAddon = vi.fn()
    open = vi.fn()
    write = vi.fn()
    refresh = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
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
    fit = vi.fn()
  }
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
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

// Imported AFTER the mocks are registered.
import { TerminalPane } from './TerminalPane'
import { registerTerminalSink, unregisterTerminalSink } from '../pty/pty-router'
import { registerSearchOpener, unregisterSearchOpener } from './terminal-search'
import { webglBudget } from './webgl-budget'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'

describe('<TerminalPane> wiring (§5.3/§6.1)', () => {
  beforeEach(() => {
    h.instances.length = 0
    vi.clearAllMocks()
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
      pty: { write: vi.fn(), resize: vi.fn() }
    } as unknown as typeof window.octopusAPI
  })

  it('creates one Terminal, opens it, registers the sink, and fits → resizes', () => {
    render(<TerminalPane sessionId="s1" active={true} />)
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

  it('the registered sink writes incoming data to the terminal', () => {
    render(<TerminalPane sessionId="s1" active={true} />)
    const sink = vi.mocked(registerTerminalSink).mock.calls[0][1]
    sink('output-bytes')
    expect(h.instances[0].write).toHaveBeenCalledWith('output-bytes')
  })

  it('forwards terminal keystrokes to pty.write', () => {
    render(<TerminalPane sessionId="s1" active={true} />)
    h.instances[0].onDataCb?.('ls\r')
    expect(window.octopusAPI.pty.write).toHaveBeenCalledWith({ sessionId: 's1', data: 'ls\r' })
  })

  it('activates Unicode 11', () => {
    render(<TerminalPane sessionId="s1" active={true} />)
    expect(h.instances[0].unicode.activeVersion).toBe('11')
  })

  it('disposes the terminal, its onData sub, and unregisters the sink + search on unmount', () => {
    const { unmount } = render(<TerminalPane sessionId="s1" active={true} />)
    unmount()
    expect(h.instances[0].dispose).toHaveBeenCalledOnce()
    expect(h.onDataDispose).toHaveBeenCalledOnce()
    expect(unregisterTerminalSink).toHaveBeenCalledWith('s1')
    expect(unregisterSearchOpener).toHaveBeenCalledWith('s1')
  })

  it('registers a search opener for the session', () => {
    render(<TerminalPane sessionId="s1" active={true} />)
    expect(registerSearchOpener).toHaveBeenCalledWith('s1', expect.any(Function))
  })

  it('an active pane leases a WebGL slot; a hidden one holds none (Canvas tier)', () => {
    cleanup()
    // Active pane takes a lease.
    const active = render(<TerminalPane sessionId="s1" active={true} />)
    expect(webglBudget.has('s1')).toBe(true)
    active.unmount()
    // Its lease is returned on unmount.
    expect(webglBudget.has('s1')).toBe(false)

    // A pane mounted hidden takes no WebGL lease (renders via Canvas).
    render(<TerminalPane sessionId="s2" active={false} />)
    expect(webglBudget.has('s2')).toBe(false)
  })

  it('releases its WebGL lease when it becomes hidden, so another pane can claim it', () => {
    cleanup()
    const { rerender } = render(<TerminalPane sessionId="s1" active={true} />)
    expect(webglBudget.has('s1')).toBe(true)
    rerender(<TerminalPane sessionId="s1" active={false} />)
    expect(webglBudget.has('s1')).toBe(false)
  })

  it('on a software-GL display loads NEITHER WebGL nor Canvas (DOM renderer), taking no lease', () => {
    cleanup()
    h.gpuTier.mockReturnValue('software')
    render(<TerminalPane sessionId="s1" active={true} />)
    // Both accelerated tiers stall on ReadPixels under software GL — skip them.
    expect((WebglAddon as unknown as { constructed: number }).constructed).toBe(0)
    expect((CanvasAddon as unknown as { constructed: number }).constructed).toBe(0)
    // No WebGL lease taken, so the pool stays free for a real-GPU pane.
    expect(webglBudget.has('s1')).toBe(false)
  })

  it('with a real GPU an active pane still loads the WebGL addon', () => {
    cleanup()
    h.gpuTier.mockReturnValue('hardware')
    render(<TerminalPane sessionId="s1" active={true} />)
    expect((WebglAddon as unknown as { constructed: number }).constructed).toBe(1)
  })

  it('refits, refreshes and focuses when it becomes the active pane', () => {
    cleanup()
    const { rerender } = render(<TerminalPane sessionId="s2" active={false} />)
    vi.mocked(window.octopusAPI.pty.resize).mockClear()
    rerender(<TerminalPane sessionId="s2" active={true} />)
    // Becoming active triggers an on-show refit → refresh + focus (§5.3).
    expect(window.octopusAPI.pty.resize).toHaveBeenCalled()
    expect(h.instances[0].refresh).toHaveBeenCalled()
    expect(h.instances[0].focus).toHaveBeenCalled()
  })
})
