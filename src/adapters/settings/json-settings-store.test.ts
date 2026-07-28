import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  JsonSettingsStore,
  parseSettings,
  mergeSettings,
  serializeSettings,
  DEFAULT_SETTINGS
} from './json-settings-store'

describe('parseSettings (§6.3)', () => {
  it('returns complete defaults for empty/invalid JSON', () => {
    expect(parseSettings('')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('not json')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('null')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('42')).toEqual(DEFAULT_SETTINGS)
  })

  it('fills missing keys from defaults and drops unknown keys', () => {
    // A lingering pre-redesign `scripts` block is an unknown key: dropped silently.
    const s = parseSettings(
      JSON.stringify({ worktree: { location: '/wt' }, scripts: { createWorktree: '/c' }, bogus: 1 })
    )
    expect(s.worktree.location).toBe('/wt')
    expect(s.defaultSessionTypeId).toBe('terminal')
    expect((s as unknown as Record<string, unknown>).bogus).toBeUndefined()
    expect((s as unknown as Record<string, unknown>).scripts).toBeUndefined()
  })

  it('reads a fully populated file', () => {
    const s = parseSettings(
      JSON.stringify({
        worktree: { location: '/home/u/octopus_repos' },
        terminal: { shell: '/bin/zsh' },
        defaultSessionTypeId: 'terminal',
        worktreeCreateTimeoutMs: 45000,
        sessionNextKey: 'ArrowUp',
        sessionPrevKey: 'ArrowDown'
      })
    )
    expect(s.worktree).toEqual({ location: '/home/u/octopus_repos' })
    expect(s.terminal.shell).toBe('/bin/zsh')
    expect(s.worktreeCreateTimeoutMs).toBe(45000)
    expect(s.sessionNextKey).toBe('ArrowUp')
    expect(s.sessionPrevKey).toBe('ArrowDown')
  })

  it('reads terminal.backend and tolerates an invalid value (§6.2)', () => {
    expect(parseSettings(JSON.stringify({ terminal: { backend: 'daemon' } })).terminal.backend).toBe(
      'daemon'
    )
    expect(
      parseSettings(JSON.stringify({ terminal: { backend: 'in-process' } })).terminal.backend
    ).toBe('in-process')
    // Unknown backend → undefined (tolerant parse), so the composition root's
    // default (daemon) applies — only an explicit 'in-process' opts out. Absent by
    // default (no key in DEFAULT_SETTINGS).
    expect(parseSettings(JSON.stringify({ terminal: { backend: 'bogus' } })).terminal.backend).toBeUndefined()
    expect(parseSettings('{}').terminal.backend).toBeUndefined()
  })

  it('defaults the configurable chords to their Ctrl+Shift bindings', () => {
    expect(DEFAULT_SETTINGS.sessionNextKey).toBe('Ctrl+Shift+ArrowRight')
    expect(DEFAULT_SETTINGS.sessionPrevKey).toBe('Ctrl+Shift+ArrowLeft')
    expect(DEFAULT_SETTINGS.taskNextKey).toBe('Ctrl+Shift+ArrowDown')
    expect(DEFAULT_SETTINGS.taskPrevKey).toBe('Ctrl+Shift+ArrowUp')
    expect(DEFAULT_SETTINGS.newSessionKey).toBe('Ctrl+Shift+KeyN')
    expect(DEFAULT_SETTINGS.newTaskKey).toBe('Ctrl+Shift+KeyT')
    expect(DEFAULT_SETTINGS.closeSessionKey).toBe('Ctrl+Shift+KeyW')
    expect(DEFAULT_SETTINGS.searchKey).toBe('Ctrl+Shift+KeyF')
    expect(DEFAULT_SETTINGS.copyKey).toBe('Ctrl+Shift+KeyC')
    expect(DEFAULT_SETTINGS.pasteKey).toBe('Ctrl+Shift+KeyV')
    const s = parseSettings('{}')
    expect(s.sessionNextKey).toBe('Ctrl+Shift+ArrowRight')
    expect(s.sessionPrevKey).toBe('Ctrl+Shift+ArrowLeft')
    expect(s.taskNextKey).toBe('Ctrl+Shift+ArrowDown')
    expect(s.taskPrevKey).toBe('Ctrl+Shift+ArrowUp')
    expect(s.newSessionKey).toBe('Ctrl+Shift+KeyN')
    expect(s.newTaskKey).toBe('Ctrl+Shift+KeyT')
    expect(s.closeSessionKey).toBe('Ctrl+Shift+KeyW')
    expect(s.searchKey).toBe('Ctrl+Shift+KeyF')
    expect(s.copyKey).toBe('Ctrl+Shift+KeyC')
    expect(s.pasteKey).toBe('Ctrl+Shift+KeyV')
  })

  it('round-trips copy/paste keys through a patch, independently', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { copyKey: 'Alt+KeyY' })
    expect(merged.copyKey).toBe('Alt+KeyY')
    expect(merged.pasteKey).toBe('Ctrl+Shift+KeyV') // untouched
  })
})

describe('mergeSettings (deep-merge, §6.4)', () => {
  it('keeps sibling nested keys when patching only one', () => {
    const base = mergeSettings(DEFAULT_SETTINGS, {
      worktree: { location: '/wt' },
      terminal: { shell: '/bin/zsh' }
    })
    const merged = mergeSettings(base, { worktree: { location: '/wt2' } })
    expect(merged.worktree.location).toBe('/wt2')
    expect(merged.terminal.shell).toBe('/bin/zsh') // preserved
  })

  it('round-trips session next/prev keys through a patch, independently', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      sessionNextKey: 'ArrowDown',
      sessionPrevKey: 'ArrowUp'
    })
    expect(merged.sessionNextKey).toBe('ArrowDown')
    expect(merged.sessionPrevKey).toBe('ArrowUp')
    // Patching only one leaves the other untouched.
    const next = mergeSettings(merged, { sessionNextKey: 'ArrowRight' })
    expect(next.sessionNextKey).toBe('ArrowRight')
    expect(next.sessionPrevKey).toBe('ArrowUp')
  })

  it('ignores wrong-typed values, keeping the base', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      defaultSessionTypeId: 123 as unknown as string,
      worktreeCreateTimeoutMs: 'nope' as unknown as number
    })
    expect(merged.defaultSessionTypeId).toBe('terminal')
    expect(merged.worktreeCreateTimeoutMs).toBeUndefined()
  })
})

describe('JsonSettingsStore (I16 — no secrets, atomic write)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-settings-'))
    path = join(dir, 'settings.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads defaults without creating a file on first run', () => {
    const store = new JsonSettingsStore(path)
    expect(store.load()).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(path)).toBe(false)
  })

  it('persists a save and reloads it from disk', () => {
    const store = new JsonSettingsStore(path)
    store.load()
    const saved = store.save({ worktree: { location: '/opt/worktrees' } })
    expect(saved.worktree.location).toBe('/opt/worktrees')

    const reopened = new JsonSettingsStore(path)
    expect(reopened.load().worktree.location).toBe('/opt/worktrees')
  })

  it('merges successive saves without dropping earlier keys', () => {
    const store = new JsonSettingsStore(path)
    store.load()
    store.save({ worktree: { location: '/opt/worktrees' } })
    store.save({ terminal: { shell: '/bin/zsh' } })
    const onDisk = parseSettings(readFileSync(path, 'utf8'))
    expect(onDisk.worktree).toEqual({ location: '/opt/worktrees' })
    expect(onDisk.terminal.shell).toBe('/bin/zsh')
  })

  it('degrades a corrupt file to defaults on load', () => {
    writeFileSync(path, '{ this is not json', 'utf8')
    const store = new JsonSettingsStore(path)
    expect(store.load()).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips through serialize with a trailing newline', () => {
    const text = serializeSettings(DEFAULT_SETTINGS)
    expect(text.endsWith('\n')).toBe(true)
    expect(parseSettings(text)).toEqual(DEFAULT_SETTINGS)
  })
})
