# Embedding Model A/B — KO+EN Bidirectional Retrieval (SPIKE)

> Status: **SPIKE / measurement only.** No production code changed. The bundled production
> model is still `Xenova/multilingual-e5-small` (q8). This doc reports golden-set numbers to
> feed a follow-up swap decision. Companion: `docs/embedding-model-options.md` (the size-budget
> framing this anchors on: ~118 MB q8 ONNX anchor, soft ceiling 2-3x).

## What we measured and why

Users search a recall extension whose saved pages are a **mix of Korean and English**. A query
can be Korean or English, and the target page can be Korean or English. So there are 4 combos:

- **EN->EN** English query -> English page (the same-language majority case).
- **KO->KO** Korean query -> Korean page (same-language).
- **KO->EN** Korean query -> English page (CROSS - today's weak spot).
- **EN->KO** English query -> Korean page (CROSS - today's weak spot).

The golden set (`eval/golden.json`, 22 queries) is tagged with `combo` so the harness prints a
per-combo P@1 / recall@5 / MRR breakdown. The two CROSS combos are the headline — they are where
the current model fails.

### Harness setup (fair comparison)

- One process embeds the **same 27-fixture corpus** with the **same chunker + the same
  ranking** (`MemoryVectorStore.search`, RRF fuse) per `eval/run.mjs`. Only the embedding
  **model** changes.
- All runs used `--strip --min-prose=0.35` so every model sees identical chunks.
- Model is env-driven in `eval/lib/embed-node.mjs`: `EVAL_MODEL`, `EVAL_DTYPE`, `EVAL_PREFIX`
  (`e5` = `query:`/`passage:` prefixes; `none` = raw text), and `EVAL_MODEL_FILE` (for granite's
  non-standard ONNX filename).
- **`rm -rf eval/.cache/embeds` before every run.** The embed cache key now also includes the
  model id + dtype + prefix, so a stale cache can no longer silently score the wrong model (the
  known gotcha), but we still wipe it before each run as belt-and-suspenders.
- All models compared at **q8 / int8** (the weights we would actually bundle). Sizes are the
  quantized ONNX file on disk.

## Results

Size = quantized ONNX file on disk. **Bold** = best in column among the four models.

| Model | ONNX (q8/int8) | dim | prefix | Overall P@1 / R@5 / MRR | KO->EN P@1 / R@5 / MRR | EN->KO P@1 / R@5 / MRR | KO->KO | EN->EN | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| `Xenova/multilingual-e5-small` (baseline) | 113 MB | 384 | e5 | 0.45 / 0.82 / 0.59 | **0.00** / 0.80 / 0.29 | 0.40 / 0.60 / 0.50 | 0.80 / 1.00 / 0.90 | **0.57** / 0.86 / 0.65 | Anchor. KO->EN totally fails (P@1 0). |
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 113 MB | 384 | none | 0.41 / **0.86** / 0.58 | **0.60** / 0.80 / **0.70** | 0.20 / 0.80 / 0.41 | 0.80 / 1.00 / 0.87 | 0.14 / 0.86 / 0.42 | Best KO->EN, but **EN->EN collapses (0.14)** - regresses the majority case. |
| `Xenova/multilingual-e5-base` | 266 MB (2.4x) | 768 | e5 | 0.45 / 0.77 / 0.58 | 0.20 / **0.40** / 0.27 | 0.20 / 0.80 / 0.38 | **1.00** / 1.00 / **1.00** | 0.43 / 0.86 / 0.64 | 2.4x size, and **cross combos get WORSE** at q8 (KO->EN R@5 drops 0.80->0.40). Not worth it. |
| `gety-ai/granite-embedding-107m-multilingual` | **102 MB** | 384 | none | **0.45 / 0.86 / 0.63** | 0.40 / 0.80 / **0.60** | **0.40 / 0.80 / 0.52** | 0.60 / 1.00 / 0.77 | 0.43 / 0.86 / 0.62 | **Best balance: fixes both cross combos AND keeps EN->EN, smallest file, best overall MRR.** |

Per-combo n = 5 each (EN->EN n = 7). Each query is worth 0.20 of a combo's P@1, so treat single
0.20 gaps as directional, not precise.

### Cross-combo focus (the headline)

Average of the two CROSS combos (KO->EN + EN->KO):

| Model | cross P@1 | cross R@5 | cross MRR | EN->EN P@1 (cost) | ONNX MB |
|---|---|---|---|---|---|
| e5-small (baseline) | 0.20 | 0.70 | 0.40 | 0.57 | 113 |
| MiniLM-L12 | **0.40** | **0.80** | 0.55 | **0.14 (regressed)** | 113 |
| e5-base | 0.20 | 0.60 | 0.33 | 0.43 | 266 |
| **granite-107m** | **0.40** | **0.80** | **0.56** | **0.43 (kept)** | **102** |

- **granite and MiniLM tie** for best cross-combo retrieval (P@1 0.40, R@5 0.80).
- **MiniLM pays for it by wrecking EN->EN** (P@1 0.57 -> 0.14). That is the most common real
  query shape, so MiniLM is disqualified despite the great cross numbers.
- **granite keeps EN->EN** (0.43, same R@5 0.86 as baseline) while delivering the same cross
  gains - and it is the **smallest** file (102 MB, below the current 113 MB).
- **e5-base is the surprise loser**: 2.4x the size, yet q8 quantization seems to hurt its
  cross-lingual alignment - KO->EN recall@5 collapses from 0.80 (e5-small) to 0.40. Its KO->KO
  is perfect, but the cross combos (the whole point) regress. Not worth 266 MB.

**Best cross-combo quality per MB = granite** (same cross numbers as MiniLM, no EN->EN cost,
fewest MB).

## Translation footnote (Task 3, secondary)

On the best model (granite), we re-scored the 10 cross-combo queries after an **oracle
pre-translation of the query into the target document's language** (KO->EN queries rewritten to
English; EN->KO queries rewritten to Korean). File: `eval/golden-translated.json`.

| Cross combo | granite native (no translation) | granite + oracle translation |
|---|---|---|
| KO->EN (KO query -> EN, translated to EN) | P@1 0.40 / R@5 0.80 / MRR 0.60 | P@1 0.40 / R@5 0.80 / MRR 0.55 (**no gain**) |
| EN->KO (EN query -> KO, translated to KO) | P@1 0.40 / R@5 0.80 / MRR 0.52 | **P@1 0.80 / R@5 1.00 / MRR 0.87** (big gain) |

**What this says.** Translation only helps the direction whose *target* language the model is
already strong at as a same-language task. granite's KO->KO is strong, so translating an English
query INTO Korean turns EN->KO into an easy KO->KO and jumps to P@1 0.80. But translating a Korean
query INTO English turns KO->EN into EN->EN, and granite's EN->EN is only mediocre (P@1 0.43), so
there is no gain.

**The caveat (why translation is a messier path).** With mixed KO+EN docs you do **not** know the
target page's language at query time, so production translation runs in **one fixed direction**.
Pick "always translate to Korean" and you help EN->KO but **break EN->EN** (English queries become
Korean and must now find English pages = a new cross problem). Pick "always to English" and you
help nothing here and **break KO->KO**. A single-direction translation just **moves** the cross
problem; it does not remove it. A good shared embedding space (granite) handles all 4 combos
without that whack-a-mole. So translation is at best a future per-query-language-detected add-on,
not the fix.

## Recommendation

**Switch the embedding model to `granite-embedding-107m-multilingual` (q8/int8, 384-dim, no
prefixes). A FREE model makes the cross combos acceptable with NO size cost - it is actually
SMALLER than the current model. No need for e5-base; no need for translation.**

Why:

1. **Fixes the weak spot.** KO->EN goes from a total failure (P@1 0.00, MRR 0.29) to P@1 0.40 /
   MRR 0.60; EN->KO recall@5 goes 0.60 -> 0.80. Best overall MRR (0.63) of all four.
2. **No regression on the majority case.** EN->EN stays at 0.43 P@1 / 0.86 R@5 (MiniLM, the only
   other model that fixes the cross combos, drops EN->EN to 0.14 - disqualifying).
3. **No size cost.** 102 MB q8 ONNX is *below* the current 113 MB. Same 384-dim, so the vector
   store and re-index cost are unchanged. The change is a model swap + a full re-index.
4. **e5-base rejected:** 2.4x size and its q8 cross-lingual numbers are *worse* than the 113 MB
   baseline. **Translation rejected:** net wash / whack-a-mole on mixed-language corpora.

### Honest caveats (this is a SPIKE)

- **Small golden set.** 22 queries, 5 per cross combo; one query = 0.20 P@1. Numbers are
  directional. Before committing the swap, widen the cross-combo golden set.
- **dtype detail.** granite's community ONNX (`gety-ai/...`) does not ship the transformers.js
  standard `onnx/model_quantized.onnx`; it ships `model_qint8_arm64.onnx` (used here) and
  `model_quint8_avx2.onnx` (x86). Both are int8, ~102 MB. Production adoption needs either a
  standard-named build or the `EVAL_MODEL_FILE`-style override wired into the prod fetch/loader.
- **Tokenizer / browser path.** granite is XLM-RoBERTa-family (SentencePiece BPE). The Node ONNX
  path loaded `tokenizer.json` fine; the extension's offscreen WASM/WebGPU path must be verified
  to load this tokenizer + ONNX before adoption. This SPIKE measured retrieval quality only.
- **Quant/runtime parity.** Measured with onnxruntime-node int8 on CPU; the extension runs
  WebGPU/q8. Vectors should be close but provider differences exist.

## Reproduce

```sh
# baseline
rm -rf eval/.cache/embeds && npm run eval -- --strip --min-prose=0.35

# MiniLM
rm -rf eval/.cache/embeds && \
  EVAL_MODEL="Xenova/paraphrase-multilingual-MiniLM-L12-v2" EVAL_DTYPE=q8 EVAL_PREFIX=none \
  npm run eval -- --strip --min-prose=0.35

# e5-base
rm -rf eval/.cache/embeds && \
  EVAL_MODEL="Xenova/multilingual-e5-base" EVAL_DTYPE=q8 EVAL_PREFIX=e5 \
  npm run eval -- --strip --min-prose=0.35

# granite (winner)
rm -rf eval/.cache/embeds && \
  EVAL_MODEL="gety-ai/granite-embedding-107m-multilingual-onnx" EVAL_DTYPE=q8 EVAL_PREFIX=none \
  EVAL_MODEL_FILE="model_qint8_arm64" npm run eval -- --strip --min-prose=0.35

# translation footnote (on granite)
rm -rf eval/.cache/embeds && \
  EVAL_MODEL="gety-ai/granite-embedding-107m-multilingual-onnx" EVAL_DTYPE=q8 EVAL_PREFIX=none \
  EVAL_MODEL_FILE="model_qint8_arm64" \
  npm run eval -- --strip --min-prose=0.35 --golden=eval/golden-translated.json
```

Raw scorecards: `eval/scorecard-model-*.json`.

---

# Round 2 — Two NEW candidates (Granite R2 small, EmbeddingGemma-300m)

> Status: **SPIKE / measurement only.** Still no production code changed; bundled model is still
> `Xenova/multilingual-e5-small`. This round adds two newer models to the A/B before we finalize a
> swap, and also **widens the golden set** so the verdict is not science-Wikipedia-only.
> Only `eval/` + this doc + the env plumbing in `eval/lib/embed-node.mjs` changed.

## What changed in the harness (eval-only)

- **`EVAL_PREFIX=gemma`** — EmbeddingGemma's task prompts: query gets `task: search result | query: <q>`,
  passage gets `title: none | text: <p>` (the documented Retrieval prompts). Skipping these makes
  EmbeddingGemma's numbers unfairly low, so we apply them.
- **`EVAL_MRL_DIM=<N>`** — Matryoshka truncation: slice each normalized vector to the first N dims
  and re-normalize (applied to query AND passage so dims still match). 0/empty = full native dim.
  Lets us measure EmbeddingGemma at 768 vs MRL-256 to see the storage/quality tradeoff.
- **Internal batching (`EVAL_BATCH`, default 8)** — the 32K-context ModernBERT (Granite R2) and
  Gemma3 (EmbeddingGemma) models OOM-kill the process when the whole corpus is embedded in one
  forward pass (one giant padded tensor). Small batches bound peak memory; each text is mean-pooled
  independently so per-text vectors are unchanged in math. NOTE: q8 + per-batch padding length is
  not bit-identical to a single full batch, so the four Round-1 models were **re-anchored** here
  under BATCH=8 for an apples-to-apples comparison (granite-107m EN->EN moved 0.43 -> 0.57 under
  batching; e5-small was unchanged). Round-1 numbers above are the historical single-batch run.
- The embed cache key now also includes `EVAL_MRL_DIM`. Still `rm -rf eval/.cache/embeds` before
  every model run.

## Verified model facts (cite-able)

| Model | HF id used | params | dim | q8/int8 ONNX size | ONNX source / availability | arch family | WebGPU feasibility |
|---|---|---|---|---|---|---|---|
| e5-small (baseline) | `Xenova/multilingual-e5-small` | ~118M | 384 | 113 MB (bundled) | standard `onnx/model_quantized.onnx` | XLM-RoBERTa | **proven (in production today)** |
| granite-107m R1 (champion) | `gety-ai/granite-embedding-107m-multilingual-onnx` | 107M | 384 | 102 MB | community; non-standard file `model_qint8_arm64.onnx` (needs `EVAL_MODEL_FILE`) | XLM-RoBERTa | **proven** — passed real-extension WebGPU probe (device=webgpu, dims=384) |
| **granite-97m R2 multilingual** | `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` | 97M | 384 | **97.9 MB** | onnx-community; **standard `model_quantized.onnx`** (cleanest of all) | **ModernBERT (NEW family)** | likely OK (transformers.js supports ModernBERT) but **needs a probe** |
| **EmbeddingGemma-300m** | `onnx-community/embeddinggemma-300m-ONNX` | ~300M | 768 (MRL 128/256/384/512/768) | ~309 MB int8 (`model_quantized.onnx` + external `model_quantized.onnx_data`) | onnx-community; **transformers.js first-class** | **Gemma3 (NEW family), 3x download, external-data ONNX** | feasible (in-browser demos exist) but **needs a probe** |

Notes that matter for a real swap:
- **There is NO "granite-embedding-small-r2 *multilingual*".** The `*-small-r2` repos are
  **English-only** (47M, 384-dim). The R2 *multilingual* line is named by param count:
  `granite-embedding-97m-multilingual-r2` (the "small" multilingual, used here) and the larger
  `granite-embedding-311m-multilingual-r2`. Korean is in R2's 52 enhanced-support languages.
- **Granite R2 uses NO query/passage prefix** (same convention as R1), confirmed from the
  onnx-community R2 model card.
- **R2 is a different architecture than R1** (ModernBERT vs XLM-RoBERTa), 32K context, 384-dim — so
  the proven R1 WebGPU result does **not** transfer; R2 needs its own probe.
- EmbeddingGemma's int8 ONNX is **~309 MB on disk** (not ~200 MB), shipped as a small graph file
  plus a ~309 MB external-data blob — a packaging wrinkle for the extension bundle.
- **No NaN / degenerate vectors** were produced by either new model at any dim (768 / 384 / 256).

## Results — original 22-query set (re-anchored, BATCH=8)

`eval/golden.json`. n: EN->EN 7, KO->KO 5, KO->EN 5, EN->KO 5. **Bold** = best in column.

| Model | Overall P@1/R@5/MRR | KO->EN | EN->KO | KO->KO | EN->EN |
|---|---|---|---|---|---|
| e5-small (baseline) | 0.45 / 0.82 / 0.59 | 0.00 / 0.80 / 0.29 | 0.40 / 0.60 / 0.50 | 0.80 / 1.00 / 0.90 | 0.57 / 0.86 / 0.65 |
| **granite-107m R1** | **0.50** / 0.86 / **0.66** | 0.40 / 0.80 / 0.60 | **0.40 / 0.80 / 0.53** | 0.60 / 1.00 / 0.77 | **0.57 / 0.86 / 0.71** |
| granite-97m R2 | 0.41 / 0.86 / 0.59 | 0.40 / **1.00** / 0.70 | 0.00 / 0.60 / 0.20 | 0.80 / 1.00 / 0.90 | 0.43 / 0.86 / 0.58 |
| EmbeddingGemma 768 | **0.55** / 0.77 / 0.65 | **0.60 / 1.00 / 0.80** | 0.00 / 0.20 / 0.07 | **1.00 / 1.00 / 1.00** | 0.57 / 0.86 / 0.71 |
| EmbeddingGemma MRL-384 | 0.45 / 0.82 / 0.60 | **0.60 / 1.00 / 0.80** | 0.00 / 0.40 / 0.09 | 0.80 / 1.00 / 0.90 | 0.43 / 0.86 / 0.61 |
| EmbeddingGemma MRL-256 | 0.45 / 0.86 / 0.62 | **0.60 / 1.00 / 0.80** | 0.00 / 0.60 / 0.16 | 0.80 / 1.00 / 0.90 | 0.43 / 0.86 / 0.61 |

## Results — EXTENDED 35-query set (the widened, multi-domain set)

`eval/golden-extended.json` = the original 22 **plus 13 new queries** that finally make the corpus's
non-encyclopedia pages real retrieval targets, not just distractors. New use cases:

- **Dev-docs lookup (S8):** "how to send an http request in javascript" -> MDN Using_Fetch;
  promise then/catch -> MDN Promise; iterate+transform an array -> MDN Array.
- **Essays/opinion (S9):** startup-idea advice -> PG startupideas; "do things that don't scale" -> PG ds.
- **How-to blog (S10):** debug with strace -> jvns; modern CLI tools -> jvns.
- **News (S11):** Wikimedia closes Wikinews; Pope Leo XIV in Africa.
- **Cross-lingual dev/essay (S13, KO->EN):** Korean queries for "비동기 프로미스" -> MDN Promise,
  "스타트업 아이디어" -> PG startupideas, "리눅스 명령줄 도구" -> jvns. (This is the realistic
  Korean-user-of-a-dev-tool case the old set never tested.)

n: EN->EN 16, KO->KO 5, KO->EN 8, EN->KO 5. **Bold** = best in column.

| Model | Overall P@1/R@5/MRR | KO->EN | EN->KO | KO->KO | EN->EN |
|---|---|---|---|---|---|
| e5-small (baseline) | 0.44 / 0.79 / 0.57 | 0.13 / 0.88 / 0.40 | 0.40 / 0.60 / 0.50 | 0.80 / 1.00 / 0.90 | 0.50 / 0.75 / 0.57 |
| **granite-107m R1** | **0.50** / 0.85 / **0.65** | 0.38 / 0.75 / 0.56 | **0.40 / 0.80 / 0.53** | 0.60 / 1.00 / 0.77 | **0.56** / 0.88 / **0.69** |
| granite-97m R2 | 0.44 / 0.88 / 0.60 | 0.38 / 0.88 / 0.63 | 0.00 / 0.60 / 0.20 | 0.80 / 1.00 / 0.90 | 0.50 / **0.94** / 0.63 |
| EmbeddingGemma 768 | **0.50** / 0.74 / 0.61 | **0.63 / 1.00 / 0.81** | 0.00 / 0.20 / 0.07 | **1.00 / 1.00 / 1.00** | 0.44 / 0.69 / 0.55 |
| EmbeddingGemma MRL-256 | 0.47 / **0.91** / 0.64 | **0.63 / 1.00 / 0.81** | 0.00 / 0.60 / 0.16 | 0.80 / 1.00 / 0.90 | 0.44 / **0.94** / 0.62 |

### Reading the extended set

- **granite R1 is still the only model with NO catastrophic combo.** It is the sole candidate that
  keeps **EN->KO** alive (P@1 0.40). It also has the **best overall MRR (0.65)** and **best EN->EN
  P@1 (0.56)** on the diverse set.
- **Both NEW models break EN->KO to P@1 0.00.** English query -> Korean document is where R2 and
  EmbeddingGemma both fall over (the doc is sometimes in the top-5, R@5 0.60, but never ranked #1).
- **EmbeddingGemma owns the "Korean-as-query" directions:** KO->KO perfect (1.00) and KO->EN best of
  all (0.63 / 1.00 / 0.81), and it holds those on the harder dev/essay cross-lingual queries.
- **granite R2 improved EN->EN recall** (R@5 0.94, dev-docs/news retrieved well) and KO->EN MRR vs
  R1, but at the cost of EN->KO and a lower overall MRR.

## Korean verdict on EmbeddingGemma — the research flag is HALF right

The owner's research flagged EmbeddingGemma as weak on Korean retrieval. **On our data that is
true in ONE narrow direction only.** EmbeddingGemma is actually the **strongest** model whenever the
Korean text is the **query**: KO->KO is perfect (P@1 1.00) and KO->EN is the best of any model
(0.63 / 1.00 / 0.81), and it holds up on the harder dev/essay KO->EN queries. Its Korean weakness is
**purely EN->KO** — English query into a Korean **document** collapses to P@1 0.00 / R@5 0.20-0.60.
No NaN or degenerate vectors at any dim. So: **"confirmed weak" for EN->KO only; "held up / actually
best" for KO->KO and KO->EN.**

## Granite R2 small vs granite-107m R1 — NOT a clean upgrade

R2 (97m, ModernBERT, 97.9 MB, standard ONNX) is the cleanest model to *package* and has the best
EN->EN recall, but it is **not** a clean upgrade over R1:

- It **trades away EN->KO** (P@1 0.40 -> 0.00 on both sets) for only a marginal KO->EN recall gain.
- **Lower overall MRR** than R1 on both sets (22-set 0.59 vs 0.66; 35-set 0.60 vs 0.65).
- It is a **new architecture** (ModernBERT) so R1's proven WebGPU result does not carry over.

R1 remains the better-balanced 384-dim model. Reject R2 as the swap unless EN->KO is deprioritized.

## MRL storage finding — truncating EmbeddingGemma 768 -> 256 is a FREE win

Cutting EmbeddingGemma to its first 256 dims (re-normalized) **shrinks every stored vector 3x**
(768 -> 256 floats) and **does not cost quality — it actually improved recall** on the diverse set:

| EmbeddingGemma dim | storage / vec | 35-set overall R@5 | 35-set EN->EN R@5 | KO->EN |
|---|---|---|---|---|
| 768 (full) | 1.0x | 0.74 | 0.69 | 0.63 / 1.00 / 0.81 |
| **256 (MRL)** | **0.33x** | **0.91** | **0.94** | 0.63 / 1.00 / 0.81 (unchanged) |

The full 768 q8 vectors carry noisy tail dims that hurt ranking on the diverse corpus; truncating to
256 + renormalizing denoises them. **If EmbeddingGemma is ever adopted, use MRL-256** — same Korean
strength, better EN-doc recall, 1/3 the storage. (384 sits in between; 256 was the sweet spot here.)

## RECOMMENDATION (ranking)

1. **KEEP `granite-embedding-107m-multilingual` (R1) as the swap target.** It is the only candidate
   with no broken combo, has the best overall MRR on both the original and the widened set, and is
   the **only model already proven on the real-extension WebGPU path**. Smallest-risk path. (This
   confirms Round 1's pick now that the golden set is broader and two newer models are in the race.)
2. **Reject granite-97m R2 as the swap.** Cleaner packaging and great EN->EN recall, but it kills
   EN->KO and has lower overall MRR than R1. Revisit only if EN->KO is declared a non-goal.
3. **EmbeddingGemma-300m = a product bet, not a default.** Best-in-class on every Korean-query
   direction and, at **MRL-256, the cheapest storage** of the lot, but it (a) fully breaks EN->KO,
   (b) is a ~309 MB external-data download (3x bigger), and (c) is an unproven arch on the extension.
   Adopt **only** if the product decides EN->KO (English query -> Korean page) is rare, and then ship
   it as **MRL-256** after a WebGPU probe.

### Which models still need a real-extension WebGPU / onnxruntime-web probe

| Model | Probe status |
|---|---|
| e5-small | not needed — runs in production today |
| granite-107m R1 | **already passed** (device=webgpu, dims=384) |
| granite-97m R2 | **needs a probe** — ModernBERT is a new arch on the extension path; expected to work (transformers.js supports ModernBERT) but unproven |
| EmbeddingGemma-300m | **needs a probe** — Gemma3 arch + external-data ONNX (~309 MB) + 768-dim memory; in-browser demos exist so it is feasible, but unverified on our offscreen WASM/WebGPU loader |

## Reproduce (Round 2)

```sh
# granite R2 (97m multilingual, standard ONNX, no prefix)
rm -rf eval/.cache/embeds && \
  EVAL_MODEL="onnx-community/granite-embedding-97m-multilingual-r2-ONNX" EVAL_DTYPE=q8 EVAL_PREFIX=none \
  npm run eval -- --strip --min-prose=0.35

# EmbeddingGemma full 768 (gemma task prompts)
rm -rf eval/.cache/embeds && \
  EVAL_MODEL="onnx-community/embeddinggemma-300m-ONNX" EVAL_DTYPE=q8 EVAL_PREFIX=gemma \
  npm run eval -- --strip --min-prose=0.35

# EmbeddingGemma MRL-256 (truncate + renormalize to 256 dims)
rm -rf eval/.cache/embeds && \
  EVAL_MODEL="onnx-community/embeddinggemma-300m-ONNX" EVAL_DTYPE=q8 EVAL_PREFIX=gemma EVAL_MRL_DIM=256 \
  npm run eval -- --strip --min-prose=0.35

# any of the above on the widened set: append  --golden=eval/golden-extended.json
```

Raw Round-2 scorecards: `eval/scorecard-model-granite-r2-q8.json`,
`eval/scorecard-model-embeddinggemma-{768,mrl384,mrl256}.json`, and the extended-set runs
`eval/scorecard-ext-*.json`.
