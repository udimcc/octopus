import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeStateWatcher, type ClaudeStateWatcher } from './claude-state-watcher'
import { SessionState } from '../../domain/state'

/** Write a state file atomically-ish (the watcher tolerates either write style). */
function writeState(dir: string, sessionId: string, body: Record<string, unknown>): void {
  writeFileSync(join(dir, sessionId + '.json'), JSON.stringify(body), 'utf8')
}

describe('createClaudeStateWatcher', () => {
  let dir: string
  let watcher: ClaudeStateWatcher | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'octopus-claude-state-'))
  })

  afterEach(() => {
    watcher?.dispose()
    watcher = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('replays existing files on the initial scan (resume recovery)', () => {
    writeState(dir, 'sess-a', { state: 'working', reason: 'tool_use' })
    writeState(dir, 'sess-b', { state: 'blocked', reason: 'permission' })
    const seen: Array<[string, SessionState, string | undefined]> = []
    watcher = createClaudeStateWatcher({
      dir,
      sink: (id, state, meta) => seen.push([id, state, meta?.reason])
    })
    expect(seen).toContainEqual(['sess-a', SessionState.Working, 'tool_use'])
    expect(seen).toContainEqual(['sess-b', SessionState.NeedsInput, 'permission'])
  })

  it('maps every wire string to the domain enum', () => {
    writeState(dir, 'w', { state: 'waiting' })
    writeState(dir, 'g', { state: 'working' })
    writeState(dir, 'b', { state: 'blocked' })
    writeState(dir, 'u', { state: 'garbage' })
    const byId = new Map<string, SessionState>()
    watcher = createClaudeStateWatcher({ dir, sink: (id, state) => byId.set(id, state) })
    expect(byId.get('w')).toBe(SessionState.Idle)
    expect(byId.get('g')).toBe(SessionState.Working)
    expect(byId.get('b')).toBe(SessionState.NeedsInput)
    expect(byId.get('u')).toBe(SessionState.Unknown)
  })

  it('picks up a file written after start via fs.watch', async () => {
    const seen: Array<[string, SessionState]> = []
    watcher = createClaudeStateWatcher({
      dir,
      sink: (id, state) => seen.push([id, state]),
      debounceMs: 10
    })
    writeState(dir, 'late', { state: 'working' })
    // fs.watch delivery + debounce is async and platform-timed; poll briefly.
    await vi.waitFor(() => expect(seen).toContainEqual(['late', SessionState.Working]), {
      timeout: 2000,
      interval: 25
    })
  })

  it('rescan re-reads and re-emits a single session immediately', () => {
    writeState(dir, 'sess-a', { state: 'waiting' })
    const seen: Array<[string, SessionState]> = []
    watcher = createClaudeStateWatcher({ dir, sink: (id, state) => seen.push([id, state]) })
    seen.length = 0
    writeState(dir, 'sess-a', { state: 'blocked' })
    watcher.rescan('sess-a')
    expect(seen).toContainEqual(['sess-a', SessionState.NeedsInput])
  })

  it('skips a malformed file and reports it, without emitting', () => {
    writeFileSync(join(dir, 'bad.json'), '{not json', 'utf8')
    const errors: string[] = []
    const seen: string[] = []
    watcher = createClaudeStateWatcher({
      dir,
      sink: (id) => seen.push(id),
      onError: (m) => errors.push(m)
    })
    expect(seen).not.toContain('bad')
    expect(errors.some((e) => e.includes('bad.json'))).toBe(true)
  })
})
