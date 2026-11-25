import { deepFreeze, type OsProfile } from './profile'

/** Linux: the historical behaviour every other OS used to fall back to. */
export const linux: OsProfile = deepFreeze({
  id: 'linux',
  paths: { separator: '/', dataDirBase: 'xdg', maxUnixSocketPathBytes: 107 },
  keyboard: { primaryModifier: 'Ctrl', modifierLabels: 'words' },
  terminal: {
    defaultShell: '/bin/bash',
    defaultLang: null,
    fontFamily: 'monospace',
    optionIsMeta: false,
    metaChordsSkipPty: false
  },
  proc: { cwdProbe: 'proc', raiseFileLimit: true, adoptLoginShellEnv: false },
  fs: { pathCanonical: 'exact' },
  tls: { caSource: 'pem-file' },
  app: { appMenu: 'none', devDockIcon: false },
  update: {
    releaseMarkers: ['install.sh', 'linux-unpacked/octopus'],
    installScript: 'install.sh',
    relaunchExecutable: (_home: string, programDir: string) => `${programDir}/octopus`,
    defaultUpdatesDir: () => '/mnt/scratch/octopus'
  }
} satisfies OsProfile)
