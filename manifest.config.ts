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
  permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting'],
  host_permissions: ['<all_urls>'],
})
