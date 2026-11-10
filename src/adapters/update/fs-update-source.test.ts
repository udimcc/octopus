import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  chmodSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Wrap readdir so individual tests can hang or count it; real by default.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

import * as fsp from 'node:fs/promises'
import { FsUpdateSource } from './fs-update-source'
import { ChildProcessScriptRunner } from '../scripts/child-process-script-runner'
import type { ScriptResult, ScriptRunner } from '../../ports/script-runner'

const realReaddir = vi.mocked(fsp.readdir).getMockImplementation()!
const realRunner = new ChildProcessScriptRunner()

function makeRelease(
  root: string,
  name: string,
  opts: { installSh?: boolean; bin?: boolean } = {}
): string {
  const p = join(root, name)
  mkdirSync(join(p, 'linux-unpacked'), { recursive: true })
  if (opts.installSh !== false) writeFileSync(join(p, 'install.sh'), '#!/bin/sh\n')
  if (opts.bin !== false) writeFileSync(join(p, 'linux-unpacked', 'octopus'), 'bin')
  return p
}

describe('FsUpdateSource', () => {
  let root: string
  let staging: string
  let src: FsUpdateSource

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'octo-upd-'))
    staging = join(root, 'staging')
    src = new FsUpdateSource({ stagingRoot: staging, stageTimeoutMs: 5000, runner: realRunner })
    vi.mocked(fsp.readdir).mockImplementation(realReaddir)
  })
  afterEach(() => {
    vi.mocked(fsp.readdir).mockClear()
    rmSync(root, { recursive: true, force: true })
  })

  describe('listCandidates', () => {
    it('lists only dirs with install.sh and linux-unpacked/octopus', async () => {
      const rel = join(root, 'rel')
      mkdirSync(rel)
      makeRelease(rel, 'octopus-1.2.0')
      makeRelease(rel, 'octopus-1.3.0', { installSh: false })
      makeRelease(rel, 'octopus-1.4.0', { bin: false })
      writeFileSync(join(rel, 'octopus-9.9.9'), 'a file, not a dir')
      const res = await src.listCandidates(rel, 2000)
      expect(res).toEqual({
        kind: 'ok',
        candidates: [{ name: 'octopus-1.2.0', path: join(rel, 'octopus-1.2.0') }]
      })
    })

    it("returns names unparsed (malformed names are the caller's concern)", async () => {
      const rel = join(root, 'rel')
      mkdirSync(rel)
      makeRelease(rel, 'octopus-v1.2')
      const res = await src.listCandidates(rel, 2000)
      expect(res.kind === 'ok' && res.candidates.map((c) => c.name)).toEqual(['octopus-v1.2'])
    })

    it('empty dir is ok with no candidates', async () => {
      const rel = join(root, 'rel')
      mkdirSync(rel)
      expect(await src.listCandidates(rel, 2000)).toEqual({ kind: 'ok', candidates: [] })
    })

    it('missing root is unreachable', async () => {
      const res = await src.listCandidates(join(root, 'nope'), 2000)
      expect(res.kind).toBe('unreachable')
    })

    it('a never-resolving readdir is unreachable via the timeout', async () => {
      vi.mocked(fsp.readdir).mockImplementation((() => new Promise(() => {})) as never)
      const res = await src.listCandidates('/hung', 30)
      expect(res.kind).toBe('unreachable')
      expect(res.kind === 'unreachable' && res.reason).toMatch(/timed out after 30 ms/)
    })

    it('reuses a pending scan per dir instead of starting another readdir', async () => {
      let release!: (v: unknown[]) => void
      vi.mocked(fsp.readdir).mockImplementation(
        (() => new Promise((r) => (release = r as never))) as never
      )
      const a = await src.listCandidates('/slow', 10)
      const b = await src.listCandidates('/slow', 10)
      expect(a.kind).toBe('unreachable')
      expect(b.kind).toBe('unreachable')
      expect(vi.mocked(fsp.readdir)).toHaveBeenCalledTimes(1)
      // Once the abandoned read finishes the entry is forgotten; the next check rescans.
      release([])
      await new Promise((r) => setTimeout(r, 0))
      vi.mocked(fsp.readdir).mockImplementation(realReaddir)
      await src.listCandidates('/slow', 10)
      expect(vi.mocked(fsp.readdir)).toHaveBeenCalledTimes(2)
    })

    it('different dirs do not share a pending scan', async () => {
      vi.mocked(fsp.readdir).mockImplementation((() => new Promise(() => {})) as never)
      await src.listCandidates('/a', 10)
      await src.listCandidates('/b', 10)
      expect(vi.mocked(fsp.readdir)).toHaveBeenCalledTimes(2)
    })
  })

  describe('stageToTemp / cleanup', () => {
    it('copies the tree (symlink preserved verbatim) and cleanup removes it', async () => {
      const rel = makeRelease(root, 'octopus-1.2.0')
      symlinkSync('octopus', join(rel, 'linux-unpacked', 'link'))
      symlinkSync('/abs/nowhere', join(rel, 'abs-link'))
      const tmp = await src.stageToTemp(rel)
      expect(tmp.startsWith(staging)).toBe(true)
      expect(existsSync(join(tmp, 'install.sh'))).toBe(true)
      expect(existsSync(join(tmp, 'linux-unpacked', 'octopus'))).toBe(true)
      expect(lstatSync(join(tmp, 'linux-unpacked', 'link')).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(tmp, 'linux-unpacked', 'link'))).toBe('octopus')
      expect(readlinkSync(join(tmp, 'abs-link'))).toBe('/abs/nowhere')
      await src.cleanup(tmp)
      expect(existsSync(tmp)).toBe(false)
    })

    it('copies app.asar as a plain file, byte for byte, and keeps the exec bit', async () => {
      // Regression: fs.cp in Electron's main process treats *.asar as a directory and
      // wrote an "Invalid package" archive; the copy must be a plain child-process cp.
      const rel = makeRelease(root, 'octopus-1.2.0')
      chmodSync(join(rel, 'linux-unpacked', 'octopus'), 0o755)
      mkdirSync(join(rel, 'linux-unpacked', 'resources'))
      const asar = Buffer.from([0x04, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef])
      writeFileSync(join(rel, 'linux-unpacked', 'resources', 'app.asar'), asar)
      const tmp = await src.stageToTemp(rel)
      const staged = join(tmp, 'linux-unpacked', 'resources', 'app.asar')
      expect(statSync(staged).isFile()).toBe(true)
      expect(readFileSync(staged).equals(asar)).toBe(true)
      expect(statSync(join(tmp, 'linux-unpacked', 'octopus')).mode & 0o111).toBe(0o111)
      await src.cleanup(tmp)
    })

    it('cleanup refuses paths outside the staging root', async () => {
      const outside = join(root, 'not-staging')
      mkdirSync(outside)
      await src.cleanup(outside)
      await src.cleanup(join(staging, 'octopus-update-x', '..', '..', 'not-staging'))
      expect(existsSync(outside)).toBe(true)
    })

    it('cleanup of a missing path never throws', async () => {
      await expect(src.cleanup(join(root, 'gone'))).resolves.toBeUndefined()
    })

    it('removes stale octopus-update-* dirs but not other entries', async () => {
      mkdirSync(join(staging, 'octopus-update-OLD'), { recursive: true })
      mkdirSync(join(staging, 'keep-me'), { recursive: true })
      const rel = makeRelease(root, 'octopus-1.2.0')
      const tmp = await src.stageToTemp(rel)
      expect(existsSync(join(staging, 'octopus-update-OLD'))).toBe(false)
      expect(existsSync(join(staging, 'keep-me'))).toBe(true)
      expect(readdirSync(staging).filter((n) => n.startsWith('octopus-update-'))).toHaveLength(1)
      await src.cleanup(tmp)
    })

    it('rejects with cp stderr and removes the temp dir when the copy fails', async () => {
      await expect(src.stageToTemp(join(root, 'missing-release'))).rejects.toThrow(
        /Copying the update failed: .*missing-release/
      )
      expect(readdirSync(staging)).toEqual([])
    })

    it('times out a hung copy, rejects, and rejects a concurrent stage (copyInFlight)', async () => {
      let finish!: () => void
      const hungCp: ScriptRunner = {
        run: (command, args, opts) => {
          if (command !== 'cp') return realRunner.run(command, args, opts)
          const dest = args[args.length - 1]!
          return new Promise<ScriptResult>((r) => {
            finish = () => {
              // The abandoned copy lands late, after the timeout path already cleaned up.
              mkdirSync(dest, { recursive: true })
              writeFileSync(join(dest, 'late.txt'), 'late')
              r({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false })
            }
          })
        }
      }
      const slow = new FsUpdateSource({ stagingRoot: staging, stageTimeoutMs: 30, runner: hungCp })
      await expect(slow.stageToTemp(root)).rejects.toThrow(/timed out/)
      await expect(slow.stageToTemp(root)).rejects.toThrow(/still in progress/)
      finish()
      // After the abandoned copy settles the guard clears and the timed-out tmp is removed.
      await vi.waitFor(() => expect(readdirSync(staging)).toEqual([]))
      const rel = makeRelease(root, 'octopus-1.2.0')
      const ok = new FsUpdateSource({
        stagingRoot: staging,
        stageTimeoutMs: 5000,
        runner: realRunner
      })
      const tmp = await ok.stageToTemp(rel)
      expect(tmp.startsWith(staging)).toBe(true)
      await ok.cleanup(tmp)
    })

    it('maps a runner-reported timeout to a timed-out error and cleans up', async () => {
      const timedOut: ScriptRunner = {
        run: (command, args, opts) =>
          command === 'cp'
            ? Promise.resolve({
                exitCode: null,
                signal: 'SIGTERM',
                stdout: '',
                stderr: '',
                timedOut: true
              })
            : realRunner.run(command, args, opts)
      }
      const s2 = new FsUpdateSource({
        stagingRoot: staging,
        stageTimeoutMs: 5000,
        runner: timedOut
      })
      await expect(s2.stageToTemp(makeRelease(root, 'octopus-1.2.0'))).rejects.toThrow(/timed out/)
      expect(readdirSync(staging)).toEqual([])
    })
  })
})
