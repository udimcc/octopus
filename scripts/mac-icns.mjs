// Render build/icon.png into release/.mac-icon/icon.icns with macOS's own sips + iconutil.
//
// Why: given a .png, electron-builder 26 converts it to .icns with its "icons" toolset, which it
// DOWNLOADS from github.com (electron-userland/electron-builder-binaries, icons@1.1.0). That is
// unreachable on the internal network, so `build:unpack:mac` runs this first and
// electron-builder.mac.yml points `mac.icon` at the ready-made .icns (used as-is, no download).
// macOS only; the Linux build never runs it.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { isMacHost } from './lib/host.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(repoRoot, 'build', 'icon.png')
const outDir = join(repoRoot, 'release', '.mac-icon')
const iconset = join(outDir, 'icon.iconset')
const icns = join(outDir, 'icon.icns')

function run(bin, args) {
  const res = spawnSync(bin, args, { stdio: ['ignore', 'ignore', 'inherit'] })
  if (res.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed (exit ${res.status})`)
}

try {
  if (!isMacHost()) throw new Error('mac-icns.mjs runs on macOS only')
  if (!existsSync(src)) throw new Error(`missing ${src} — run \`npm run render:icon\` first`)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  // The sizes iconutil expects in an .iconset (name → pixel size).
  for (const size of [16, 32, 128, 256, 512]) {
    run('sips', [
      '-z',
      `${size}`,
      `${size}`,
      src,
      '--out',
      join(iconset, `icon_${size}x${size}.png`)
    ])
    const x2 = size * 2
    run('sips', [
      '-z',
      `${x2}`,
      `${x2}`,
      src,
      '--out',
      join(iconset, `icon_${size}x${size}@2x.png`)
    ])
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', icns])
  rmSync(iconset, { recursive: true, force: true })
  process.stdout.write(`mac icon ready: ${icns}\n`)
} catch (err) {
  process.stderr.write(`mac-icns FAILED: ${err.message}\n`)
  process.exit(1)
}
