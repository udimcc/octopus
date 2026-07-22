import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { bootstrap } from './composition-root'

// Prepare the runtime environment and wire adapters before any window opens.
bootstrap()

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'Octopus',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security posture (DESIGN §5.5): renderer gets no Node access; the only
      // bridge is the typed window.octopusAPI exposed by the preload.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())

  // electron-vite injects ELECTRON_RENDERER_URL in dev (Vite dev server);
  // in production we load the built HTML from the renderer bundle.
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  createWindow()

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
