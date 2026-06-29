// Runs the multilingual-e5-small model directly in the calling thread (no Worker).
// Used in the service worker where Worker and URL.createObjectURL are not available.
import { pipeline, env, type FeatureExtractionPipeline } from '@xenova/transformers'
import type { EmbeddingPort } from '../core/ports'

// Force single-threaded WASM mode.
// The ONNX runtime creates a proxy worker via URL.createObjectURL for
// multi-threaded inference, but URL.createObjectURL is not available in
// Chrome extension service workers.  numThreads=1 disables the proxy worker.
env.backends.onnx.wasm.numThreads = 1

let extractorP: Promise<FeatureExtractionPipeline> | null = null

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorP) {
    extractorP = pipeline('feature-extraction', 'Xenova/multilingual-e5-small')
  }
  return extractorP
}

export class InlineEmbedder implements EmbeddingPort {
  async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const extractor = await getExtractor()
    const prefixed = texts.map((t) => `${kind}: ${t}`)
    const output = await extractor(prefixed, { pooling: 'mean', normalize: true })
    const list = output.tolist() as number[][]
    return list.map((arr) => new Float32Array(arr))
  }
}
