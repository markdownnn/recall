import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

// In serve mode (npm run dev) CRXJS writes dev-mode stubs to outDir.
// Use a separate directory for the production build so the dev server
// does not overwrite the extension that the E2E recall test loads.
export default defineConfig(({ command }) => ({
  plugins: [preact(), crx({ manifest })],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: {
    outDir: command === 'build' ? 'dist-ext' : 'dist',
  },
}))
