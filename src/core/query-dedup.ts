import { cosineSimilarity } from './cosine'

export interface EmbeddedQuery {
  text: string
  vector: Float32Array
}

// Keeps the first item unconditionally (the original question), then drops any later item
// whose cosine similarity to ANY already-kept item is at or above the threshold. This is the
// safety net for query expansion: an LLM that reworded the same question instead of finding a
// different angle should not waste a search pass.
export function dedupeSimilarQueries(items: EmbeddedQuery[], threshold: number): EmbeddedQuery[] {
  const kept: EmbeddedQuery[] = []
  for (const item of items) {
    const isDuplicate = kept.some((k) => cosineSimilarity(item.vector, k.vector) >= threshold)
    if (!isDuplicate) kept.push(item)
  }
  return kept
}
