# Recall

**Re-find anything you've read on the web — by meaning, not by keyword — fully on your own device.**

Recall is a local-first, privacy-first Chrome extension (Manifest V3) that quietly remembers the
pages you actually read and lets you search them later by *what they were about*. You don't need
to remember the title or the exact words. Ask "that article about mitochondria as the cell's power
plant" and Recall finds it — in Korean **and** English — using on-device semantic search.

Everything runs on your machine. The ~107MB IBM Granite embedding model and a SQLite database live
inside the extension. **Nothing you read ever leaves your computer.** No servers, no accounts, no
telemetry, no ads.

---

## Why it exists

Browser history is a list of URLs. It's useless when you can't recall the site, only the *idea*.
Cloud "read-it-later" and AI memory tools solve the recall problem but make you ship your entire
reading history to someone else's server. Recall refuses that trade-off: it gives you semantic
recall **without** the privacy cost, by doing the embedding and the search locally.

---

## Privacy: the whole point

This is the differentiator, so it's worth stating plainly:

- **Zero network egress.** The extension's Content Security Policy pins `connect-src 'self'`
  (see `manifest.config.ts`). The page can't open a socket to anywhere but the extension's own
  bundled assets. There is no analytics endpoint to disable because there is no endpoint at all.
- **The model is local.** The IBM Granite `granite-embedding-107m-multilingual` model (int8
  quantized to ~107MB) and the ONNX runtime are bundled under `public/`. Embeddings are computed
  in the browser via WebGPU (or WASM fallback).
- **The database is local.** Captured text and vectors live in a `@sqlite.org/sqlite-wasm`
  database backed by `unlimitedStorage`, inside the extension's own origin.
- **No accounts, no telemetry, no ads.** Nothing to sign up for. Nothing phones home.
- **Sensitive pages are never captured.** A built-in denylist (`src/core/denylist.ts`) skips
  banking, webmail, auth/login, health portals, password managers, and app UIs you *operate*
  rather than read. You also get a per-site "don't remember this site" override and a global pause.

---

## Features

- **Automatic capture with an engagement gate.** Recall doesn't save every tab you flash past. A
  capture gate (`src/core/capture-gate.ts`) requires real engagement — enough readable text
  (extracted with Mozilla Readability), dwell time, and scrolling — before a page is remembered.
  Search-result pages (SERPs), internal browser pages, and thin pages are filtered out.
- **Semantic + hybrid search.** Queries run as on-device vector search *fused* with a SQLite FTS5
  full-text lane via Reciprocal Rank Fusion (`src/core/rrf.ts`), so an exact keyword match and a
  "close in meaning" match both surface. Lexical results can be up-weighted so an exact-term page
  beats an irrelevant high-cosine hit.
- **Document-level results.** Pages are chunked into paragraphs for embedding, but results are
  rolled up to the *document* so you see one entry per article, ranked by its best passage.
- **Bilingual (Korean + English).** The multilingual Granite model handles mixed KO/EN reading
  habits; the UI is localized (`public/_locales/{en,ko}`).
- **Side panel UI.** A single Chrome side-panel surface for Search, History, and Settings — no
  popup. Toggle it with `Ctrl/Cmd+Shift+K`.
- **Onboarding.** An interactive first-run page that explains capture and lets you try a search
  on sample content immediately.
- **You're in control.** Pause capturing globally, forget a single page, block a whole site, or
  clear everything — all from Settings.

---

## Architecture

Recall follows a **hexagonal (ports & adapters)** design. The domain logic in `src/core` is pure
TypeScript with no Chrome or I/O dependencies — it talks to the outside world only through the
interfaces in `src/core/ports.ts`. That's why the core is covered by a large, fast unit-test suite
that never needs a browser.

The runtime is split across MV3's three contexts:

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  Web page                                                        │
  │   content script (src/content) ── Readability extract +          │
  │     engagement/dwell tracking ──► capture gate ──► send to SW    │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ chrome.runtime messages
  ┌───────────────────────────────▼─────────────────────────────────┐
  │  Service worker (src/background)  — orchestration, no heavy work │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ offscreen RPC
  ┌───────────────────────────────▼─────────────────────────────────┐
  │  Offscreen document (src/offscreen)  — the engine                │
  │    • @huggingface/transformers embedder (WebGPU / WASM)          │
  │    • @sqlite.org/sqlite-wasm  (vectors + FTS5, in a Worker)      │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │
  ┌───────────────────────────────▼─────────────────────────────────┐
  │  Side panel (src/ui)  — Preact: Search · History · Settings      │
  └─────────────────────────────────────────────────────────────────┘

  src/core  ── pure domain (chunking, gate, ranking, RRF, denylist…)
              depends on nobody; the rest depend on it via ports.ts
```

Why an offscreen document? MV3 service workers get reaped aggressively and can't reliably run
WebGPU or hold a WASM database. The offscreen document is the long-lived "engine room"; the service
worker is just the dispatcher (with a `chrome.alarms` re-drain so pending chunks get indexed even
after the worker sleeps).

---

## Tech stack

| Area | Choice |
|------|--------|
| Language | TypeScript (strict) |
| UI | Preact |
| Build | Vite + `@crxjs/vite-plugin` (MV3) |
| Database | `@sqlite.org/sqlite-wasm` (vectors + FTS5) |
| Embeddings | `@huggingface/transformers` (ONNX, WebGPU/WASM) |
| Model | IBM `granite-embedding-107m-multilingual`, self-quantized to int8 |
| Readability | `@mozilla/readability` |
| Unit tests | Vitest |
| E2E | Playwright |

---

## Getting started

### Prerequisites

- Node.js 18+ (the build uses the built-in `fetch`; developed on Node 24)
- Google Chrome (or any Chromium with MV3 + side panel support)

### 1. Install dependencies

```bash
npm install
```

### 2. Get the model

**The embedding model is not in the repo** — its ~107MB ONNX file exceeds GitHub's 100MB-per-file
limit. The build's `prebuild` step (`scripts/fetch-model.mjs`) checks for it and SHA-256-verifies
whatever is on disk against pinned hashes. If the model is missing, get it one of two ways:

- **Download it** from HuggingFace (default repo `markdownnn/recall-granite-q8`):

  ```bash
  npm run fetch-model
  # or point at a different repo/mirror:
  RECALL_MODEL_HF_REPO=<owner>/<repo> npm run fetch-model
  ```

- **Build it yourself** from IBM's official weights (reproducible, no trust required):

  ```bash
  pip install "optimum[onnxruntime]" "transformers"
  python scripts/quantize-granite.py
  # copy its outputs into public/models/granite/
  ```

Either way the four files (`onnx/model_quantized.onnx`, `tokenizer.json`, `config.json`,
`tokenizer_config.json`) must match the pinned SHA-256 hashes, which is the integrity guarantee.

> Note: `npm run build` also runs `fetch-model` automatically via `prebuild`. If you already have
> the model on disk, it just verifies and proceeds — no download.

### 3. Build and load

```bash
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the
generated `dist-ext/` folder. Open any article, read it for a bit, then hit `Ctrl/Cmd+Shift+K` and
search for it by meaning.

### 4. Test

```bash
npm test            # Vitest unit suite (pure-core domain logic)
npx playwright test # end-to-end flows in a real Chromium
```

---

## Engineering rigor

A few things I cared about while building this, for the curious:

- **A pure, well-tested core.** The hexagonal split keeps domain logic free of browser APIs, so
  the chunker, capture gate, ranking, RRF fusion, denylist, and URL sanitizers are covered by a
  large fast unit suite (~40 spec files), plus end-to-end Playwright flows for capture, search,
  history, persistence, and re-indexing.
- **A golden-set eval harness for search quality.** Search relevance is regression-tested against
  a hand-labeled corpus (`eval/`) — real fixtures, expected hits per query, and scorecards — so a
  ranking change is measured (recall@k, prose filtering, lexical weighting), not guessed. The
  many `eval/scorecard-*.json` files are the receipts of that tuning.
- **A self-quantized model.** Rather than trusting a random community quant, the int8 model is
  built from IBM's official fp32 weights at a pinned revision (`scripts/quantize-granite.py`) and
  integrity-pinned by SHA-256 at build time.

---

## Known limitation: cross-lingual ceiling

Recall runs a small (~107M parameter) model entirely on your device, and that trade-off has a real
edge. **Same-language recall is strong** (KO→KO, EN→EN). **Korean-query → English-document** recall
is weaker — a query in Korean won't always pull back the most relevant English article. This is the
honest cost of staying fully local instead of calling a large cloud model. The hybrid FTS5 lane
softens it when a shared exact term exists, but the cross-lingual semantic ceiling is a known limit,
not a bug.

---

## License

[MIT](./LICENSE) © 2026 Minhyeok Kim — [github.com/markdownnn](https://github.com/markdownnn)

The bundled embedding model is derived from IBM's
[`granite-embedding-107m-multilingual`](https://huggingface.co/ibm-granite/granite-embedding-107m-multilingual)
(Apache-2.0).
