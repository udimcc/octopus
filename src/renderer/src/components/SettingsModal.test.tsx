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
  issues: [],
  settings: {
    worktree: { location: '/repos' },
    terminal: { shell: '/bin/bash' },
    defaultSessionTypeId: 'terminal',
    groupTasksByRepo: true,
    sessionNextKey: 'Ctrl+Shift+ArrowRight',
    sessionPrevKey: 'Ctrl+Shift+ArrowLeft',
    taskNextKey: 'Ctrl+Shift+ArrowDown',
    taskPrevKey: 'Ctrl+Shift+ArrowUp',
    newSessionKey: 'Ctrl+Shift+KeyN',
    newTaskKey: 'Ctrl+Shift+KeyT',
    closeSessionKey: 'Ctrl+Shift+KeyW',
    searchKey: 'Ctrl+Shift+KeyF',
    copyKey: 'Ctrl+Shift+KeyC',
    pasteKey: 'Ctrl+Shift+KeyV',
    issuesKey: 'Alt+Shift+KeyI',
    splitRightKey: 'Ctrl+Shift+KeyE',
    splitDownKey: 'Ctrl+Shift+KeyO',
    focusPaneLeftKey: 'Ctrl+Shift+KeyH',
    focusPaneRightKey: 'Ctrl+Shift+KeyL',
    focusPaneUpKey: 'Ctrl+Shift+KeyK',
    focusPaneDownKey: 'Ctrl+Shift+KeyJ'
  },
  version: 1,
  thisWindowId: 'main',
  thisWindowRole: 'main',
  windows: []
}

// The keybinding fields live under the "Key Bindings" category; open it first.
const openKeyBindings = (): void => {
  fireEvent.click(screen.getByRole('tab', { name: 'Key Bindings' }))
}

describe('<SettingsModal>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    useStore.getState().hydrate(seededState)
  })

  it('shows General fields by default and swaps to key bindings on category click', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    // General is the default category: its fields render, keybindings do not.
    expect(screen.getByLabelText('worktree location')).toBeInTheDocument()
    expect(screen.queryByLabelText('next session shortcut')).toBeNull()
    // Switching category reveals the keybindings and hides the General fields.
    openKeyBindings()
    expect(screen.getByLabelText('next session shortcut')).toBeInTheDocument()
    expect(screen.queryByLabelText('worktree location')).toBeNull()
  })

  it('retains edits made in one category after switching to another', () => {
    const bridge = installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    // Edit a General field, jump to Key Bindings and back — the edit survives.
    fireEvent.change(screen.getByLabelText('worktree location'), {
      target: { value: '/edited' }
    })
    openKeyBindings()
    fireEvent.click(screen.getByRole('tab', { name: 'General' }))
    expect(screen.getByLabelText('worktree location')).toHaveValue('/edited')
    // Saving persists the retained edit regardless of the visible category.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(bridge.api.app.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: { location: '/edited' } })
    )
  })

  it('prefills the current settings', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    expect(screen.getByLabelText('worktree location')).toHaveValue('/repos')
    expect(screen.getByLabelText('terminal shell')).toHaveValue('/bin/bash')
    openKeyBindings()
    expect(screen.getByLabelText('next session shortcut')).toHaveTextContent('Ctrl+Shift+→')
    expect(screen.getByLabelText('previous session shortcut')).toHaveTextContent('Ctrl+Shift+←')
    expect(screen.getByLabelText('next task shortcut')).toHaveTextContent('Ctrl+Shift+↓')
    expect(screen.getByLabelText('previous task shortcut')).toHaveTextContent('Ctrl+Shift+↑')
    expect(screen.getByLabelText('new session shortcut')).toHaveTextContent('Ctrl+Shift+N')
    expect(screen.getByLabelText('new task shortcut')).toHaveTextContent('Ctrl+Shift+T')
    expect(screen.getByLabelText('close session shortcut')).toHaveTextContent('Ctrl+Shift+W')
    expect(screen.getByLabelText('terminal search shortcut')).toHaveTextContent('Ctrl+Shift+F')
    expect(screen.getByLabelText('copy shortcut')).toHaveTextContent('Ctrl+Shift+C')
    expect(screen.getByLabelText('paste shortcut')).toHaveTextContent('Ctrl+Shift+V')
    expect(screen.getByLabelText('toggle issues shortcut')).toHaveTextContent('Alt+Shift+I')
  })

  it('renders the six split-pane fields with their defaults (§5.7)', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    openKeyBindings()
    expect(screen.getByLabelText('split pane right shortcut')).toHaveTextContent('Ctrl+Shift+E')
    expect(screen.getByLabelText('split pane down shortcut')).toHaveTextContent('Ctrl+Shift+O')
    expect(screen.getByLabelText('focus pane left shortcut')).toHaveTextContent('Ctrl+Shift+H')
    expect(screen.getByLabelText('focus pane right shortcut')).toHaveTextContent('Ctrl+Shift+L')
    expect(screen.getByLabelText('focus pane up shortcut')).toHaveTextContent('Ctrl+Shift+K')
    expect(screen.getByLabelText('focus pane down shortcut')).toHaveTextContent('Ctrl+Shift+J')
  })

  it('rebinds a split-pane chord and saves it (§5.7)', () => {
    const bridge = installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    openKeyBindings()
    const splitRightBtn = screen.getByLabelText('split pane right shortcut')
    fireEvent.click(splitRightBtn)
    fireEvent.keyDown(splitRightBtn, { code: 'KeyR', ctrlKey: true, shiftKey: true })
    expect(splitRightBtn).toHaveTextContent('Ctrl+Shift+R')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(bridge.api.app.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ splitRightKey: 'Ctrl+Shift+KeyR' })
    )
  })

  it('blocks saving when a new pane chord collides with an existing configurable action (§5.7)', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    openKeyBindings()
    const focusLeftBtn = screen.getByLabelText('focus pane left shortcut')
    fireEvent.click(focusLeftBtn)
    // Bind focus-pane-left to the (default) next-session chord → cross-action collision.
    fireEvent.keyDown(focusLeftBtn, { code: 'ArrowRight', ctrlKey: true, shiftKey: true })
    const alerts = screen.getAllByRole('alert')
    expect(alerts.some((a) => a.textContent?.includes('Already used by Next session'))).toBe(true)
    expect(alerts.some((a) => a.textContent?.includes('Already used by Focus pane left'))).toBe(
      true
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
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
      terminal: { shell: '/bin/zsh', stateDetection: true, statusChangeNotifications: true },
      sessionNextKey: 'Ctrl+Shift+ArrowRight',
      sessionPrevKey: 'Ctrl+Shift+ArrowLeft',
      taskNextKey: 'Ctrl+Shift+ArrowDown',
      taskPrevKey: 'Ctrl+Shift+ArrowUp',
      newSessionKey: 'Ctrl+Shift+KeyN',
      newTaskKey: 'Ctrl+Shift+KeyT',
      closeSessionKey: 'Ctrl+Shift+KeyW',
      searchKey: 'Ctrl+Shift+KeyF',
      copyKey: 'Ctrl+Shift+KeyC',
      pasteKey: 'Ctrl+Shift+KeyV',
      issuesKey: 'Alt+Shift+KeyI',
      splitRightKey: 'Ctrl+Shift+KeyE',
      splitDownKey: 'Ctrl+Shift+KeyO',
      focusPaneLeftKey: 'Ctrl+Shift+KeyH',
      focusPaneRightKey: 'Ctrl+Shift+KeyL',
      focusPaneUpKey: 'Ctrl+Shift+KeyK',
      focusPaneDownKey: 'Ctrl+Shift+KeyJ'
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
      terminal: { shell: undefined, stateDetection: true, statusChangeNotifications: true },
      sessionNextKey: 'Ctrl+Shift+ArrowRight',
      sessionPrevKey: 'Ctrl+Shift+ArrowLeft',
      taskNextKey: 'Ctrl+Shift+ArrowDown',
      taskPrevKey: 'Ctrl+Shift+ArrowUp',
      newSessionKey: 'Ctrl+Shift+KeyN',
      newTaskKey: 'Ctrl+Shift+KeyT',
      closeSessionKey: 'Ctrl+Shift+KeyW',
      searchKey: 'Ctrl+Shift+KeyF',
      copyKey: 'Ctrl+Shift+KeyC',
      pasteKey: 'Ctrl+Shift+KeyV',
      issuesKey: 'Alt+Shift+KeyI',
      splitRightKey: 'Ctrl+Shift+KeyE',
      splitDownKey: 'Ctrl+Shift+KeyO',
      focusPaneLeftKey: 'Ctrl+Shift+KeyH',
      focusPaneRightKey: 'Ctrl+Shift+KeyL',
      focusPaneUpKey: 'Ctrl+Shift+KeyK',
      focusPaneDownKey: 'Ctrl+Shift+KeyJ'
    })
  })

  it('defaults state detection ON and sends the opt-out when unchecked', () => {
    const bridge = installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    // Seeded settings omit `stateDetection` → the checkbox reflects the default (on).
    const box = screen.getByLabelText('session state detection')
    expect(box).toBeChecked()
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(bridge.api.app.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({ stateDetection: false })
      })
    )
  })

  it('reflects an explicit opt-out from the stored settings', () => {
    const off: WindowedWorkspaceStateDTO = {
      ...seededState,
      settings: {
        ...seededState.settings,
        terminal: { shell: '/bin/bash', stateDetection: false }
      }
    }
    useStore.getState().hydrate(off)
    installStubBridge({ state: off })
    render(<SettingsModal onClose={vi.fn()} />)
    expect(screen.getByLabelText('session state detection')).not.toBeChecked()
  })

  it('defaults status-change notifications ON and sends the opt-out when unchecked (§9.5)', () => {
    const bridge = installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    // Seeded settings omit the flag → the checkbox reflects the default (on).
    const box = screen.getByLabelText('status change notifications')
    expect(box).toBeChecked()
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(bridge.api.app.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({ statusChangeNotifications: false })
      })
    )
  })

  it('reflects an explicit notifications opt-out from the stored settings (§9.5)', () => {
    const off: WindowedWorkspaceStateDTO = {
      ...seededState,
      settings: {
        ...seededState.settings,
        terminal: { statusChangeNotifications: false }
      }
    }
    useStore.getState().hydrate(off)
    installStubBridge({ state: off })
    render(<SettingsModal onClose={vi.fn()} />)
    expect(screen.getByLabelText('status change notifications')).not.toBeChecked()
  })

  it('captures an arbitrary modifier chord for each direction and saves both', () => {
    const bridge = installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    openKeyBindings()

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
    openKeyBindings()

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
    openKeyBindings()
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
    openKeyBindings()
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
    openKeyBindings()
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

  it('blocks saving a chord that collides with another configurable action', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    openKeyBindings()
    const nextBtn = screen.getByLabelText('next session shortcut')
    fireEvent.click(nextBtn)
    // Bind next-session to the (default) next-task chord → cross-action collision.
    fireEvent.keyDown(nextBtn, { code: 'ArrowDown', ctrlKey: true, shiftKey: true })
    const alerts = screen.getAllByRole('alert')
    expect(alerts.some((a) => a.textContent?.includes('Already used by Next task'))).toBe(true)
    expect(alerts.some((a) => a.textContent?.includes('Already used by Next session'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('blocks saving when next and prev are bound to the same chord', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    openKeyBindings()
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

  it('blocks saving when copy is bound to the paste chord', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    openKeyBindings()
    const copyBtn = screen.getByLabelText('copy shortcut')
    fireEvent.click(copyBtn)
    // Bind copy to the (default) paste chord → cross-action collision.
    fireEvent.keyDown(copyBtn, { code: 'KeyV', ctrlKey: true, shiftKey: true })
    const alerts = screen.getAllByRole('alert')
    expect(alerts.some((a) => a.textContent?.includes('Already used by Paste'))).toBe(true)
    expect(alerts.some((a) => a.textContent?.includes('Already used by Copy'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('rebinds the toggle-issues shortcut via the capture flow and saves it', () => {
    const bridge = installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    openKeyBindings()
    const issuesBtn = screen.getByLabelText('toggle issues shortcut')
    expect(issuesBtn).toHaveTextContent('Alt+Shift+I')
    fireEvent.click(issuesBtn)
    fireEvent.keyDown(issuesBtn, { code: 'KeyK', ctrlKey: true, altKey: true })
    expect(issuesBtn).toHaveTextContent('Ctrl+Alt+K')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(bridge.api.app.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ issuesKey: 'Ctrl+Alt+KeyK' })
    )
  })

  it('blocks saving when the toggle-issues chord collides with another action', () => {
    installStubBridge({ state: seededState })
    render(<SettingsModal onClose={vi.fn()} />)
    openKeyBindings()
    const issuesBtn = screen.getByLabelText('toggle issues shortcut')
    fireEvent.click(issuesBtn)
    // Bind toggle-issues to the (default) new-session chord → cross-action collision.
    fireEvent.keyDown(issuesBtn, { code: 'KeyN', ctrlKey: true, shiftKey: true })
    const alerts = screen.getAllByRole('alert')
    expect(alerts.some((a) => a.textContent?.includes('Already used by New session'))).toBe(true)
    expect(alerts.some((a) => a.textContent?.includes('Already used by Toggle Issues'))).toBe(true)
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
