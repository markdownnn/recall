import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers'

let extractorP: Promise<FeatureExtractionPipeline> | null = null
function getExtractor() {
  if (!extractorP) {
    extractorP = pipeline('feature-extraction', 'Xenova/multilingual-e5-small')
  }
  return extractorP
}

self.onmessage = async (e: MessageEvent<{ id: number; texts: string[]; kind: 'query' | 'passage' }>) => {
  const { id, texts, kind } = e.data
  try {
    const extractor = await getExtractor()
    const prefixed = texts.map((t) => `${kind}: ${t}`)
    const output = await extractor(prefixed, { pooling: 'mean', normalize: true })
    const list = output.tolist() as number[][]
    const vectors = list.map((arr) => new Float32Array(arr))
    ;(self as unknown as Worker).postMessage({ id, vectors }, vectors.map((v) => v.buffer) as unknown as Transferable[])
  } catch (err) {
    self.postMessage({ id, error: String(err) })
  }
}
