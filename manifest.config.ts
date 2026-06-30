import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Recall',
  version: '0.0.1',
  // Localized description. The strings live in public/_locales/{en,ko}/messages.json;
  // Chrome resolves __MSG_appDesc__ at load from the user's UI language, falling back to
  // default_locale ('en').
  default_locale: 'en',
  description: '__MSG_appDesc__',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  // Bare action (no popup): the toolbar icon is clickable and, via
  // setPanelBehavior({openPanelOnActionClick:true}) in src/background/index.ts, opens the
  // side panel. The popup is gone; the side panel is the only UI surface.
  action: {
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
    },
  },
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
  // Keyboard shortcuts. open-panel TOGGLES the side panel (the SW calls sidePanel.open in the
  // command handler - a command is a user gesture - or posts a close signal to an already-open
  // panel). Users can rebind at chrome://extensions/shortcuts.
  commands: {
    'open-panel': {
      suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
      description: 'Toggle the Recall side panel',
    },
  },
})
