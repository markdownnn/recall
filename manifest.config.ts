import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Recall',
  version: '0.0.1',
  description: 'Local-first research recall (walking skeleton)',
  action: { default_popup: 'src/ui/popup/index.html' },
  // Side-panel SPIKE (additive): the popup above is kept intact so existing e2e still
  // work. With both default_popup AND setPanelBehavior({openPanelOnActionClick:true})
  // set (see src/background/index.ts), Chrome opens the PANEL on toolbar click - that is
  // what this spike validates. The popup page still exists for the goto-based e2e.
  side_panel: { default_path: 'src/ui/sidepanel/index.html' },
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
  permissions: ['unlimitedStorage', 'activeTab', 'offscreen', 'sidePanel'],
  host_permissions: ['<all_urls>'],
  // Keyboard shortcuts. open-panel opens the side panel (the SW calls sidePanel.open in
  // the command handler - a command is a user gesture); capture-page is handled by the
  // service worker. Users can rebind at chrome://extensions/shortcuts.
  // (default_popup above is kept for now; a later bundle removes the popup.)
  commands: {
    'open-panel': {
      suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
      description: 'Open the Recall side panel',
    },
    'capture-page': {
      suggested_key: { default: 'Ctrl+Shift+U', mac: 'Command+Shift+U' },
      description: 'Capture the current page',
    },
  },
})
