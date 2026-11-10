import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  JsonSettingsStore,
  parseSettings,
  mergeSettings,
  serializeSettings,
  DEFAULT_SETTINGS
} from './json-settings-store'

describe('updates settings group', () => {
  it('is absent by default', () => {
    expect(DEFAULT_SETTINGS.updates).toBeUndefined()
    expect(parseSettings('{}').updates).toBeUndefined()
  })

  it('parses both fields', () => {
    const s = parseSettings(JSON.stringify({ updates: { dir: '/d', dismissedVersion: '1.2.3' } }))
    expect(s.updates).toEqual({ dir: '/d', dismissedVersion: '1.2.3' })
  })

  it('merges fields independently and leaves other keys untouched', () => {
    const base = mergeSettings(DEFAULT_SETTINGS, { updates: { dir: '/d' } })
    const next = mergeSettings(base, { updates: { dismissedVersion: '2.0.0' } })
    expect(next.updates).toEqual({ dir: '/d', dismissedVersion: '2.0.0' })
    expect(next.worktree).toEqual(base.worktree)
    expect(next.terminal).toEqual(base.terminal)
  })

  it('treats a non-object patch or mistyped field as no change', () => {
    const base = mergeSettings(DEFAULT_SETTINGS, { updates: { dir: '/d' } })
    expect(mergeSettings(base, { updates: 5 } as never).updates).toEqual({ dir: '/d' })
    expect(mergeSettings(base, { updates: { dir: 7 } } as never).updates).toEqual({ dir: '/d' })
  })

  it("keeps '' as a value (means unset to consumers)", () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { updates: { dir: '' } })
    expect(s.updates?.dir).toBe('')
  })

  it('serialize -> parse round-trips', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { updates: { dir: '/d', dismissedVersion: '1.0.1' } })
    expect(parseSettings(serializeSettings(s)).updates).toEqual(s.updates)
    expect(parseSettings(serializeSettings(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS)
  })
})

describe('JsonSettingsStore updates persistence', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octo-set-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persists dismissedVersion to disk and reloads it, keeping dir', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, JSON.stringify({ updates: { dir: '/mnt/x' } }))
    const store = new JsonSettingsStore(path)
    store.save({ updates: { dismissedVersion: '1.4.0' } })
    expect(JSON.parse(readFileSync(path, 'utf8')).updates).toEqual({
      dir: '/mnt/x',
      dismissedVersion: '1.4.0'
    })
    expect(new JsonSettingsStore(path).load().updates).toEqual({
      dir: '/mnt/x',
      dismissedVersion: '1.4.0'
    })
  })

  it('absent updates group loads as undefined', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{}')
    expect(new JsonSettingsStore(path).load().updates).toBeUndefined()
  })
})
