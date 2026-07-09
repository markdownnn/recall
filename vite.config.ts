import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { crx } from '@crxjs/vite-plugin'
import { rmSync } from 'node:fs'
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

function dropCopiedModelArtifacts() {
  return {
    name: 'drop-copied-model-artifacts',
    closeBundle() {
      rmSync('dist-ext/models', { recursive: true, force: true })
    },
  }
}

function stripWebLlmPrebuiltModelCatalog() {
  return {
    name: 'strip-webllm-prebuilt-model-catalog',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.includes('@mlc-ai/web-llm/lib/index.js')) return null
      const start = code.indexOf('const prebuiltAppConfig = {')
      const end = code.indexOf('\n\n/******************************************************************************', start)
      if (start === -1 || end === -1) {
        throw new Error('Could not strip WebLLM prebuilt model catalog')
      }
      return `${code.slice(0, start)}const prebuiltAppConfig = { cacheBackend: "cache", model_list: [] };${code.slice(end)}`
    },
  }
}

function stripExternalModelOrigins() {
  return {
    name: 'strip-external-model-origins',
    generateBundle(_options: unknown, bundle: Record<string, any>) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || typeof chunk.code !== 'string') continue
        chunk.code = chunk.code
          .replaceAll('huggingface.co', 'cdn.teamnyongs.com')
          .replaceAll('raw.githubusercontent.com', 'cdn.teamnyongs.com')
          .replaceAll('githubusercontent', 'cdn.teamnyongs.com')
          .replaceAll('https://github.com', 'https://cdn.teamnyongs.com')
      }
    },
  }
}

// In serve mode (npm run dev) CRXJS writes dev-mode stubs to outDir.
// Use a separate directory for the production build so the dev server
// does not overwrite the extension that the E2E recall test loads.
export default defineConfig(({ command }) => ({
  plugins: [
    preact(),
    crx({ manifest }),
    stripWebLlmPrebuiltModelCatalog(),
    stripExternalModelOrigins(),
    dropDuplicateOnnxWasm(),
    dropCopiedModelArtifacts(),
  ],
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
        // onboarding.html is opened via chrome.tabs.create on install and is not
        // referenced by the manifest, so CRXJS won't auto-emit it. Add it here so
        // Vite/Rollup builds it to dist-ext/src/ui/onboarding/index.html.
        onboarding: 'src/ui/onboarding/index.html',
      },
    },
  },
}))
