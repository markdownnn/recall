// Runs the multilingual-e5-small model directly in the calling thread (no Worker).
// Used in the service worker where Worker and URL.createObjectURL are not available.
import { pipeline, env, type FeatureExtractionPipeline } from '@xenova/transformers'
import type { EmbeddingPort } from '../core/ports'

// Force single-threaded WASM mode.
// The ONNX runtime creates a proxy worker via URL.createObjectURL for
// multi-threaded inference, but URL.createObjectURL is not available in
// Chrome extension service workers.  numThreads=1 disables the proxy worker.
env.backends.onnx.wasm.numThreads = 1

// Module-level singleton: loaded once, shared across all InlineEmbedder instances.
let extractorP: Promise<FeatureExtractionPipeline> | null = null

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorP) {
    // Pinned to an immutable commit (supply-chain: HF 'main' must not be trusted to stay constant).
    extractorP = pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
      revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    })
  }
  return extractorP
}

export class InlineEmbedder implements EmbeddingPort {
  // Max texts per single ONNX forward pass — bounds peak memory in the service worker.
  private static BATCH = 32

  // Serializes concurrent embed() calls so ONNX never receives two overlapping inputs.
  private queue: Promise<unknown> = Promise.resolve()

  private async runEmbed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += InlineEmbedder.BATCH) {
      const slice = texts.slice(i, i + InlineEmbedder.BATCH)
      const extractor = await getExtractor()
      const prefixed = slice.map((t) => `${kind}: ${t}`)
      const output = await extractor(prefixed, { pooling: 'mean', normalize: true })
      for (const arr of output.tolist() as number[][]) out.push(new Float32Array(arr))
    }
    return out
  }

  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const run = () => this.runEmbed(texts, kind)
    // Chain onto the queue regardless of whether the previous call succeeded or failed.
    const result = this.queue.then(run, run)
    // Advance the queue; swallow the result so a rejection never breaks the chain.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
