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
  return { onDataDispose, instances }
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
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  fit = vi.fn()
} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss = vi.fn()
    dispose = vi.fn()
  }
}))
vi.mock('../pty/pty-router', () => ({
  registerTerminalSink: vi.fn(),
  unregisterTerminalSink: vi.fn()
}))

// Imported AFTER the mocks are registered.
import { TerminalPane } from './TerminalPane'
import { registerTerminalSink, unregisterTerminalSink } from '../pty/pty-router'

describe('<TerminalPane> wiring (§5.3/§6.1)', () => {
  beforeEach(() => {
    h.instances.length = 0
    vi.clearAllMocks()
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

  it('disposes the terminal, its onData sub, and unregisters the sink on unmount', () => {
    const { unmount } = render(<TerminalPane sessionId="s1" active={true} />)
    unmount()
    expect(h.instances[0].dispose).toHaveBeenCalledOnce()
    expect(h.onDataDispose).toHaveBeenCalledOnce()
    expect(unregisterTerminalSink).toHaveBeenCalledWith('s1')
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
