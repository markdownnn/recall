// Real multilingual-e5-small in Node, loaded from the BUNDLED model dir (no network),
// quantized to q8 to MATCH the extension (src/offscreen/webgpu-embedder.ts uses dtype:'q8').
// Mirrors the prod prefixes: queries get "query: ", passages get "passage: ".
import { pipeline, env } from '@huggingface/transformers'
import { resolve } from 'node:path'

env.allowRemoteModels = false // offline + deterministic
env.localModelPath = resolve('public/models') // the bundled dir (filled by scripts/fetch-model.mjs)
env.cacheDir = resolve('eval/.cache')

let _pipe
async function pipe() {
  if (!_pipe)
    _pipe = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' })
  return _pipe
}

export async function embed(texts, kind /* 'query' | 'passage' */) {
  const p = await pipe()
  const prefixed = texts.map((t) => `${kind}: ${t}`)
  const out = await p(prefixed, { pooling: 'mean', normalize: true })
  return out.tolist().map((a) => new Float32Array(a))
}
