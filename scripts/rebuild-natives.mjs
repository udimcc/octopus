// Reproducible, air-gapped bring-up of the two V1 native modules against
// Electron 33's ABI. Run automatically as `postinstall`; safe to re-run.
//
// Why this script exists (M0 findings — the two modules need OPPOSITE strategies):
//
//   * node-pty is N-API (node-addon-api). N-API is ABI-stable across Node and
//     Electron, so a binary built against the host Node headers loads unchanged
//     inside Electron. We therefore COMPILE IT FROM SOURCE against the mirrored
//     Node headers (nodejs disturl in .npmrc). A default `npm install` can't:
//     node-gyp would try to fetch headers from nodejs.org (unreachable here).
//
//   * better-sqlite3 is V8-direct (NOT N-API), so it MUST match Electron's exact
//     ABI (NODE_MODULE_VERSION 130). Electron's node-headers are NOT on the
//     Artifactory mirror (verified 404), so it CANNOT be compiled here. Instead
//     we download WiseLibs' official prebuilt `electron-v<abi>` binary through the
//     same github-remote mirror `.npmrc` already trusts for Electron's Chromium.
//     A default `npm install` would grab the `node-v115` prebuild — wrong ABI,
//     fails to load in Electron with a NODE_MODULE_VERSION mismatch.
//
// Consequence: `npmRebuild` stays false in electron-builder.yml — there is no way
// to compile against Electron's ABI offline, so we ship these binaries as-is.
//
// All network fetches target the internal Artifactory mirror only; nothing here
// reaches github.com or the public npm registry.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Mirror bases (kept in sync with .npmrc). The Node headers disturl is also set
// in .npmrc so a bare `node-gyp rebuild` works; we pass it explicitly too so this
// script is self-contained.
//
// Both can be overridden from the environment for hosts on a different network
// (e.g. macOS dev machines, see scripts/bootstrap-mac.sh); the defaults are the
// air-gapped Linux mirror and must stay so.
const NODE_DISTURL =
  process.env.OCTOPUS_NODE_DISTURL ||
  'https://rt-isp.israel.final/artifactory/nodejs-clients-remote'
const BSQ3_BINARY_HOST =
  process.env.OCTOPUS_BSQ3_BINARY_HOST ||
  'https://rt-isp.israel.final/artifactory/github-remote/WiseLibs/better-sqlite3/releases/download'

// Electron's ABI is the single source of truth for the better-sqlite3 target.
const electronVersion = require('electron/package.json').version

function run(label, bin, args, { cwd = repoRoot, env } = {}) {
  process.stdout.write(`\n> ${label}\n`)
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (res.status !== 0) {
    throw new Error(`${label} failed (exit ${res.status})`)
  }
}

// --- node-pty: compile from source against mirrored Node headers -------------
function buildNodePty() {
  const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js')
  run('node-pty: node-gyp rebuild (N-API, vs mirrored Node headers)', nodeGyp, [
    'rebuild',
    '--directory=node_modules/node-pty',
    `--dist-url=${NODE_DISTURL}`
  ])
}

// --- better-sqlite3: fetch the prebuilt Electron-ABI binary from the mirror ---
function fetchBetterSqlite3() {
  const prebuildInstall = require.resolve('prebuild-install/bin.js')
  // prebuild-install reads ./package.json from its CWD to compute the version,
  // env prefix, and download URL — so it MUST run inside the package directory.
  run(
    `better-sqlite3: prebuild-install (electron ${electronVersion} prebuilt binary)`,
    prebuildInstall,
    ['--runtime', 'electron', `--target=${electronVersion}`, '--verbose'],
    {
      cwd: resolve(repoRoot, 'node_modules/better-sqlite3'),
      // prebuild-install reads npm_config_<pkg>_binary_host_mirror.
      env: { npm_config_better_sqlite3_binary_host_mirror: BSQ3_BINARY_HOST }
    }
  )
}

function assertBuilt(rel, what) {
  const p = resolve(repoRoot, rel)
  if (!existsSync(p)) {
    throw new Error(`${what}: expected native binary missing at ${rel}`)
  }
  process.stdout.write(`  ok: ${rel}\n`)
}

try {
  buildNodePty()
  fetchBetterSqlite3()
  assertBuilt('node_modules/node-pty/build/Release/pty.node', 'node-pty')
  assertBuilt('node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'better-sqlite3')
  process.stdout.write('\nNative modules ready for Electron 33 (ABI 130).\n')
} catch (err) {
  process.stderr.write(`\nNative bring-up FAILED: ${err.message}\n`)
  process.exit(1)
}
