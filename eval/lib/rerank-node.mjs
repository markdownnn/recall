// Cross-encoder reranker in Node, for the golden-set "does reranking lift ranking?" A/B.
//
// A cross-encoder reads the (query, passage) PAIR together and outputs a single relevance
// logit -- unlike the bi-encoder embedder, which encodes query and passage separately and
// compares vectors. That joint read is why it ranks better; it is also why it is slower, so
// we only ever score a small candidate set (retrieve-then-rerank).
//
// Model is env-driven so one harness can A/B rerankers:
//   RERANK_MODEL  model id (default 'Xenova/ms-marco-MiniLM-L-6-v2' -- small English cross-encoder)
//   RERANK_DTYPE  quantization (default q8, to match the extension's on-device budget)
//
// Weights are fetched remotely into eval/.cache (gitignored) on first run. Scores are cached
// on disk keyed by (model, dtype, query, text): q8 CPU inference is deterministic for a fixed
// input, so a pair's score never changes between runs.
import { AutoTokenizer, AutoModelForSequenceClassification, env } from '@huggingface/transformers'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const MODEL = process.env.RERANK_MODEL || 'Xenova/ms-marco-MiniLM-L-6-v2'
const DTYPE = process.env.RERANK_DTYPE || 'q8'

// embed-node.mjs may have set allowRemoteModels=false for the bundled BGE model; the reranker
// is never bundled, so it must be allowed to fetch. Setting this is safe: the BGE pipe is
// already loaded/cached by the time reranking runs, so flipping the flag does not re-fetch it.
env.allowRemoteModels = true
env.cacheDir = resolve('eval/.cache')

const CACHE_DIR = resolve('eval/.cache/rerank')
mkdirSync(CACHE_DIR, { recursive: true })

function scoreCacheKey(query, text) {
  return createHash('sha256')
    .update(MODEL).update('\0')
    .update(DTYPE).update('\0')
    .update(query).update('\n')
    .update(text)
    .digest('hex')
}

function readScore(query, text) {
  const p = resolve(CACHE_DIR, `${scoreCacheKey(query, text)}.txt`)
  if (!existsSync(p)) return null
  const v = Number(readFileSync(p, 'utf8'))
  return Number.isFinite(v) ? v : null
}

function writeScore(query, text, score) {
  writeFileSync(resolve(CACHE_DIR, `${scoreCacheKey(query, text)}.txt`), String(score))
}

let _model, _tokenizer
async function load() {
  if (!_model) {
    console.log(`[rerank] model=${MODEL} dtype=${DTYPE}`)
    _tokenizer = await AutoTokenizer.from_pretrained(MODEL)
    _model = await AutoModelForSequenceClassification.from_pretrained(MODEL, { dtype: DTYPE })
  }
  return { model: _model, tokenizer: _tokenizer }
}

// Returns a relevance score for each text against the query, in input order. Higher = more
// relevant. Cached texts skip inference; only cache-misses run the model.
export async function rerankScores(query, texts) {
  const out = new Array(texts.length)
  const missIdx = []
  for (let i = 0; i < texts.length; i++) {
    const hit = readScore(query, texts[i])
    if (hit !== null) out[i] = hit
    else missIdx.push(i)
  }
  if (missIdx.length > 0) {
    const { model, tokenizer } = await load()
    const BATCH = Number(process.env.RERANK_BATCH || 16) || 16
    for (let b = 0; b < missIdx.length; b += BATCH) {
      const slice = missIdx.slice(b, b + BATCH)
      const passages = slice.map((i) => texts[i])
      const inputs = tokenizer(new Array(passages.length).fill(query), {
        text_pair: passages,
        padding: true,
        truncation: true,
      })
      const { logits } = await model(inputs)
      const scores = logits.tolist().map((row) => row[0]) // single-logit relevance head
      for (let k = 0; k < slice.length; k++) {
        out[slice[k]] = scores[k]
        writeScore(query, texts[slice[k]], scores[k])
      }
    }
  }
  return out
}

// Reorders RankedResult-like candidates ({ chunk: { text } }) by cross-encoder score, best first.
// Pure reorder: it does not change scores on the objects, only their order.
export async function rerank(query, candidates) {
  const scores = await rerankScores(query, candidates.map((c) => c.chunk.text))
  return candidates
    .map((c, i) => ({ c, s: scores[i] }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c)
}
