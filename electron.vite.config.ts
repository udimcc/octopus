import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Bundles per Electron process (DESIGN §5.5):
//   - main + preload run in Node; externalizeDepsPlugin keeps node_modules
//     external (unbundled). This matters for V1 native modules (node-pty,
//     better-sqlite3) whose .node binaries cannot be bundled by Rollup.
//   - renderer is a browser context built with the React plugin.
//   - daemon (§6.2): a SECOND Node entry built alongside `main` (same externalize
//     config), emitted as `out/main/daemon.js`. It is the `octopusd` durable-session
//     host, launched detached via `ELECTRON_RUN_AS_NODE=1`; node-pty stays external
//     so its .node binary is required at runtime from the shipped node_modules.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          daemon: resolve(__dirname, 'src/daemon/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})
