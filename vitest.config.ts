import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Two test projects, one per runtime the code targets (DESIGN §11):
//   - node:     domain/application/ports/adapters + main/preload + integration
//   - renderer: React components, run under jsdom with the React plugin
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['src/renderer/**']
        }
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['./test/setup-renderer.ts']
        }
      }
    ]
  }
})
