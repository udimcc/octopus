import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
  chmodSync
} from 'node:fs'
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
    expect(
      parseSettings(JSON.stringify({ terminal: { backend: 'daemon' } })).terminal.backend
    ).toBe('daemon')
    expect(
      parseSettings(JSON.stringify({ terminal: { backend: 'in-process' } })).terminal.backend
    ).toBe('in-process')
    // Unknown backend → undefined (tolerant parse), so the composition root's
    // default (daemon) applies — only an explicit 'in-process' opts out. Absent by
    // default (no key in DEFAULT_SETTINGS).
    expect(
      parseSettings(JSON.stringify({ terminal: { backend: 'bogus' } })).terminal.backend
    ).toBeUndefined()
    expect(parseSettings('{}').terminal.backend).toBeUndefined()
  })

  it('statusChangeNotifications is absent by default (→ on) and round-trips an explicit false (§9.5)', () => {
    // Absent by default (no key in DEFAULT_SETTINGS) → the `!== false` read-site
    // convention treats it as on. Absence is preserved (not materialized to true),
    // so DEFAULT_SETTINGS stays a serialize→parse fixed point.
    expect(parseSettings('{}').terminal.statusChangeNotifications).toBeUndefined()
    // Explicit false round-trips.
    expect(
      parseSettings(JSON.stringify({ terminal: { statusChangeNotifications: false } })).terminal
        .statusChangeNotifications
    ).toBe(false)
    // A patch flips it and back without disturbing sibling terminal keys.
    const off = mergeSettings(DEFAULT_SETTINGS, { terminal: { statusChangeNotifications: false } })
    expect(off.terminal.statusChangeNotifications).toBe(false)
    const on = mergeSettings(off, { terminal: { statusChangeNotifications: true } })
    expect(on.terminal.statusChangeNotifications).toBe(true)
    // A wrong-typed value falls back to the current value (undefined by default).
    const bad = mergeSettings(DEFAULT_SETTINGS, {
      terminal: { statusChangeNotifications: 'yes' as unknown as boolean }
    })
    expect(bad.terminal.statusChangeNotifications).toBeUndefined()
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

  it('groupTasksByRepo defaults to true and toggles to false through a patch', () => {
    expect(DEFAULT_SETTINGS.groupTasksByRepo).toBe(true)
    // A `false` patch must survive (a naive `patch.x || base.x` would drop it).
    expect(mergeSettings(DEFAULT_SETTINGS, { groupTasksByRepo: false }).groupTasksByRepo).toBe(
      false
    )
    // Non-boolean values fall back to the base.
    expect(
      mergeSettings(DEFAULT_SETTINGS, {
        groupTasksByRepo: 'yes' as unknown as boolean
      }).groupTasksByRepo
    ).toBe(true)
  })

  it('stateDetection and injectClaudeHooks round-trip (previously dropped on every save, §9/§9.2)', () => {
    expect(parseSettings('{}').terminal.stateDetection).toBeUndefined()
    expect(parseSettings('{}').terminal.injectClaudeHooks).toBeUndefined()

    const off = mergeSettings(DEFAULT_SETTINGS, {
      terminal: { stateDetection: false, injectClaudeHooks: false }
    })
    expect(off.terminal.stateDetection).toBe(false)
    expect(off.terminal.injectClaudeHooks).toBe(false)

    const on = mergeSettings(off, {
      terminal: { stateDetection: true, injectClaudeHooks: true }
    })
    expect(on.terminal.stateDetection).toBe(true)
    expect(on.terminal.injectClaudeHooks).toBe(true)

    // A full serialize → parse round trip preserves both (the regression this
    // guards against: they used to be silently dropped on every save).
    const text = serializeSettings(off)
    const reparsed = parseSettings(text)
    expect(reparsed.terminal.stateDetection).toBe(false)
    expect(reparsed.terminal.injectClaudeHooks).toBe(false)
  })
})

describe('pickProjects / Settings.projects (§5.4, §6.3)', () => {
  it('round-trips a populated projects list through serialize → parse', () => {
    const withProjects = mergeSettings(DEFAULT_SETTINGS, {
      projects: [{ path: '/repo/a', defaultBranch: 'main' }, { path: '/repo/b' }]
    })
    const reparsed = parseSettings(serializeSettings(withProjects))
    expect(reparsed.projects).toEqual([
      { path: '/repo/a', defaultBranch: 'main' },
      { path: '/repo/b' }
    ])
  })

  it('a file without the key loads with projects === undefined ("never seeded")', () => {
    expect(parseSettings('{}').projects).toBeUndefined()
    expect(
      parseSettings(JSON.stringify({ worktree: { location: '/wt' } })).projects
    ).toBeUndefined()
  })

  it('an empty array is kept, distinct from undefined ("user removed every project")', () => {
    const empty = mergeSettings(DEFAULT_SETTINGS, { projects: [] })
    expect(empty.projects).toEqual([])
    expect(parseSettings(serializeSettings(empty)).projects).toEqual([])
  })

  it('a non-array value falls back to the base (preserving undefined vs. [])', () => {
    expect(parseSettings(JSON.stringify({ projects: 'not an array' })).projects).toBeUndefined()
    const base = mergeSettings(DEFAULT_SETTINGS, { projects: [] })
    expect(mergeSettings(base, { projects: 'nope' as unknown as never }).projects).toEqual([])
  })

  it('drops entries with a missing, non-string, empty, or non-absolute path', () => {
    const parsed = parseSettings(
      JSON.stringify({
        projects: [
          { path: '/ok' },
          { defaultBranch: 'main' }, // missing path
          { path: 42 }, // non-string path
          { path: '   ' }, // blank after trim
          { path: 'relative/dir' }, // not absolute
          'not an object',
          null
        ]
      })
    )
    expect(parsed.projects).toEqual([{ path: '/ok' }])
  })

  it('trims the path', () => {
    const parsed = parseSettings(JSON.stringify({ projects: [{ path: '  /repo/a  ' }] }))
    expect(parsed.projects).toEqual([{ path: '/repo/a' }])
  })

  it('drops a bad defaultBranch without dropping the entry', () => {
    const parsed = parseSettings(
      JSON.stringify({
        projects: [
          { path: '/repo/a', defaultBranch: 123 },
          { path: '/repo/b', defaultBranch: '' },
          { path: '/repo/c', defaultBranch: 'main' }
        ]
      })
    )
    expect(parsed.projects).toEqual([
      { path: '/repo/a' },
      { path: '/repo/b' },
      { path: '/repo/c', defaultBranch: 'main' }
    ])
  })

  it('DEFAULT_SETTINGS has no projects key and is a serialize → parse fixed point', () => {
    expect('projects' in DEFAULT_SETTINGS).toBe(false)
    expect(parseSettings(serializeSettings(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS)
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

  it('save({}) keeps the existing projects untouched', () => {
    const store = new JsonSettingsStore(path)
    store.load()
    store.save({ projects: [{ path: '/repo/a' }] })
    const saved = store.save({})
    expect(saved.projects).toEqual([{ path: '/repo/a' }])
  })
})

describe('JsonSettingsStore.loadFailed (§6.3)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-settings-'))
    path = join(dir, 'settings.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is false before any load() (nothing attempted yet)', () => {
    const store = new JsonSettingsStore(path)
    expect(store.loadFailed()).toBe(false)
  })

  it('is false for ENOENT (first run / unconfigured install)', () => {
    const store = new JsonSettingsStore(path)
    store.load()
    expect(store.loadFailed()).toBe(false)
  })

  it('is false for a valid file', () => {
    writeFileSync(path, serializeSettings(DEFAULT_SETTINGS), 'utf8')
    const store = new JsonSettingsStore(path)
    store.load()
    expect(store.loadFailed()).toBe(false)
  })

  it('is true for an unparseable file', () => {
    writeFileSync(path, '{ not json', 'utf8')
    const store = new JsonSettingsStore(path)
    store.load()
    expect(store.loadFailed()).toBe(true)
  })

  it('is true for a top-level JSON array', () => {
    writeFileSync(path, '[1, 2, 3]', 'utf8')
    const store = new JsonSettingsStore(path)
    store.load()
    expect(store.loadFailed()).toBe(true)
  })

  it('is true when settings.json is a directory (EISDIR, a non-ENOENT read error)', () => {
    mkdirSync(path)
    const store = new JsonSettingsStore(path)
    store.load()
    expect(store.loadFailed()).toBe(true)
  })

  it('reflects only the MOST RECENT load() — recovers once the file is fixed', () => {
    writeFileSync(path, '{ not json', 'utf8')
    const store = new JsonSettingsStore(path)
    store.load()
    expect(store.loadFailed()).toBe(true)

    writeFileSync(path, serializeSettings(DEFAULT_SETTINGS), 'utf8')
    store.load()
    expect(store.loadFailed()).toBe(false)
  })
})

describe('JsonSettingsStore.save re-reads disk before merging (§6.3)', () => {
  let dir: string
  let path: string
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-settings-'))
    path = join(dir, 'settings.json')
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('merges over a fresh parse when the on-disk file still parses, surviving a hand repair', () => {
    const store = new JsonSettingsStore(path)
    store.load() // ENOENT; cache = DEFAULT_SETTINGS

    // The user hand-repairs the file (adds a field `save` has never seen in its
    // in-memory cache) after `load()`, between load and the next save.
    writeFileSync(
      path,
      serializeSettings(mergeSettings(DEFAULT_SETTINGS, { worktree: { location: '/repaired' } })),
      'utf8'
    )

    const saved = store.save({ terminal: { shell: '/bin/zsh' } })
    // The hand-repaired value survives — it was merged over the FRESH parse, not
    // the stale in-memory cache.
    expect(saved.worktree.location).toBe('/repaired')
    expect(saved.terminal.shell).toBe('/bin/zsh')
  })

  it('backs up a corrupt file (mode 0o600) and merges the patch over defaults', () => {
    const store = new JsonSettingsStore(path)
    // Seed a non-default in-memory cache first, so "merged over DEFAULT_SETTINGS"
    // below can be told apart from "merged over the stale cache" (both would
    // otherwise look identical, since a fresh store's cache IS DEFAULT_SETTINGS).
    writeFileSync(
      path,
      serializeSettings(mergeSettings(DEFAULT_SETTINGS, { worktree: { location: '/cached' } })),
      'utf8'
    )
    store.load()
    writeFileSync(path, '{ this is corrupt', 'utf8')

    const saved = store.save({ terminal: { shell: '/bin/zsh' } })
    expect(saved.terminal.shell).toBe('/bin/zsh')
    // No stray fields from the corrupt file leaked through — merged over defaults,
    // NOT the in-memory cache (which still holds '/cached' from the load above).
    expect(saved.worktree.location).toBe(DEFAULT_SETTINGS.worktree.location)

    const liveText = readFileSync(path, 'utf8') // sanity: the live file is now valid JSON
    expect(() => JSON.parse(liveText)).not.toThrow()

    const dirEntries = readdirSync(dir)
    const backupName = dirEntries.find((f) => f.includes('.corrupt-'))
    expect(backupName).toBeDefined()
    const backupPath = join(dir, backupName!)
    expect(readFileSync(backupPath, 'utf8')).toBe('{ this is corrupt')
    expect(statSync(backupPath).mode & 0o777).toBe(0o600)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('merges over the in-memory cache on ENOENT (nothing fresh on disk to prefer)', () => {
    const store = new JsonSettingsStore(path)
    store.load()
    store.save({ worktree: { location: '/cached' } }) // writes the file once

    // Remove the file out from under the store between saves.
    rmSync(path)

    const saved = store.save({ terminal: { shell: '/bin/zsh' } })
    expect(saved.worktree.location).toBe('/cached')
    expect(saved.terminal.shell).toBe('/bin/zsh')
    // A missing file is the normal fresh-install case — no "couldn't read" warning.
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it.skipIf(process.getuid?.() === 0)(
    'warns and merges over the in-memory cache when settings.json is unreadable (EACCES, a non-ENOENT read error)',
    () => {
      writeFileSync(
        path,
        serializeSettings(mergeSettings(DEFAULT_SETTINGS, { worktree: { location: '/cached' } })),
        'utf8'
      )
      const store = new JsonSettingsStore(path)
      store.load()
      chmodSync(path, 0o000)
      try {
        const saved = store.save({ terminal: { shell: '/bin/zsh' } })
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(/could not be read before saving/)
        )
        // Merged over the cache (from the successful load above), not defaults.
        expect(saved.worktree.location).toBe('/cached')
        expect(saved.terminal.shell).toBe('/bin/zsh')
      } finally {
        chmodSync(path, 0o600)
      }
    }
  )
})
