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
  // @xenova/transformers ONNX runtime (embedder worker).  Without it Chrome's
  // default CSP blocks WebAssembly compilation and the background hangs forever.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting'],
  host_permissions: ['<all_urls>'],
})
