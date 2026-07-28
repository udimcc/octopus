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

  it('defaults session next/prev keys to the Ctrl+Shift arrow chords', () => {
    expect(DEFAULT_SETTINGS.sessionNextKey).toBe('Ctrl+Shift+ArrowRight')
    expect(DEFAULT_SETTINGS.sessionPrevKey).toBe('Ctrl+Shift+ArrowLeft')
    expect(parseSettings('{}').sessionNextKey).toBe('Ctrl+Shift+ArrowRight')
    expect(parseSettings('{}').sessionPrevKey).toBe('Ctrl+Shift+ArrowLeft')
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
