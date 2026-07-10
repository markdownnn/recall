// Real on-device cross-encoder reranker, running inside the offscreen document. Given a query
// and a small retrieved candidate set, it re-scores each (query, chunk) PAIR jointly and reorders
// them, best first. Tries WebGPU (fast) and falls back to single-thread WASM; if BOTH fail the
// load REJECTS so the recall path can simply skip reranking (RecallService takes the reranker as
// optional -- resilience over regression).
//
// This is the REAL reranker of the hexagonal architecture. The scoring model is injected via a
// factory so unit tests exercise the load/fallback/reorder logic with a FAKE scorer and never
// download the ~22MB model.
import { AutoTokenizer, AutoModelForSequenceClassification, env } from '@huggingface/transformers'
import { MODEL_CDN_BASE_URL } from '../core/model-cdn'
import type { RankedResult } from '../core/model'
import type { RerankPort } from '../core/ports'

// Hosted at cdn.teamnyongs.com/models/ms-marco-minilm-l6-v2/resolve/main/ (q8 cross-encoder).
const MODEL_ID = 'ms-marco-minilm-l6-v2'
const BATCH = 16

// Scores each (query, passage) pair into a relevance logit (higher = more relevant). Injectable
// so tests supply a fake and drive the adapter without a real model.
export interface RerankScorer {
  score(query: string, passages: string[]): Promise<number[]>
}
export type RerankerFactory = (device: 'webgpu' | 'wasm') => Promise<RerankScorer>

// Keep in sync with webgpu-embedder.ts configureEnv: both point the ONNX runtime at the bundled
// WASM and load models from our CDN. Browser-only (no-op under Node tests, which use fake
// factories), idempotent.
let _envConfigured = false
function configureEnv(): void {
  if (_envConfigured) return
  _envConfigured = true
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return
  const onnxHfBase = chrome.runtime.getURL('onnx-hf/')
  ;(env.backends.onnx as any).wasm.wasmPaths = {
    wasm: `${onnxHfBase}ort-wasm-simd-threaded.asyncify.wasm`,
    mjs: `${onnxHfBase}ort-wasm-simd-threaded.asyncify.mjs`,
  }
  env.allowLocalModels = false
  env.allowRemoteModels = true
  env.remoteHost = MODEL_CDN_BASE_URL
  env.remotePathTemplate = '{model}/resolve/{revision}/'
  env.useBrowserCache = true
}

// Real factory: load the cross-encoder via transformers.js and wrap it as a RerankScorer.
export const realRerankerFactory: RerankerFactory = async (device) => {
  configureEnv()
  if (device === 'wasm') (env.backends.onnx as any).wasm.numThreads = 1
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID)
  const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { device, dtype: 'q8' })
  return {
    async score(query, passages) {
      const inputs = tokenizer(new Array(passages.length).fill(query), {
        text_pair: passages,
        padding: true,
        truncation: true,
      })
      const { logits } = await model(inputs)
      return (logits.tolist() as number[][]).map((row) => row[0])
    },
  }
}

export class WebGpuReranker implements RerankPort {
  // Created once; concurrent reranks share this load promise.
  private scorerP: Promise<RerankScorer> | null = null
  private _device: 'webgpu' | 'wasm' | null = null
  // Serializes scoring so ONNX never gets two overlapping inferences on one session.
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly factory: RerankerFactory = realRerankerFactory) {}

  get device(): 'webgpu' | 'wasm' | null {
    return this._device
  }

  private load(): Promise<RerankScorer> {
    if (!this.scorerP) {
      // POISONED-PIPE FIX: null on failure so the NEXT rerank retries (e.g. after network
      // recovery) instead of replaying the cached rejection forever.
      this.scorerP = this.createScorer().catch((e) => {
        this.scorerP = null
        throw e
      })
    }
    return this.scorerP
  }

  private async createScorer(): Promise<RerankScorer> {
    // WebGPU first; a load OR warmup failure means it's unusable here -> fall back to WASM.
    try {
      const s = await this.factory('webgpu')
      await s.score('warmup', ['warmup'])
      this._device = 'webgpu'
      console.log('[recall] reranker ready on WebGPU')
      return s
    } catch (e) {
      console.warn('[recall] reranker WebGPU unavailable, falling back to WASM:', String(e))
    }
    // WASM single-thread fallback. No further fallback: a throw here rejects the load.
    const s = await this.factory('wasm')
    await s.score('warmup', ['warmup'])
    this._device = 'wasm'
    console.warn('[recall] DEGRADED reranker: cross-encoder on WASM single-thread (slow)')
    return s
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => undefined)
    return run
  }

  async rerank(query: string, candidates: RankedResult[], k: number): Promise<RankedResult[]> {
    // 0 or 1 candidates can't be reordered; skip the model entirely so a single-hit recall
    // never pays the load/inference cost.
    if (candidates.length <= 1) return candidates.slice(0, k)
    return this.serialize(async () => {
      const scorer = await this.load()
      const scores = await this.scoreBatched(scorer, query, candidates.map((c) => c.chunk.text))
      return candidates
        .map((c, i) => ({ c, s: scores[i] }))
        .sort((a, b) => b.s - a.s)
        .slice(0, k)
        .map((x) => x.c)
    })
  }

  private async scoreBatched(scorer: RerankScorer, query: string, texts: string[]): Promise<number[]> {
    const out: number[] = []
    for (let i = 0; i < texts.length; i += BATCH) {
      out.push(...(await scorer.score(query, texts.slice(i, i + BATCH))))
    }
    return out
  }
}
