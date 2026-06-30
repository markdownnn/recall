// Real multilingual-e5-small in Node, loaded from the BUNDLED model dir (no network),
// quantized to q8 to MATCH the extension (src/offscreen/webgpu-embedder.ts uses dtype:'q8').
// Mirrors the prod prefixes: queries get "query: ", passages get "passage: ".
import { pipeline, env } from '@huggingface/transformers'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

env.allowRemoteModels = false // offline + deterministic
env.localModelPath = resolve('public/models') // the bundled dir (filled by scripts/fetch-model.mjs)
env.cacheDir = resolve('eval/.cache')

// On-disk embedding cache. q8 inference is deterministic on CPU for a fixed input, so the
// vector for a given (kind, text) never changes between runs. Caching it keeps the slow
// before/after iteration (and CI) fast WITHOUT altering any result: a cache hit returns the
// exact bytes a fresh inference would. Keyed by sha256(kind + '\n' + text); stored as raw
// Float32 bytes under eval/.cache/embeds (gitignored).
const CACHE_DIR = resolve('eval/.cache/embeds')
mkdirSync(CACHE_DIR, { recursive: true })

function cachePath(kind, text) {
  const h = createHash('sha256').update(kind).update('\n').update(text).digest('hex')
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

let _pipe
async function pipe() {
  if (!_pipe)
    _pipe = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' })
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
    const prefixed = missIdx.map((i) => `${kind}: ${texts[i]}`)
    const res = await p(prefixed, { pooling: 'mean', normalize: true })
    const vecs = res.tolist().map((a) => new Float32Array(a))
    for (let j = 0; j < missIdx.length; j++) {
      const i = missIdx[j]
      out[i] = vecs[j]
      writeCache(kind, texts[i], vecs[j])
    }
  }
  return out
}
