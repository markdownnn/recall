import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

// The ONNX runtime wasm is served at runtime from public/onnx-hf/ via env.wasmPaths.
// onnxruntime-web ALSO references the wasm via import.meta.url, which makes Vite emit
// a second ~22MB copy under assets/ that is never loaded (wasmPaths overrides it).
// Drop that dead duplicate from the output.
function dropDuplicateOnnxWasm() {
  return {
    name: 'drop-duplicate-onnx-wasm',
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      for (const key of Object.keys(bundle)) {
        if (/^assets\/.*ort-wasm.*\.wasm$/.test(key)) delete bundle[key]
      }
    },
  }
}

// In serve mode (npm run dev) CRXJS writes dev-mode stubs to outDir.
// Use a separate directory for the production build so the dev server
// does not overwrite the extension that the E2E recall test loads.
export default defineConfig(({ command }) => ({
  plugins: [preact(), crx({ manifest }), dropDuplicateOnnxWasm()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: {
    outDir: command === 'build' ? 'dist-ext' : 'dist',
    rollupOptions: {
      // offscreen.html is not referenced by the manifest so crxjs won't pick it
      // up automatically.  Adding it here ensures Vite/Rollup bundles it and
      // emits it to dist-ext/ at the same path (src/offscreen/offscreen.html).
      input: {
        offscreen: 'src/offscreen/offscreen.html',
      },
    },
  },
}))
