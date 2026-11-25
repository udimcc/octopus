import { describe, it, expect, vi } from 'vitest'
import { PtyRegistry } from './pty-registry'
import type { DaemonPtyProcess, DaemonPtySpawn } from './daemon-pty'

/** Minimal fake node-pty: a fixed pid and a test-driven exit. */
function fakeSpawn(): { spawn: DaemonPtySpawn; exit: (pid: number) => void } {
  let nextPid = 100
  const exits = new Map<number, (e: { exitCode: number }) => void>()
  const spawn: DaemonPtySpawn = () => {
    const pid = nextPid++
    const proc: DaemonPtyProcess = {
      pid,
      onData: () => ({ dispose: () => undefined }),
      onExit: (l) => {
        exits.set(pid, l)
        return { dispose: () => undefined }
      },
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    }
    return proc
  }
  return { spawn, exit: (pid) => exits.get(pid)?.({ exitCode: 0 }) }
}

const params = (sessionId: string) => ({
  sessionId,
  taskId: 't1',
  shell: '/bin/sh',
  args: [],
  cwd: '/start',
  cols: 80,
  rows: 24
})

describe('PtyRegistry.list', () => {
  it('resolves every live pid in ONE batched call; dead sessions carry no cwd', async () => {
    const f = fakeSpawn()
    const resolveCwds = vi.fn(async (pids: readonly number[]) => {
      return new Map(pids.map((p) => [p, `/cwd/${p}`] as [number, string]))
    })
    const reg = new PtyRegistry({ spawn: f.spawn, resolveCwds })
    reg.spawnSession(params('a'))
    reg.spawnSession(params('b'))
    reg.spawnSession(params('c'))
    f.exit(101) // 'b' dies but stays tracked until forgotten

    const roster = await reg.list()
    expect(resolveCwds).toHaveBeenCalledTimes(1)
    expect(resolveCwds).toHaveBeenCalledWith([100, 102])
    expect(roster.map((r) => [r.sessionId, r.alive, r.cwd])).toEqual([
      ['a', true, '/cwd/100'],
      ['b', false, undefined],
      ['c', true, '/cwd/102']
    ])
  })

  it('skips the resolver when nothing is live, and survives a resolver failure', async () => {
    const f = fakeSpawn()
    const resolveCwds = vi.fn(async () => {
      throw new Error('lsof exploded')
    })
    const reg = new PtyRegistry({ spawn: f.spawn, resolveCwds })
    await expect(reg.list()).resolves.toEqual([])
    expect(resolveCwds).not.toHaveBeenCalled()

    reg.spawnSession(params('a'))
    const roster = await reg.list()
    expect(roster).toHaveLength(1)
    expect(roster[0].cwd).toBeUndefined()
  })
})
