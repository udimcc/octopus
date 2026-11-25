import { deepFreeze, type OsProfile } from './profile'

/**
 * Windows: not yet supported. Values reproduce what win32 did before the OS layer
 * existed (the real `%APPDATA%` / `\` path handling, and "non-darwin = Linux"
 * everywhere else), with `'none'` for capabilities that have no implementation. See the
 * Windows TODO in `profile.ts`.
 */
export const win32: OsProfile = deepFreeze({
  id: 'win32',
  paths: { separator: '\\', dataDirBase: 'appdata', maxUnixSocketPathBytes: 107 },
  keyboard: { primaryModifier: 'Ctrl', modifierLabels: 'words' },
  terminal: {
    defaultShell: '/bin/bash',
    defaultLang: null,
    fontFamily: 'monospace',
    optionIsMeta: false,
    metaChordsSkipPty: false
  },
  proc: { cwdProbe: 'none', raiseFileLimit: false, adoptLoginShellEnv: false },
  fs: { pathCanonical: 'exact' },
  tls: { caSource: 'none' },
  app: { appMenu: 'none', devDockIcon: false },
  update: {
    releaseMarkers: ['install.sh', 'linux-unpacked/octopus'],
    installScript: 'install.sh',
    relaunchExecutable: (_home: string, programDir: string) => `${programDir}/octopus`,
    defaultUpdatesDir: () => '/mnt/scratch/octopus'
  }
} satisfies OsProfile)
