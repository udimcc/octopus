// Render the Octopus app icon from its single-source SVG into the PNGs the rest
// of the build needs. No rasterizer dependency is added (none is reachable
// air-gapped): this uses Electron itself as the renderer — an offscreen
// BrowserWindow loads the SVG in a zero-margin HTML page and we capture the
// painted frame.
//
// Source of truth: src/renderer/src/assets/octopus.svg. Re-run this whenever
// that file changes.
//
// Output:
//   build/icon.png      512x512  (electron-builder's buildResources icon)
//   resources/icon.png  256x256  (runtime window icon, imported via `?asset`)
//
// Usage (must run as Electron's main process, NOT under ELECTRON_RUN_AS_NODE —
// that mode is plain Node and has no BrowserWindow/app):
//   ELECTRON_RUN_AS_NODE= electron scripts/render-icon.mjs
//   npm run render:icon

import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = resolve(repoRoot, 'src/renderer/src/assets/octopus.svg')

const targets = [
  { outPath: resolve(repoRoot, 'build/icon.png'), size: 512 },
  { outPath: resolve(repoRoot, 'resources/icon.png'), size: 256 }
]

// Force a 1:1 device pixel ratio so the offscreen capture is exactly `size`
// pixels regardless of the host's display scale factor (VDI, HiDPI, ...).
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

function htmlFor(svgMarkup, size) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    `html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden;}` +
    `svg{display:block;width:${size}px;height:${size}px;}` +
    '</style></head><body>' +
    svgMarkup +
    '</body></html>'
  )
}

// Render with a single, reused offscreen BrowserWindow (resized per target)
// rather than one window per target. Destroying the window between renders drops
// Electron's live window count to zero, which trips the DEFAULT `window-all-closed`
// handler every app has until it registers its own (none is registered here) —
// that default calls `app.quit()`, so the next window's loadFile() races a
// shutting-down app process and fails with ERR_FAILED. Keeping one window alive
// for the whole run means the count never hits zero, so quit never fires.
async function renderOne(win, svgMarkup, tmpDir, { outPath, size }) {
  win.setContentSize(size, size)

  // Inline the SVG markup directly in the page (rather than nesting it as a
  // data: URL inside another data: URL) — loadFile() on a real temp file is
  // far more reliable than loadURL() with a large inline data: URI, which
  // intermittently failed with ERR_FAILED for this SVG's size.
  const htmlPath = join(tmpDir, `octopus-icon-${size}.html`)
  writeFileSync(htmlPath, htmlFor(svgMarkup, size))

  await win.loadFile(htmlPath)
  // Static inline SVG — paint settles almost immediately, but give the
  // compositor a moment before capturing to avoid grabbing a blank frame.
  await new Promise((res) => setTimeout(res, 150))

  const image = await win.webContents.capturePage()
  const { width, height } = image.getSize()
  if (width !== size || height !== size) {
    throw new Error(`${outPath}: captured ${width}x${height}, expected ${size}x${size}`)
  }

  // Guard against silently writing a blank icon (e.g. the SVG failed to paint in
  // time): `toBitmap()` is raw BGRA pixels, so a fully transparent capture has
  // every 4th (alpha) byte at 0.
  const bitmap = image.toBitmap()
  let hasVisiblePixel = false
  for (let i = 3; i < bitmap.length; i += 4) {
    if (bitmap[i] !== 0) {
      hasVisiblePixel = true
      break
    }
  }
  if (!hasVisiblePixel) {
    throw new Error(`${outPath}: captured frame is fully transparent (blank render)`)
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, image.toPNG())
  console.log(`wrote ${outPath} (${width}x${height})`)
}

async function main() {
  await app.whenReady()

  const svgMarkup = readFileSync(svgPath, 'utf8')
  const tmpDir = mkdtempSync(join(tmpdir(), 'octopus-render-icon-'))
  const maxSize = Math.max(...targets.map((t) => t.size))

  // `win` is created INSIDE the try so a throw from the `BrowserWindow` constructor
  // itself still reaches the `finally` below and cleans up `tmpDir` — declared here
  // (rather than `const win = new BrowserWindow(...)` right in the `try`) so the
  // `finally` can check whether construction actually succeeded before destroying it.
  let win
  try {
    win = new BrowserWindow({
      width: maxSize,
      height: maxSize,
      useContentSize: true,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      webPreferences: {
        offscreen: true,
        zoomFactor: 1
      }
    })

    for (const target of targets) {
      await renderOne(win, svgMarkup, tmpDir, target)
    }
  } finally {
    win?.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

main()
  .then(() => {
    app.exit(0)
  })
  .catch((err) => {
    console.error('render-icon failed:', err)
    app.exit(1)
  })
