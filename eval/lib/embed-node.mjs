// Real multilingual embedding model in Node, for the golden-set A/B harness.
//
// Model selection is env-driven so one harness can A/B several models cleanly:
//   EVAL_MODEL   model id (default 'granite', the bundled prod model dir under public/models/)
//   EVAL_DTYPE   quantization passed to the pipeline (default q8, to match the extension)
//   EVAL_PREFIX  prefix convention: 'e5' => "query: "/"passage: " (e5 family),
//                'none' => raw text (MiniLM / granite and most sentence-transformers),
//                'gemma' => EmbeddingGemma task prompts
//                  query   => "task: search result | query: <text>"
//                  passage => "title: none | text: <text>"
//   EVAL_MRL_DIM  optional: Matryoshka truncation. If set (e.g. 256/384), every normalized
//                vector is sliced to the first N dims and re-normalized (applied to query AND
//                passage so dims match). Empty/0 = full native dim. Lets us trade storage for
//                quality on MRL models like EmbeddingGemma (768 native).
//   EVAL_MODEL_FILE  optional: exact onnx base name under onnx/ (no .onnx), for repos whose
//                quantized file does not follow the transformers.js dtype suffix convention
//                (e.g. granite R1's onnx/model_qint8_arm64.onnx). When set, dtype suffixing is
//                bypassed and this file is loaded verbatim.
//
// The bundled granite is loaded OFFLINE from public/models (committed + verified by
// scripts/fetch-model.mjs); any OTHER model id is fetched remotely into eval/.cache
// (gitignored) on first run.
import { pipeline, env } from '@huggingface/transformers'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BUNDLED = 'granite' // bundled prod model dir under public/models/ (granite-107m R1)
const MODEL = process.env.EVAL_MODEL || BUNDLED
const DTYPE = process.env.EVAL_DTYPE || 'q8'
const PREFIX = process.env.EVAL_PREFIX || 'none' // granite takes raw text (no e5 prefix)
const MODEL_FILE = process.env.EVAL_MODEL_FILE || '' // optional exact onnx base name
const MRL_DIM = Number(process.env.EVAL_MRL_DIM || 0) || 0 // 0 => full native dim

env.allowRemoteModels = MODEL !== BUNDLED // bundled stays offline+deterministic; others fetch
env.localModelPath = resolve('public/models') // the bundled dir
env.cacheDir = resolve('eval/.cache') // remote model weights land here (gitignored)

// On-disk embedding cache. q8/int8 inference is deterministic on CPU for a fixed input, so the
// vector for a given (model, dtype, prefix, kind, text) never changes between runs. The cache key
// INCLUDES the model id + dtype + prefix so switching models never returns another model's bytes
// (the historic gotcha was a model-agnostic key that silently scored the wrong model). Stored as
// raw Float32 bytes under eval/.cache/embeds (gitignored).
const CACHE_DIR = resolve('eval/.cache/embeds')
mkdirSync(CACHE_DIR, { recursive: true })

function cachePath(kind, text) {
  const h = createHash('sha256')
    .update(MODEL).update('\0')
    .update(DTYPE).update('\0')
    .update(MODEL_FILE).update('\0')
    .update(PREFIX).update('\0')
    .update(String(MRL_DIM)).update('\0')
    .update(kind).update('\n')
    .update(text)
    .digest('hex')
  return resolve(CACHE_DIR, `${h}.f32`)
}

function readCache(kind, text) {
  const p = cachePath(kind, text)
  if (!existsSync(p)) return null
  const buf = readFileSync(p)
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

function writeCache(kind, text, vec) {
  writeFileSync(cachePath(kind, text), Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength))
}

// 'e5' => prepend "query: " / "passage: "; 'gemma' => EmbeddingGemma task prompts;
// 'none' => raw text (no prefix convention).
function withPrefix(kind, text) {
  if (PREFIX === 'e5') return `${kind}: ${text}`
  if (PREFIX === 'gemma') {
    return kind === 'query'
      ? `task: search result | query: ${text}`
      : `title: none | text: ${text}`
  }
  return text
}

// Matryoshka truncation: slice a normalized vector to the first MRL_DIM dims and re-normalize.
// No-op when MRL_DIM is 0 or >= the native dim.
function mrlTruncate(vec) {
  if (!MRL_DIM || MRL_DIM >= vec.length) return vec
  const out = vec.slice(0, MRL_DIM)
  let norm = 0
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

let _pipe
async function pipe() {
  if (!_pipe) {
    console.log(`[embed] model=${MODEL} dtype=${DTYPE} prefix=${PREFIX}${MODEL_FILE ? ` file=onnx/${MODEL_FILE}.onnx` : ''}`)
    // EVAL_MODEL_FILE: load an exact onnx file (dtype suffix '' = fp32 means no extra suffix is
    // appended, so model_file_name is used verbatim). Otherwise dtype drives the suffix.
    const opts = MODEL_FILE ? { dtype: 'fp32', model_file_name: MODEL_FILE } : { dtype: DTYPE }
    _pipe = await pipeline('feature-extraction', MODEL, opts)
  }
  return _pipe
}

export async function embed(texts, kind /* 'query' | 'passage' */) {
  const out = new Array(texts.length)
  const missIdx = []
  for (let i = 0; i < texts.length; i++) {
    const hit = readCache(kind, texts[i])
    if (hit) out[i] = hit
    else missIdx.push(i)
  }
  if (missIdx.length > 0) {
    const p = await pipe()
    // Batch in small chunks. A single forward pass over the whole corpus pads every text to the
    // longest one; on a 32K-context model (granite R2 / EmbeddingGemma) that one giant padded
    // tensor spikes memory and the process is OOM-killed. Small batches keep peak memory bounded
    // and do not change the per-text vector (each text is mean-pooled independently).
    const BATCH = Number(process.env.EVAL_BATCH || 8) || 8
    const vecs = new Array(missIdx.length)
    for (let b = 0; b < missIdx.length; b += BATCH) {
      const slice = missIdx.slice(b, b + BATCH)
      const prefixed = slice.map((i) => withPrefix(kind, texts[i]))
      const res = await p(prefixed, { pooling: 'mean', normalize: true })
      const batchVecs = res.tolist().map((a) => mrlTruncate(new Float32Array(a)))
      for (let k = 0; k < slice.length; k++) vecs[b + k] = batchVecs[k]
    }
    for (let j = 0; j < missIdx.length; j++) {
      const i = missIdx[j]
      out[i] = vecs[j]
      writeCache(kind, texts[i], vecs[j])
    }
  }
  return out
}
