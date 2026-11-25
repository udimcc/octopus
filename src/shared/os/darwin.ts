import { deepFreeze, type OsProfile } from './profile'

/**
 * macOS. The data dir deliberately shares the XDG convention (`~/.local/share/octopus`,
 * see `data-paths.ts`). Unix socket paths are shorter (`sun_path` is 104 incl. NUL).
 * The filesystem is case-insensitive and `/tmp` is a symlink, hence realpath-casefold.
 * GUI apps start with a bare env, hence the login-shell env adoption.
 */
export const darwin: OsProfile = deepFreeze({
  id: 'darwin',
  paths: { separator: '/', dataDirBase: 'xdg', maxUnixSocketPathBytes: 103 },
  keyboard: { primaryModifier: 'Meta', modifierLabels: 'glyphs' },
  terminal: {
    // The macOS default login shell since 10.15.
    defaultShell: '/bin/zsh',
    // A Finder/Dock-launched app inherits no locale; without one, UTF-8 breaks in shells.
    defaultLang: 'en_US.UTF-8',
    // The generic `monospace` resolves to Courier on macOS.
    fontFamily: "Menlo, 'SF Mono', Monaco, monospace",
    optionIsMeta: true,
    metaChordsSkipPty: true
  },
  proc: { cwdProbe: 'lsof', raiseFileLimit: false, adoptLoginShellEnv: true },
  fs: { pathCanonical: 'realpath-casefold' },
  tls: { caSource: 'keychain' },
  app: { appMenu: 'minimal', devDockIcon: true },
  update: {
    releaseMarkers: ['install-mac.sh', 'Octopus.app/Contents/MacOS/Octopus'],
    installScript: 'install-mac.sh',
    // install-mac.sh installs to ~/Applications/Octopus.app (its default).
    relaunchExecutable: (home: string) => `${home}/Applications/Octopus.app/Contents/MacOS/Octopus`,
    defaultUpdatesDir: (home: string) =>
      `${home}/Library/CloudStorage/Egnyte-finalisrael/Shared/Installation/octopus`
  }
} satisfies OsProfile)
