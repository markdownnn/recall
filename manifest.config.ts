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
  // connect-src restricts egress so a compromised dependency cannot exfiltrate
  // data to arbitrary hosts.  huggingface.co starts model-file requests;
  // *.aws.cdn.hf.co is the actual HuggingFace CDN that ALL file downloads redirect to
  // (even small JSON files — verified with curl -sI resolve/main/tokenizer.json);
  // cdn.jsdelivr.net has been removed: the ONNX WASM runtime is now bundled into
  // the extension under public/onnx/ and served via chrome.runtime.getURL('onnx/').
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://huggingface.co https://*.aws.cdn.hf.co",
  },
  permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting', 'offscreen'],
  host_permissions: ['<all_urls>'],
})
