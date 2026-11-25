import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { osProfile } from '../../shared/os'
import {
  DEFAULT_SETTINGS,
  JsonSettingsStore,
  defaultSettings,
  parseSettings,
  serializeSettings
} from './json-settings-store'

describe('defaultSettings(platform) (macOS support)', () => {
  it('returns the historical constant unchanged for every non-darwin platform', () => {
    expect(defaultSettings(osProfile('linux'))).toBe(DEFAULT_SETTINGS)
    expect(defaultSettings(osProfile('win32'))).toBe(DEFAULT_SETTINGS)
  })

  it('serializes the Linux defaults byte-identically to the pre-mac literal', () => {
    const legacy = {
      worktree: { location: '' },
      terminal: {},
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
    }
    expect(serializeSettings(defaultSettings(osProfile('linux')))).toBe(
      JSON.stringify(legacy, null, 2) + '\n'
    )
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true)
  })

  it('uses Cmd-based chords on darwin, in canonical modifier order', () => {
    const mac = defaultSettings(osProfile('darwin'))
    expect(mac.sessionNextKey).toBe('Shift+Meta+ArrowRight')
    expect(mac.newTaskKey).toBe('Shift+Meta+KeyT')
    expect(mac.copyKey).toBe('Meta+KeyC')
    expect(mac.pasteKey).toBe('Meta+KeyV')
    expect(mac.issuesKey).toBe('Shift+Meta+KeyI')
    expect(mac.worktree.location).toBe('')
    expect('projects' in mac).toBe(false)
    expect(parseSettings(serializeSettings(mac), mac)).toEqual(mac)
  })

  it('parseSettings falls back to the supplied platform defaults', () => {
    const mac = defaultSettings(osProfile('darwin'))
    expect(parseSettings('{}', mac).searchKey).toBe('Shift+Meta+KeyF')
    expect(parseSettings('not json', mac)).toBe(mac)
    expect(parseSettings('{}').searchKey).toBe('Ctrl+Shift+KeyF')
  })
})

describe('JsonSettingsStore platform defaults', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-settings-platform-'))
    path = join(dir, 'settings.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('fills missing chords from the darwin defaults on darwin', () => {
    const store = new JsonSettingsStore(path, osProfile('darwin'))
    expect(store.load()).toEqual(defaultSettings(osProfile('darwin')))
    writeFileSync(path, JSON.stringify({ newTaskKey: 'Alt+KeyT' }), 'utf8')
    const loaded = store.load()
    expect(loaded.newTaskKey).toBe('Alt+KeyT') // a persisted choice wins
    expect(loaded.pasteKey).toBe('Meta+KeyV')
  })

  it('keeps an existing Linux-style file as-is on darwin (no rewrite of stored chords)', () => {
    writeFileSync(path, serializeSettings(DEFAULT_SETTINGS), 'utf8')
    const store = new JsonSettingsStore(path, osProfile('darwin'))
    expect(store.load()).toEqual(DEFAULT_SETTINGS)
    store.save({ groupTasksByRepo: false })
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.sessionNextKey).toBe('Ctrl+Shift+ArrowRight')
  })

  it('backs a corrupt file with the platform defaults on save', () => {
    writeFileSync(path, '{not json', 'utf8')
    const store = new JsonSettingsStore(path, osProfile('darwin'))
    store.load()
    const saved = store.save({ groupTasksByRepo: false })
    expect(saved.copyKey).toBe('Meta+KeyC')
  })
})
