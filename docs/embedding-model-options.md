# Embedding Model Options — Better Cross-Lingual (KO↔EN) Recall, Size-Aware

> Status: **research / decision pending A/B numbers.** This doc is DOC-ONLY. No code changed.
> Goal: pick the best *quality-per-MB* upgrade (and/or query translation) to fix weak
> Korean-query → English-page retrieval, **without a big bundle-size increase**.

---

## 1. Context and the size budget

**The problem.** Users search in Korean over mostly-English saved pages. Our golden-set eval
(`eval/run.mjs`) shows P@1 caps around **0.40**, and the hardest cross-lingual cases fail
outright. Example: `광합성 명반응` → the English **Photosynthesis** page is not even in the
vector top-5 (recall@5 = 0). The current model — small, int8, 384-dim — cannot bridge
Korean↔English well.

**Current model (baseline anchor).**

| Property | Value |
|---|---|
| Model | `Xenova/multilingual-e5-small` (transformers.js / ONNX) |
| Params | ~118M |
| Embedding dim | 384 |
| Quantization | q8 / int8 (`onnx/model_quantized.onnx`) |
| **Bundled q8 ONNX size** | **118.3 MB** (verified on disk: `public/models/.../model_quantized.onnx` = 118,308,185 bytes) |
| Tokenizer | `tokenizer.json` = 17.1 MB |
| **Total bundled** | **~135 MB** (model + tokenizer + tiny configs) |
| Prefixes | `query: ` / `passage: `, mean-pooled, normalized |
| Runtime | WebGPU with WASM fallback, in an MV3 **offscreen document** |
| Provenance | bundled locally, fetched at build by `scripts/fetch-model.mjs` (zero network egress is a core product promise) |

**Size budget (owner constraint: "용량이 너무 큰 차이 안 나는 한에서").**
Anchor on the **118 MB** q8 ONNX. Soft ceiling ≈ **2–3×** that:

- **≤ ~236 MB (2×)** — comfortable.
- **~236–354 MB (2–3×)** — acceptable, flag the delta.
- **> ~354 MB (>3×)** — **too big**; flag with its size and reject unless the quality jump is huge.

All sizes below are the **q8/int8 ONNX** file (the weights we'd actually bundle), verified on
Hugging Face. Tokenizer adds a roughly fixed ~5–17 MB on top for all of these.

---

## 2. Models comparison

> "KO-EN cross-lingual standing" = how well it maps a Korean *query* to an English *passage*.
> This is the axis that matters for us — **not** raw Korean-monolingual quality. A Korean-only
> model can be great at Korean-to-Korean and still fail Korean-to-English.

| Model | Params | Dim | q8/int8 ONNX | ×118 MB | KO↔EN cross-lingual standing | ONNX / transformers.js | License | Verdict vs budget |
|---|---|---|---|---|---|---|---|---|
| **e5-small** (current) | 118M | 384 | **118 MB** | 1.0× | Weak (the pain point) | `Xenova/multilingual-e5-small` ✅ | MIT | baseline |
| **paraphrase-multilingual-MiniLM-L12-v2** | 118M | 384 | **118 MB** | 1.0× | Parallel-trained on 50+ langs → decent alignment, but older + tuned for *similarity*, not retrieval | `Xenova/...` ✅ | Apache-2.0 | **Free-size probe** — try first |
| **granite-embedding-107m-multilingual (r2)** | ~107M | 384 | **~107 MB** | ~0.9× | 12 langs incl. Korean; cross-lingual-capable, but narrow language set | IBM ships ONNX (r2) ✅ | Apache-2.0 | **Free-size probe** — try first |
| **multilingual-e5-base** | 278M | 768 | **279 MB** | 2.4× | Moderate upgrade, *same e5 family* (drop-in prefixes) | `Xenova/multilingual-e5-base` ✅ | MIT | **Within budget** (safe pick) |
| **granite-embedding-278m-multilingual (r2)** | 278M | 768 | **~278 MB** | 2.4× | Strong multilingual incl. KO; 12-lang focus | IBM ships ONNX (r2) ✅ | Apache-2.0 | Within budget (alt) |
| **gte-multilingual-base** (Alibaba) | 305M | 768 (MRL→256/128) | **340 MB** | 2.9× | **SOTA cross-lingual in this size class**; validated on cross-lingual retrieval | `onnx-community/gte-multilingual-base` ✅ | Apache-2.0 | **At the 3× edge — top quality pick** |
| **snowflake-arctic-embed-m-v2.0** | 305M (built on gte-mbase) | 768 (MRL→256) | **~340 MB** | 2.9× | Strong KO on MIRACL/CLEF; quantization-aware MRL | `Snowflake/...` transformers.js tag ✅ | Apache-2.0 | At the 3× edge (alt) |
| bge-m3 | 568M | 1024 | **571 MB** | 4.8× | Excellent multilingual + KO | community int8 ONNX (not first-party tjs) | MIT | **TOO BIG** |
| jina-embeddings-v3 | 572M | 1024 | **~570 MB** | 4.8× | Excellent, but LoRA-adapter design complicates tjs | partial | CC-BY-NC (non-commercial!) | **TOO BIG + license** |
| KoE5 (e5-large-ko) | 560M | 1024 | **~560 MB** | 4.7× | Keeps e5 cross-lingual base, KO-tuned | via e5-large ONNX | MIT | **TOO BIG** |
| KURE-v1 (bge-m3-ko) | 568M | 1024 | **~571 MB** | 4.8× | Top Korean retrieval (MTEB-ko) | none first-party tjs | MIT | **TOO BIG** |
| ko-sroberta-multitask | ~110M | 768 | small | ~1× | **Korean-MONOLINGUAL** — poor at KO-query→EN-passage alignment | partial | — | **Reject** (won't bridge KO→EN) |

**Ranked by cross-lingual-quality-per-MB (within budget):**

1. **gte-multilingual-base** — best cross-lingual quality available under the ceiling; sits *at* the 3× edge (340 MB). MRL lets us truncate 768→384 to halve vector storage if needed.
2. **multilingual-e5-base** — safer size (279 MB, 2.4×), same family as today so the swap is low-risk, but the cross-lingual *gain* is the open question (it's the same training recipe, just bigger).
3. **snowflake-arctic-embed-m-v2.0 / granite-278m** — strong alternates, same size class.
4. **paraphrase-MiniLM-L12 / granite-107m** — **zero or negative size delta**. If either lifts the Korean cases, it's a free win — so probe these *first*.

**Notes / caveats**
- bge-m3, jina-v3, KoE5, KURE are all the strongest Korean models but all **>4.5× too big**, and **jina-v3 is CC-BY-NC (non-commercial)** — a license blocker on top of size. Flagged, not pursued.
- I could **not independently verify** the exact onnx-community q8 byte size for `snowflake-arctic-embed-m-v2.0` and `granite-*-r2` (the m-v2.0 shares gte-mbase's architecture, so ~340 MB is an architecture-based estimate, not a file read). Verify the real file size before committing.

---

## 3. Query translation (alternative or complement to a model swap)

Idea: the corpus is mostly **English**. Instead of asking one embedding model to bridge two
languages, **translate the Korean query → English first**, then embed the English query against
the English passages. This sidesteps cross-lingual weakness entirely.

### (a) Chrome built-in Translator API — most attractive, **zero bundle cost**

Verified findings (Chrome for Developers docs, June 2026):

- **Shipped stable in Chrome 138** (no flag, no origin trial needed on current stable).
- **Fully on-device.** Translation runs locally; no cloud call per translation.
- **Korean ⇄ English supported** (`'ko'` and `'en'` are both in the supported-language list).
- **Bundle cost = 0.** The language pack is downloaded *by Chrome itself* on first use, not bundled by us. It does **not** count against our ONNX budget.
- **Big limitation: NOT available in Web Workers.** The docs state the API is only available to "top-level windows and same-origin iframes," explicitly **not** Web Workers. **An MV3 service worker is a worker → cannot call it.** It must run in a **Document** context.
  - Our query is typed in the **side panel**, which *is* a Document → the natural place to translate before sending text to the embedder. **This is the recommended integration point.**
  - Whether it works inside our **offscreen document** (where embedding runs) is **UNVERIFIED** — offscreen docs are Documents (not workers) so it *should* be allowed, but Chrome docs also say offscreen documents only support the `chrome.runtime` extension API. `Translator` is a *web platform* global, not a `chrome.*` API, so it likely works — **but test it; do not assume.**
- **Zero-egress nuance to disclose:** the first-run language-pack download *is* a network fetch, but it's **Chrome-managed** (Google's model), on-device after that, and not our telemetry/egress. Worth a one-line note in the privacy copy; it does not break the "we don't phone home" promise.
- API shape to use: `Translator.availability({sourceLanguage, targetLanguage})` → may return `downloadable`; `Translator.create(...)` may need a user gesture to trigger the download; then `translator.translate(koText)`. A `LanguageDetector` companion API can gate translation to only fire on Korean input.

### (b) Bundled MT model (e.g. OPUS-MT ko→en, ONNX)

- Works fully offline in the offscreen document via transformers.js (proven pattern).
- **But adds bundle size** (tens to ~100+ MB per direction, q8) and covers **only one language pair**. Strictly worse than the free Chrome API on both size and coverage. Keep as a fallback only if the Chrome API turns out unusable in our contexts.

### (c) Embed BOTH original + translated query, then fuse

- Embed the raw Korean query *and* its English translation, run both searches, **RRF-fuse** the two ranked lists (we already have `rrfFuse` in the worker).
- Most robust: catches Korean-only pages via the KO query and English pages via the EN query. Costs one extra embed per search. Pairs naturally with option (a).

**Practicality verdict:** **(a) Chrome Translator API, executed in the side panel, is the most
practical** — on-device, KO+EN, **no bundle growth**, and it *stacks on top of* any model choice.
Use **(c) dual-query fusion** as the higher-quality variant. **(b) is a last resort** because it
costs size.

---

## 4. Migration cost of swapping the embedding model

- **Re-index is mandatory.** Vectors from a new model are **not comparable** to old ones (different space). Every already-captured chunk must be **re-embedded**. Plan a one-time background re-index (and an eval/.cache wipe — see §5).
- **Storage grows with dim.** Vectors are stored as a raw Float32 `BLOB` in sqlite (`chunks.vector`, see `src/offscreen/sqlite-worker.ts`). 384-dim = 1,536 bytes/chunk; **768-dim = 3,072 bytes/chunk (2×)**. The schema is dimension-agnostic (variable BLOB) so **no DDL change** is needed — but the brute-force cosine scan also does ~2× the float math per query. gte/arctic **MRL** can truncate 768→384 to keep storage and scan cost flat, trading a little quality (measure it).
- **Prefix / instruction conventions differ per model** — getting this wrong silently tanks scores:
  - e5-small / e5-base: `query: ` / `passage: `
  - gte-multilingual-base: **no prefix** (raw text; optional instruction)
  - snowflake-arctic-embed: **query gets a prefix, documents get none**
  - granite / paraphrase-MiniLM: **no prefix**
- **Load-time / memory** scale with the bigger ONNX (279–340 MB vs 118 MB) — slower first load and more WASM/WebGPU memory. Acceptable within budget, but note it for low-end devices.

---

## 5. Recommendation + golden-set A/B procedure

### Recommendation (size-aware, honest about the tradeoff)

1. **Probe the free-size models first** (`paraphrase-multilingual-MiniLM-L12-v2`, `granite-107m`).
   If either lifts S3 (the Korean cross-lingual cases) meaningfully at **~118 MB / no size delta**,
   that is the best possible outcome — ship it.
2. **If free-size isn't enough, A/B the two real upgrades:**
   - **gte-multilingual-base (340 MB, 2.9×)** — expected best cross-lingual quality, *at* the size ceiling.
   - **multilingual-e5-base (279 MB, 2.4×)** — safer size, lowest-risk swap (same family/prefixes), but the cross-lingual gain is unproven.
   Pick the one whose **measured** S3 gain justifies its MB.
3. **Add Chrome Translator-API query translation regardless** (side-panel, optionally dual-query
   fusion). It's free on size and attacks the exact failure mode. The combination
   *small/medium model + translated query* may beat *big model alone* at a fraction of the bundle.
4. **Do NOT adopt** bge-m3 / KURE / KoE5 / jina-v3 — all >4.5× over budget (jina also non-commercial).

**The decision is data-pending.** Numbers below decide it, not intuition.

### A/B procedure (tie everything to the golden-set harness)

**Swap a model:**
1. In `eval/lib/embed-node.mjs`: change the model id in `pipeline('feature-extraction', '<model-id>', { dtype: 'q8' })`, and **fix the prefix** — that file hardcodes `${kind}: ${text}` (correct for e5). For gte/granite/paraphrase, embed **raw text** (no prefix); for arctic, prefix queries only. Set the candidate's `dim` wherever assumed.
2. Make the weights available offline: bundle the candidate ONNX under `public/models/<org>/<model>/` (mirror `scripts/fetch-model.mjs`) or point `env.localModelPath` at it. Keep `env.allowRemoteModels = false`.
3. **Wipe `eval/.cache/embeds` between models.** GOTCHA: the cache key is `sha256(kind + '\n' + text)` — it does **not** include the model id. Without wiping, you'll score the **old** model's vectors and see a fake "no change." `rm -rf eval/.cache/embeds`.
4. Run `npm run eval`. Compare against the current scorecard on **P@1 / recall@5 / MRR**, overall and **per scenario**, focusing on:
   - **S3** — `광합성 명반응` → Photosynthesis, `면역 체계와 항체` → Immune_system (the failing KO→EN cases; today recall@5 = 0 on the first).
   - **S1** — `박테리아` → Bacteria (KO→EN single word).
   A model is only worth its MB if S3 recall@5/MRR moves up clearly.

**Test query translation:**
1. In `eval/lib/build-and-search.mjs` (or `run.mjs`), translate the query → English **before** embedding. In the harness you can use a real MT call **or** a fixed KO→EN map for the handful of Korean golden queries to measure the *ceiling* (what perfect translation would buy). For dual-query fusion, embed both and `rrfFuse` the two ranked lists.
2. Re-run `npm run eval`; compare S1/S3 deltas. This isolates "translation alone" from "bigger model alone," so we can choose the cheapest combo that clears the bar.

**Record** P@1 / recall@5 / MRR for each variant in a small table here once measured, then commit
the model/translation choice with the numbers that justified the size delta.

---

## 6. Sources

- e5-small / e5-base ONNX file sizes — `huggingface.co/Xenova/multilingual-e5-base/tree/main/onnx` (int8 = 279 MB), baseline 118 MB verified on disk.
- paraphrase-multilingual-MiniLM-L12-v2 ONNX — `huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/tree/main/onnx` (int8 = 118 MB).
- gte-multilingual-base ONNX — `huggingface.co/onnx-community/gte-multilingual-base/tree/main/onnx` (int8 = 340 MB; 305M params); Alibaba-NLP model card.
- granite-embedding multilingual (107m / 278m, r2 ONNX) — IBM Granite docs + `huggingface.co/ibm-granite/granite-embedding-107m-multilingual`.
- snowflake-arctic-embed-m-v2.0 — Snowflake model card / arXiv 2412.04506 (built on gte-multilingual-base, MRL, KO on MIRACL/CLEF).
- bge-m3 int8 — `huggingface.co/MahradHosseini/bge-m3-onnx-int8` (568M, 2272 MB → 571 MB int8); jina-embeddings-v3 (572M, CC-BY-NC).
- Korean leaderboard / KURE / KoE5 — `github.com/nlpai-lab/KURE` (MTEB-ko-retrieval).
- Chrome Translator API — `developer.chrome.com/docs/ai/translator-api` (Chrome 138 stable, on-device, ko/en supported, **not in Web Workers**), `developer.chrome.com/blog/ai-translator-origin-trial`.

> **Unverified / flag:** exact onnx-community q8 byte sizes for arctic-embed-m-v2.0 and granite-r2
> (architecture-based estimates); and whether the Chrome Translator API is callable from our
> **offscreen document** (likely yes since it's a Document and a web-platform global, but test
> before relying on it — the safe integration point is the **side panel**).
