import type { AnswerGeneratorPort } from './answer-generator'
import type { AskAnswer, AskQuery, RankedResult } from './model'
import type { EmbeddingPort, VectorSearchPort } from './ports'

const NOT_FOUND = 'I could not find that in your saved pages.'

export class AskService {
  constructor(
    private readonly embedder: EmbeddingPort,
    private readonly store: VectorSearchPort,
    private readonly generator: AnswerGeneratorPort,
  ) {}

  async ask(query: AskQuery): Promise<AskAnswer> {
    const [vector] = await this.embedder.embed([query.text], 'query')
    const retrieved = await this.store.search(vector, query.text, query.retrieveK)
    if (retrieved.length === 0) return { text: NOT_FOUND, sources: [] }

    const chunks = retrieved.slice(0, query.contextK)
    const draft = await this.generator.answer({ question: query.text, chunks })
    const sourceIds = new Set(draft.citedChunkIds)
    const sources: RankedResult[] = chunks.filter((r) => sourceIds.has(r.chunk.id)).slice(0, 5)
    return { text: draft.text, sources }
  }
}
