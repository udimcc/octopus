import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { WindowedWorkspaceStateDTO } from '../../../shared/dto'

const seededState: WindowedWorkspaceStateDTO = {
  tasks: [],
  activeTaskId: undefined,
  sessionTypes: [],
  settings: {
    worktree: { location: '/repos' },
    terminal: { shell: '/bin/bash' },
    defaultSessionTypeId: 'terminal',
    sessionNextKey: 'Ctrl+Shift+ArrowRight',
    sessionPrevKey: 'Ctrl+Shift+ArrowLeft'
  },
  version: 1,
  thisWindowId: 'main',
  thisWindowRole: 'main',
  windows: []
}

describe('<SettingsModal>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    useStore.getState().hydrate(seededState)
  })

  it('prefills the current settings', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    expect(screen.getByLabelText('worktree location')).toHaveValue('/repos')
    expect(screen.getByLabelText('terminal shell')).toHaveValue('/bin/bash')
    expect(screen.getByLabelText('next session shortcut')).toHaveTextContent('Ctrl+Shift+→')
    expect(screen.getByLabelText('previous session shortcut')).toHaveTextContent('Ctrl+Shift+←')
  })

  it('saves a patch and refetches state, then closes', async () => {
    const bridge = installStubBridge({ state: seededState })
    const onClose = vi.fn()
    render(<SettingsModal onClose={onClose} />)

    fireEvent.change(screen.getByLabelText('worktree location'), {
      target: { value: '/new/loc' }
    })
    fireEvent.change(screen.getByLabelText('terminal shell'), { target: { value: '/bin/zsh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(bridge.api.app.updateSettings).toHaveBeenCalledWith({
      worktree: { location: '/new/loc' },
      terminal: { shell: '/bin/zsh' },
      sessionNextKey: 'Ctrl+Shift+ArrowRight',
      sessionPrevKey: 'Ctrl+Shift+ArrowLeft'
    })
    // updateSettings emits nothing → the modal must refetch getState to reflect it.
    await waitFor(() => expect(bridge.api.app.getState).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('sends undefined shell when the shell field is cleared', () => {
    const bridge = installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('terminal shell'), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(bridge.api.app.updateSettings).toHaveBeenCalledWith({
      worktree: { location: '/repos' },
      terminal: { shell: undefined },
      sessionNextKey: 'Ctrl+Shift+ArrowRight',
      sessionPrevKey: 'Ctrl+Shift+ArrowLeft'
    })
  })

  it('captures an arbitrary modifier chord for each direction and saves both', () => {
    const bridge = installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)

    const nextBtn = screen.getByLabelText('next session shortcut')
    fireEvent.click(nextBtn)
    expect(nextBtn).toHaveTextContent('Press a shortcut…')
    // Any key with a modifier is accepted — not just arrows.
    fireEvent.keyDown(nextBtn, { code: 'KeyK', ctrlKey: true })
    expect(nextBtn).toHaveTextContent('Ctrl+K')

    const prevBtn = screen.getByLabelText('previous session shortcut')
    fireEvent.click(prevBtn)
    fireEvent.keyDown(prevBtn, { code: 'KeyJ', altKey: true })
    expect(prevBtn).toHaveTextContent('Alt+J')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(bridge.api.app.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ sessionNextKey: 'Ctrl+KeyK', sessionPrevKey: 'Alt+KeyJ' })
    )
  })

  it('builds the chord live and commits only on the final non-modifier key', () => {
    const bridge = installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)

    const nextBtn = screen.getByLabelText('next session shortcut')
    fireEvent.click(nextBtn)
    // Holding Ctrl: modifier-only keydown → live preview, no commit yet.
    fireEvent.keyDown(nextBtn, { code: 'ControlLeft', ctrlKey: true })
    expect(nextBtn).toHaveTextContent('Ctrl+…')
    // Adding Shift: preview grows, still no commit.
    fireEvent.keyDown(nextBtn, { code: 'ShiftLeft', ctrlKey: true, shiftKey: true })
    expect(nextBtn).toHaveTextContent('Ctrl+Shift+…')
    // The default binding is untouched while the chord is being built.
    expect(useStore.getState().settings.sessionNextKey).toBe('Ctrl+Shift+ArrowRight')
    // Final key is a letter (not an arrow) → commit. Use `P`, which no fixed
    // shortcut owns, so the commit+save path (not the conflict path) is exercised.
    fireEvent.keyDown(nextBtn, { code: 'KeyP', ctrlKey: true, shiftKey: true })
    expect(nextBtn).toHaveTextContent('Ctrl+Shift+P')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(bridge.api.app.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ sessionNextKey: 'Ctrl+Shift+KeyP' })
    )
  })

  it('shrinks the live preview as modifiers are released', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    const nextBtn = screen.getByLabelText('next session shortcut')
    fireEvent.click(nextBtn)
    fireEvent.keyDown(nextBtn, { code: 'ControlLeft', ctrlKey: true })
    fireEvent.keyDown(nextBtn, { code: 'ShiftLeft', ctrlKey: true, shiftKey: true })
    expect(nextBtn).toHaveTextContent('Ctrl+Shift+…')
    // Release Shift (Ctrl still held) → preview shrinks back to Ctrl.
    fireEvent.keyUp(nextBtn, { code: 'ShiftLeft', ctrlKey: true, shiftKey: false })
    expect(nextBtn).toHaveTextContent('Ctrl+…')
  })

  it('does not change the binding when only a modifier is pressed then blurred', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    const nextBtn = screen.getByLabelText('next session shortcut')
    fireEvent.click(nextBtn)
    fireEvent.keyDown(nextBtn, { code: 'ControlLeft', ctrlKey: true })
    fireEvent.blur(nextBtn)
    // No non-modifier key was pressed → nothing committed; label reverts to the default.
    expect(nextBtn).toHaveTextContent('Ctrl+Shift+→')
    expect(useStore.getState().settings.sessionNextKey).toBe('Ctrl+Shift+ArrowRight')
  })

  it('rejects a bare (modifier-less) key inline and keeps the previous binding', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    const nextBtn = screen.getByLabelText('next session shortcut')
    fireEvent.click(nextBtn)
    fireEvent.keyDown(nextBtn, { code: 'KeyA' })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Add at least one modifier (Ctrl / Alt / Shift)'
    )
    // The rejected capture leaves the field armed to retry; the stored binding is
    // unchanged and still valid, so Save stays enabled.
    expect(nextBtn).toHaveTextContent('Press a shortcut…')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('blocks saving a chord that collides with a fixed shortcut', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    const nextBtn = screen.getByLabelText('next session shortcut')
    fireEvent.click(nextBtn)
    // Ctrl+Shift+T is the fixed "New terminal" shortcut.
    fireEvent.keyDown(nextBtn, { code: 'KeyT', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('alert')).toHaveTextContent('Already used by New terminal')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('blocks saving when next and prev are bound to the same chord', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    const prevBtn = screen.getByLabelText('previous session shortcut')
    fireEvent.click(prevBtn)
    // Bind prev to the (default) next chord → collision with the other direction.
    // Both directions now report the mutual conflict, so there are two alerts.
    fireEvent.keyDown(prevBtn, { code: 'ArrowRight', ctrlKey: true, shiftKey: true })
    const alerts = screen.getAllByRole('alert')
    expect(alerts.some((a) => a.textContent?.includes('Already used by Next session'))).toBe(true)
    expect(alerts.some((a) => a.textContent?.includes('Already used by Previous session'))).toBe(
      true
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('surfaces a save error and stays open', async () => {
    installStubBridge({ ack: () => ({ ok: false, error: 'disk full' }), state: seededState })
    const onClose = vi.fn()
    render(<SettingsModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('disk full'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
