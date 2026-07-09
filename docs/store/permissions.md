# Permission justifications (for the Web Store reviewer)

Source of truth: `manifest.config.ts`. Each row is the one-line reason to paste into the
dashboard's per-permission justification field.

| Permission | Why Recall needs it (reviewer justification) |
| --- | --- |
| `activeTab` | Read the readable text of the page in the active tab when the user saves it (or when an auto-capture fires for the tab they are reading), so it can be indexed for later search. |
| `offscreen` | Run the embedding model (ONNX/WebGPU), WebLLM answer model, and SQLite-WASM database in an offscreen document - heavy local work that cannot run in the service worker. User data is not sent to a server. |
| `sidePanel` | The entire UI is a side panel: Search, Ask, History, and per-page save controls. There is no popup. |
| `alarms` | A periodic alarm (>=1 min) re-creates the offscreen document and drains the local embedding queue after the service worker is reaped, so saved pages still finish indexing while the panel is closed. |
| `unlimitedStorage` | The captured page text, search index, and the database live in local OPFS storage and can grow past the default quota for heavy readers. All storage is on-device. |
| `host_permissions: <all_urls>` (+ `content_scripts` on `<all_urls>`) | The content script extracts readable text from the pages the user reads. Capture can happen on any site the user chooses to read, so the script must be allowed broadly. It only reads text after the privacy gate passes; sensitive sites are denylisted and never captured. |

## Optional narrowing (optimization to TEST, not a requirement)

`host_permissions: <all_urls>` is the broadest grant and the most likely to draw extra
review. It **may** be droppable in favor of `activeTab` **if** the product is willing to
give up silent background auto-capture and instead capture only on an explicit user
gesture (toolbar click / save button), which is exactly when `activeTab` grants access.

- **Trade-off:** auto-capture of pages you "just read" relies on a content script running
  on pages you did not click the icon on. That is what `<all_urls>` enables. Moving to
  `activeTab`-only would make capture **manual/gesture-driven** only.
- **Action:** treat this as an experiment - try building with `activeTab` only and confirm
  whether the desired auto-capture UX still works. Do **not** ship the narrowing blindly;
  it changes core behavior. If auto-capture is a must-have, keep `<all_urls>` and use the
  justification above.
