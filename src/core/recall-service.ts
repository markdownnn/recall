import type { EmbeddingPort, RerankPort, VectorSearchPort } from './ports'
import type { RankedResult, RecallQuery } from './model'

// How many candidates to retrieve before the reranker picks the top k. Wider than any k the UI
// asks for, so a target the vector+FTS order buries at rank 6-N can still be rescued into the
// top k by the cross-encoder. Measured lift at N=25 on the english golden set: P@1 0.58->0.83.
export const DEFAULT_RERANK_CANDIDATE_K = 25

export class RecallService {
  constructor(
    private readonly embedder: EmbeddingPort,
    private readonly store: VectorSearchPort,
    // Optional: when absent, recall returns the raw hybrid-search order (the reranker model may
    // be unavailable on this device, or reranking may be off). Resilience over regression.
    private readonly reranker?: RerankPort,
    private readonly candidateK = DEFAULT_RERANK_CANDIDATE_K,
  ) {}

  async recall(query: RecallQuery): Promise<RankedResult[]> {
    const [vector] = await this.embedder.embed([query.text], 'query')
    if (!this.reranker) return this.store.search(vector, query.text, query.k)
    // Retrieve a wider pool, then let the cross-encoder pick the best k out of it.
    const candidates = await this.store.search(vector, query.text, Math.max(this.candidateK, query.k))
    try {
      return await this.reranker.rerank(query.text, candidates, query.k)
    } catch (err) {
      // Reranking is best-effort: if the model is unavailable on this device (WebGPU + WASM both
      // failed), never break search -- fall back to the raw hybrid-search order.
      console.warn('[recall] rerank failed, using hybrid order:', String(err))
      return candidates.slice(0, query.k)
    }
  }
}
