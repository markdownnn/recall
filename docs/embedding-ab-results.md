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
