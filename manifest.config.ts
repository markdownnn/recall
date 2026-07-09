import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: '__MSG_appName__',
  version: '1.0.0',
  // English-only description. The strings live in public/_locales/en/messages.json.
  // Chrome resolves __MSG_appDesc__ from default_locale ('en').
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
  // 'wasm-unsafe-eval' is required for @sqlite.org/sqlite-wasm, Transformers ONNX, and WebLLM.
  // BGE and WebLLM model files are served from our R2-backed model CDN.
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://cdn.teamnyongs.com",
  },
  // 'alarms': an SW-independent re-drain. The 20s setInterval keep-alive ping does NOT survive
  // an SW reap (sleep/memory pressure/reload), so a chrome.alarms alarm (>=1min) re-creates the
  // offscreen and re-drains pending chunks even with the side panel closed.
  permissions: ['unlimitedStorage', 'activeTab', 'offscreen', 'sidePanel', 'alarms'],
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
