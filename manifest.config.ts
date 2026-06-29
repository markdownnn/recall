import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Recall',
  version: '0.0.1',
  description: 'Local-first research recall (walking skeleton)',
  action: { default_popup: 'src/ui/popup/index.html' },
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [
    { matches: ['<all_urls>'], js: ['src/content/capture.ts'], run_at: 'document_idle' },
  ],
  // 'wasm-unsafe-eval' is required for @sqlite.org/sqlite-wasm (background) and
  // @huggingface/transformers ONNX runtime (embedder worker).  Without it Chrome's
  // default CSP blocks WebAssembly compilation and the background hangs forever.
  // connect-src is 'self' only: the ONNX WASM runtime is bundled under public/onnx-hf/,
  // and the embedding model (Xenova/multilingual-e5-small, int8 quantized) is bundled
  // under public/models/ (fetched at build time by scripts/fetch-model.mjs, pinned to
  // commit SHA 761b726dd34fb83930e26aab4e9ac3899aa1fa78).  Nothing is fetched from a
  // remote host at runtime — literally nothing leaves the device.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'",
  },
  permissions: ['unlimitedStorage', 'activeTab', 'offscreen'],
  host_permissions: ['<all_urls>'],
})
