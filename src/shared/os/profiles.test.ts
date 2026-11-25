import { describe, it, expect } from 'vitest'
import {
  PROFILES,
  osProfile,
  toOsId,
  type OsApp,
  type OsFs,
  type OsKeyboard,
  type OsPaths,
  type OsProc,
  type OsProfile,
  type OsTerminal,
  type OsTls,
  type OsUpdate
} from '.'

// Contract: every profile defines every member (a key list typed against the interface,
// so adding a member to OsProfile fails to compile until it is listed here).
const MEMBERS: Record<keyof OsProfile, true> = {
  id: true,
  paths: true,
  keyboard: true,
  terminal: true,
  proc: true,
  fs: true,
  tls: true,
  app: true,
  update: true
}
const GROUPS: { [K in Exclude<keyof OsProfile, 'id'>]: Record<keyof OsProfile[K], true> } = {
  paths: { separator: true, dataDirBase: true, maxUnixSocketPathBytes: true } satisfies Record<
    keyof OsPaths,
    true
  >,
  keyboard: { primaryModifier: true, modifierLabels: true } satisfies Record<
    keyof OsKeyboard,
    true
  >,
  terminal: {
    defaultShell: true,
    defaultLang: true,
    fontFamily: true,
    optionIsMeta: true,
    metaChordsSkipPty: true
  } satisfies Record<keyof OsTerminal, true>,
  proc: { cwdProbe: true, raiseFileLimit: true, adoptLoginShellEnv: true } satisfies Record<
    keyof OsProc,
    true
  >,
  fs: { pathCanonical: true } satisfies Record<keyof OsFs, true>,
  tls: { caSource: true } satisfies Record<keyof OsTls, true>,
  app: { appMenu: true, devDockIcon: true } satisfies Record<keyof OsApp, true>,
  update: {
    releaseMarkers: true,
    installScript: true,
    relaunchExecutable: true,
    defaultUpdatesDir: true
  } satisfies Record<keyof OsUpdate, true>
}

const sorted = (o: object): string[] => Object.keys(o).sort()

describe.each(Object.entries(PROFILES))('OS profile %s', (id, profile) => {
  it('defines exactly the OsProfile members, each group complete', () => {
    expect(sorted(profile)).toEqual(sorted(MEMBERS))
    for (const [group, keys] of Object.entries(GROUPS)) {
      const value = profile[group as keyof typeof GROUPS] as object
      expect(sorted(value), group).toEqual(sorted(keys))
      for (const key of Object.keys(keys)) {
        expect((value as Record<string, unknown>)[key], `${group}.${key}`).not.toBeUndefined()
      }
    }
  })

  it('is keyed by its own id', () => {
    expect(profile.id).toBe(id)
  })

  it('is deeply frozen', () => {
    expect(Object.isFrozen(profile)).toBe(true)
    for (const group of Object.keys(GROUPS)) {
      expect(Object.isFrozen(profile[group as keyof typeof GROUPS]), group).toBe(true)
    }
    expect(Object.isFrozen(profile.update.releaseMarkers)).toBe(true)
  })
})

describe('toOsId / osProfile', () => {
  it('maps darwin and win32, and anything else to linux', () => {
    expect(toOsId('darwin')).toBe('darwin')
    expect(toOsId('win32')).toBe('win32')
    expect(toOsId('linux')).toBe('linux')
    expect(toOsId('freebsd')).toBe('linux')
    expect(toOsId('')).toBe('linux')
  })

  it('osProfile returns the PROFILES entry', () => {
    expect(osProfile('darwin')).toBe(PROFILES.darwin)
  })
})

// Characterization: these literals are the values the code used before the OS layer.
describe('profile values (pinned)', () => {
  it('linux equals the historical constants', () => {
    const p = osProfile('linux')
    expect(p.paths).toEqual({ separator: '/', dataDirBase: 'xdg', maxUnixSocketPathBytes: 107 })
    expect(p.keyboard).toEqual({ primaryModifier: 'Ctrl', modifierLabels: 'words' })
    expect(p.terminal).toEqual({
      defaultShell: '/bin/bash',
      defaultLang: null,
      fontFamily: 'monospace',
      optionIsMeta: false,
      metaChordsSkipPty: false
    })
    expect(p.proc).toEqual({ cwdProbe: 'proc', raiseFileLimit: true, adoptLoginShellEnv: false })
    expect(p.fs.pathCanonical).toBe('exact')
    expect(p.tls.caSource).toBe('pem-file')
    expect(p.app).toEqual({ appMenu: 'none', devDockIcon: false })
    expect(p.update.releaseMarkers).toEqual(['install.sh', 'linux-unpacked/octopus'])
    expect(p.update.installScript).toBe('install.sh')
    expect(p.update.relaunchExecutable('/home/u', '/home/u/.local/share/octopus-app')).toBe(
      '/home/u/.local/share/octopus-app/octopus'
    )
    expect(p.update.defaultUpdatesDir('/home/u')).toBe('/mnt/scratch/octopus')
  })

  it('darwin', () => {
    const p = osProfile('darwin')
    expect(p.paths).toEqual({ separator: '/', dataDirBase: 'xdg', maxUnixSocketPathBytes: 103 })
    expect(p.keyboard).toEqual({ primaryModifier: 'Meta', modifierLabels: 'glyphs' })
    expect(p.terminal).toEqual({
      defaultShell: '/bin/zsh',
      defaultLang: 'en_US.UTF-8',
      fontFamily: "Menlo, 'SF Mono', Monaco, monospace",
      optionIsMeta: true,
      metaChordsSkipPty: true
    })
    expect(p.proc).toEqual({ cwdProbe: 'lsof', raiseFileLimit: false, adoptLoginShellEnv: true })
    expect(p.fs.pathCanonical).toBe('realpath-casefold')
    expect(p.tls.caSource).toBe('keychain')
    expect(p.app).toEqual({ appMenu: 'minimal', devDockIcon: true })
    expect(p.update.releaseMarkers).toEqual([
      'install-mac.sh',
      'Octopus.app/Contents/MacOS/Octopus'
    ])
    expect(p.update.installScript).toBe('install-mac.sh')
    expect(p.update.relaunchExecutable('/Users/u', '/p')).toBe(
      '/Users/u/Applications/Octopus.app/Contents/MacOS/Octopus'
    )
    expect(p.update.defaultUpdatesDir('/Users/u')).toBe(
      '/Users/u/Library/CloudStorage/Egnyte-finalisrael/Shared/Installation/octopus'
    )
  })

  it('win32 keeps the pre-OS-layer behaviour', () => {
    const p = osProfile('win32')
    expect(p.paths).toEqual({
      separator: '\\',
      dataDirBase: 'appdata',
      maxUnixSocketPathBytes: 107
    })
    expect(p.keyboard).toEqual(osProfile('linux').keyboard)
    expect(p.terminal).toEqual(osProfile('linux').terminal)
    expect(p.proc).toEqual({ cwdProbe: 'none', raiseFileLimit: false, adoptLoginShellEnv: false })
    expect(p.fs.pathCanonical).toBe('exact')
    expect(p.tls.caSource).toBe('none')
    expect(p.app).toEqual({ appMenu: 'none', devDockIcon: false })
    expect(p.update.releaseMarkers).toEqual(['install.sh', 'linux-unpacked/octopus'])
    expect(p.update.relaunchExecutable('h', '/p')).toBe('/p/octopus')
  })
})
