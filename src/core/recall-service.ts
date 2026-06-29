import type { EmbeddingPort, VectorSearchPort } from './ports'
import type { RankedResult, RecallQuery } from './model'

export class RecallService {
  constructor(
    private readonly embedder: EmbeddingPort,
    private readonly store: VectorSearchPort,
  ) {}

  async recall(query: RecallQuery): Promise<RankedResult[]> {
    const [vector] = await this.embedder.embed([query.text], 'query')
    return this.store.search(vector, query.k)
  }
}
