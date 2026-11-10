import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readlinkSync,
  rmSync,
  chmodSync,
  realpathSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const INSTALL_SH = resolve(__dirname, '../../install.sh')

describe('install.sh (stage-and-swap)', () => {
  let sandbox: string
  let home: string
  let xdgData: string
  let release: string

  const programDir = (): string => join(xdgData, 'octopus-app')

  function makeRelease(dir: string, marker: string): void {
    mkdirSync(join(dir, 'linux-unpacked', 'resources'), { recursive: true })
    writeFileSync(join(dir, 'linux-unpacked', 'octopus'), `#!/bin/sh\necho ${marker}\n`)
    chmodSync(join(dir, 'linux-unpacked', 'octopus'), 0o755)
    writeFileSync(join(dir, 'linux-unpacked', 'resources', 'data.txt'), marker)
    writeFileSync(join(dir, 'linux-unpacked', 'octopus-cli'), '#!/bin/sh\n')
    chmodSync(join(dir, 'linux-unpacked', 'octopus-cli'), 0o755)
    mkdirSync(join(dir, 'claude-skill', 'octopus'), { recursive: true })
    writeFileSync(join(dir, 'claude-skill', 'octopus', 'SKILL.md'), marker)
    writeFileSync(join(dir, 'claude-skill', 'octopus', '.octopus-managed'), '')
    writeFileSync(join(dir, 'icon.png'), 'png')
    writeFileSync(join(dir, 'install.sh'), readFileSync(INSTALL_SH))
  }

  // A PATH-first `cp` that always fails, to force a failure at install.sh's payload copy.
  function failingCpShim(): string {
    const shim = join(sandbox, 'shim')
    mkdirSync(shim, { recursive: true })
    writeFileSync(join(shim, 'cp'), '#!/bin/sh\necho "cp: shim failure" >&2\nexit 1\n')
    chmodSync(join(shim, 'cp'), 0o755)
    return shim
  }

  function runInstall(dir: string, prependPath?: string) {
    // Safety: never run against anything but the sandbox.
    expect(home.startsWith(sandbox)).toBe(true)
    expect(sandbox.startsWith(realpathSync(tmpdir()))).toBe(true)
    return spawnSync('sh', [join(dir, 'install.sh')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: prependPath ? `${prependPath}:${process.env.PATH}` : process.env.PATH,
        HOME: home,
        XDG_DATA_HOME: xdgData,
        XDG_CONFIG_HOME: join(home, '.config')
      }
    })
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(realpathSync(tmpdir()), 'octo-install-'))
    home = join(sandbox, 'home')
    xdgData = join(home, '.local', 'share')
    mkdirSync(xdgData, { recursive: true })
    release = join(sandbox, 'octopus-2.0.0')
    makeRelease(release, 'v2')
  })
  afterEach(() => {
    // Restore perms so rm can descend.
    spawnSync('chmod', ['-R', 'u+rwX', sandbox])
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('fresh install: payload, launcher symlink, icon and .desktop file', () => {
    const r = runInstall(release)
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(programDir(), 'resources', 'data.txt'), 'utf8')).toBe('v2')
    expect(existsSync(`${programDir()}.new`)).toBe(false)
    expect(existsSync(`${programDir()}.old`)).toBe(false)

    const link = join(home, '.local', 'bin', 'octopus')
    expect(readlinkSync(link)).toBe(join(programDir(), 'octopus'))
    expect(readlinkSync(join(home, '.local', 'bin', 'octopus-cli'))).toBe(
      join(programDir(), 'octopus-cli')
    )
    expect(readFileSync(join(home, '.claude', 'skills', 'octopus', 'SKILL.md'), 'utf8')).toBe('v2')

    const desktop = readFileSync(join(xdgData, 'applications', 'octopus.desktop'), 'utf8')
    expect(desktop).toContain('Name=Octopus')
    expect(desktop).toContain(`Exec="${link}"`)
    expect(desktop).toContain('StartupWMClass=octopus')
    expect(existsSync(join(xdgData, 'icons/hicolor/512x512/apps/octopus.png'))).toBe(true)
  })

  it('upgrade replaces the payload and leaves no .new/.old, preserving the data dir', () => {
    expect(runInstall(release).status).toBe(0)
    mkdirSync(join(xdgData, 'octopus'), { recursive: true })
    writeFileSync(join(xdgData, 'octopus', 'octopus.db'), 'user-data')
    // Old install has a file the new one does not.
    writeFileSync(join(programDir(), 'stale.txt'), 'old')

    const rel3 = join(sandbox, 'octopus-3.0.0')
    makeRelease(rel3, 'v3')
    const r = runInstall(rel3)
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(programDir(), 'resources', 'data.txt'), 'utf8')).toBe('v3')
    expect(existsSync(join(programDir(), 'stale.txt'))).toBe(false)
    expect(existsSync(`${programDir()}.new`)).toBe(false)
    expect(existsSync(`${programDir()}.old`)).toBe(false)
    expect(readFileSync(join(xdgData, 'octopus', 'octopus.db'), 'utf8')).toBe('user-data')
  })

  it('runs non-interactively from any cwd (as the in-app updater does)', () => {
    const r = spawnSync('sh', [join(release, 'install.sh')], {
      cwd: sandbox,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: xdgData }
    })
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(join(programDir(), 'octopus'))).toBe(true)
  })

  it('fails when the payload binary is missing, leaving the old install intact', () => {
    expect(runInstall(release).status).toBe(0)
    const bad = join(sandbox, 'octopus-9.9.9')
    makeRelease(bad, 'v9')
    rmSync(join(bad, 'linux-unpacked', 'octopus'))
    const r = runInstall(bad)
    expect(r.status).not.toBe(0)
    expect(readFileSync(join(programDir(), 'resources', 'data.txt'), 'utf8')).toBe('v2')
    expect(existsSync(`${programDir()}.new`)).toBe(false)
  })

  it('fails when icon.png is missing, leaving the old install intact', () => {
    expect(runInstall(release).status).toBe(0)
    const bad = join(sandbox, 'octopus-9.9.9')
    makeRelease(bad, 'v9')
    rmSync(join(bad, 'icon.png'))
    expect(runInstall(bad).status).not.toBe(0)
    expect(readFileSync(join(programDir(), 'resources', 'data.txt'), 'utf8')).toBe('v2')
  })

  it.skipIf(process.getuid?.() === 0)(
    'an unreadable payload file aborts the copy: non-zero, old app intact, no .new left',
    () => {
      expect(runInstall(release).status).toBe(0)
      const bad = join(sandbox, 'octopus-9.9.9')
      makeRelease(bad, 'v9')
      chmodSync(join(bad, 'linux-unpacked', 'resources', 'data.txt'), 0o000)
      const r = runInstall(bad)
      expect(r.status).not.toBe(0)
      expect(readFileSync(join(programDir(), 'resources', 'data.txt'), 'utf8')).toBe('v2')
      expect(existsSync(`${programDir()}.new`)).toBe(false)
      expect(existsSync(`${programDir()}.old`)).toBe(false)
    }
  )

  it('restores a previous install left as .old before staging, even if the run then fails', () => {
    // Simulate a crash between the two swap renames: live dir missing, .old present.
    mkdirSync(`${programDir()}.old`, { recursive: true })
    writeFileSync(join(`${programDir()}.old`, 'marker'), 'prev')
    expect(existsSync(programDir())).toBe(false)
    // The copy fails after the restore step, so only the restore can put 'prev' back live.
    const r = runInstall(release, failingCpShim())
    expect(r.status).not.toBe(0)
    expect(readFileSync(join(programDir(), 'marker'), 'utf8')).toBe('prev')
    expect(existsSync(`${programDir()}.old`)).toBe(false)
    expect(existsSync(`${programDir()}.new`)).toBe(false)
  })

  it('a failing payload copy (root-independent) leaves the old app intact and exits non-zero', () => {
    expect(runInstall(release).status).toBe(0)
    const rel3 = join(sandbox, 'octopus-3.0.0')
    makeRelease(rel3, 'v3')
    const r = runInstall(rel3, failingCpShim())
    expect(r.status).not.toBe(0)
    expect(readFileSync(join(programDir(), 'resources', 'data.txt'), 'utf8')).toBe('v2')
    expect(existsSync(`${programDir()}.new`)).toBe(false)
    expect(existsSync(`${programDir()}.old`)).toBe(false)
  })

  it('a post-swap best-effort failure (unlinkable ~/.local/bin) warns but still exits 0', () => {
    writeFileSync(join(home, '.local', 'bin'), 'a regular file, not a dir')
    const r = runInstall(release)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toMatch(/warning:/)
    expect(readFileSync(join(programDir(), 'resources', 'data.txt'), 'utf8')).toBe('v2')
  })
})
