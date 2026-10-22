// Build a distributable Octopus release: an unpacked Electron app packaged as a
// single tar.gz alongside an install/uninstall script. Air-gapped-friendly — it
// runs only local tooling and the existing offline build (see CLAUDE.md).
//
// Usage:
//   npm version <x.y.z>   # bump package.json + create the v<x.y.z> git tag
//   npm run release       # build → stage → tar
//
// Output (with version V, x86_64):
//   release/V/Octopus-V-x86_64.tar.gz   # the artifact users receive
//   release/V/octopus-V/                # its staged contents (payload + install.sh)
//
// The tarball unpacks to `octopus-V/`, which the user installs with `./install.sh`
// (symlinks a launcher into ~/.local/bin). The release version is read from
// package.json — the single source of truth, mirrored into `release/${version}` by
// electron-builder.yml. This does NOT touch the feature-set version in
// src/shared/version.ts (§10) — that is orthogonal.

import { spawnSync } from 'node:child_process'
import { existsSync, cpSync, mkdirSync, rmSync, copyFileSync, chmodSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { basename, dirname, resolve, join } from 'node:path'

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { version } = require('../package.json')
const ARCH = 'x86_64' // electron-builder.yml ships only the Linux x64 `dir` target.
const releaseDir = join(repoRoot, 'release', version)
const unpackedDir = join(releaseDir, 'linux-unpacked')
const stageName = `octopus-${version}`
const stageDir = join(releaseDir, stageName)
const tarball = join(releaseDir, `Octopus-${version}-${ARCH}.tar.gz`)

function run(label, bin, args, opts = {}) {
  process.stdout.write(`\n> ${label}\n`)
  const res = spawnSync(bin, args, { cwd: repoRoot, stdio: 'inherit', ...opts })
  if (res.status !== 0) {
    throw new Error(`${label} failed (exit ${res.status})`)
  }
}

// A release must be reproducible from a committed, tagged state. Refuse a dirty tree
// or an untagged HEAD so a shipped artifact always traces back to a `v<x.y.z>` tag.
function assertCleanTaggedTree() {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  if (status.stdout.trim() !== '') {
    throw new Error('working tree is dirty — commit or stash before releasing')
  }
  const tags = spawnSync('git', ['tag', '--points-at', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
  const onTag = tags.stdout.split('\n').some((t) => t.trim() === `v${version}`)
  if (!onTag) {
    throw new Error(
      `HEAD is not tagged v${version} — run \`npm version ${version}\` (or check out the tag) first`
    )
  }
}

// The two native .node binaries are prepared by `postinstall` (rebuild-natives.mjs)
// and shipped as-is (npmRebuild:false). Assert they exist rather than silently
// packaging a broken app; point the user at the exact fix.
function assertNativesPresent() {
  const natives = [
    'node_modules/node-pty/build/Release/pty.node',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  ]
  for (const rel of natives) {
    if (!existsSync(resolve(repoRoot, rel))) {
      throw new Error(`missing native binary ${rel} — run \`npm run rebuild:natives\` first`)
    }
  }
}

// The launcher icon is rendered ahead of time by scripts/render-icon.mjs and
// committed at build/icon.png (used by install.sh's hicolor icon theme entry and
// .desktop file) and resources/icon.png (the packaged app's window/taskbar icon,
// loaded via electron-vite's `?asset` import in src/main/window.ts) — assert both
// exist rather than shipping a launcher entry or window with a broken/missing icon.
function assertIconPresent() {
  const icons = ['build/icon.png', 'resources/icon.png']
  for (const icon of icons) {
    if (!existsSync(resolve(repoRoot, icon))) {
      throw new Error(`missing ${icon} — run \`npm run render:icon\` first`)
    }
  }
}

function build() {
  // typecheck + electron-vite build + electron-builder --dir → release/<version>/linux-unpacked
  run('build:unpack (typecheck + bundle + electron-builder --dir)', 'npm', ['run', 'build:unpack'])
  if (!existsSync(join(unpackedDir, 'octopus'))) {
    throw new Error(`expected launcher at ${join(unpackedDir, 'octopus')} — did the build change?`)
  }
}

function stage() {
  // Fresh staging dir each run so a rebuild never mixes stale payload.
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  // Copy the whole unpacked app under the versioned stage name.
  cpSync(unpackedDir, join(stageDir, 'linux-unpacked'), { recursive: true })
  // Ship the installer + uninstaller + changelog alongside the payload.
  for (const f of ['install.sh', 'uninstall.sh']) {
    const dest = join(stageDir, f)
    copyFileSync(join(repoRoot, f), dest)
    chmodSync(dest, 0o755)
  }
  // Ship the launcher icon next to install.sh — it installs it into the current
  // user's hicolor icon theme (per-user, not system-wide).
  copyFileSync(join(repoRoot, 'build', 'icon.png'), join(stageDir, 'icon.png'))
  if (existsSync(join(repoRoot, 'CHANGELOG.md'))) {
    copyFileSync(join(repoRoot, 'CHANGELOG.md'), join(stageDir, 'CHANGELOG.md'))
  }
}

function pack() {
  run('tar', 'tar', ['czf', tarball, '-C', releaseDir, stageName])
}

try {
  assertCleanTaggedTree()
  assertNativesPresent()
  assertIconPresent()
  build()
  stage()
  pack()
  process.stdout.write(`\nRelease ready: ${tarball}\n`)
  process.stdout.write(`Install: tar xzf ${basename(tarball)} && cd ${stageName} && ./install.sh\n`)
} catch (err) {
  process.stderr.write(`\nRelease FAILED: ${err.message}\n`)
  process.exit(1)
}
