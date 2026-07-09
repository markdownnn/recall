import { NOT_FOUND_ANSWER, type AnswerGeneratorPort, type AskProgressEvent } from './answer-generator'
import { DEFAULT_ANSWER_RETRIEVAL_OPTIONS, type AnswerRetrievalOptions } from './answer-retrieval'
import type { AskAnswer, AskQuery, RankedResult } from './model'
import type { EmbeddingPort, VectorSearchPort } from './ports'

const MAX_ASK_SEARCH_QUERIES = 5

export class AskService {
  constructor(
    private readonly embedder: EmbeddingPort,
    private readonly store: VectorSearchPort,
    private readonly generator: AnswerGeneratorPort,
    private readonly retrievalOptions?: Partial<AnswerRetrievalOptions>,
  ) {}

  async ask(query: AskQuery): Promise<AskAnswer> {
    return this.askWithGenerator(query, (chunks) => this.generator.answer({ question: query.text, chunks }))
  }

  async askStream(
    query: AskQuery,
    onDelta: (delta: string) => void,
    onProgress?: (event: AskProgressEvent) => void,
  ): Promise<AskAnswer> {
    return this.askWithGenerator(query, (chunks) => {
      if (this.generator.answerStream) {
        return this.generator.answerStream({ question: query.text, chunks }, onDelta)
      }
      return this.generator.answer({ question: query.text, chunks }).then((draft) => {
        if (draft.text) onDelta(draft.text)
        return draft
      })
    }, onProgress)
  }

  private async askWithGenerator(
    query: AskQuery,
    generate: (chunks: RankedResult[]) => Promise<{ text: string; citedChunkIds: string[] }>,
    onProgress?: (event: AskProgressEvent) => void,
  ): Promise<AskAnswer> {
    const options: AnswerRetrievalOptions = this.retrievalOptions
      ? { ...DEFAULT_ANSWER_RETRIEVAL_OPTIONS, ...this.retrievalOptions }
      : {
          ...DEFAULT_ANSWER_RETRIEVAL_OPTIONS,
          pageK: Math.max(1, Math.ceil(query.retrieveK / 4)),
          maxContextChunks: query.contextK,
        }
    const searchQueries = await this.searchQueriesFor(query.text)
    if (searchQueries.length > 1) onProgress?.({ type: 'expanded-queries', queries: searchQueries })
    const vectors = await this.embedder.embed(searchQueries, 'query')
    const resultSets = await Promise.all(
      searchQueries.map((text, i) => this.store.searchForAnswer(vectors[i], text, options)),
    )
    const retrieved = mergeAnswerResults(resultSets)
    if (retrieved.length === 0) return { text: NOT_FOUND_ANSWER, sources: [] }

    const chunks = retrieved.slice(0, options.maxContextChunks)
    const draft = await generate(chunks)
    const sourceIds = new Set(draft.citedChunkIds)
    const sourcesByPage = new Map<string, RankedResult>()
    for (const result of chunks) {
      if (!sourceIds.has(result.chunk.id)) continue
      if (!sourcesByPage.has(result.page.id)) sourcesByPage.set(result.page.id, result)
      if (sourcesByPage.size >= 5) break
    }
    const sources = [...sourcesByPage.values()]
    return { text: draft.text, sources }
  }

  private async searchQueriesFor(question: string): Promise<string[]> {
    let expanded: string[] = []
    if (this.generator.expandQueries) {
      expanded = await this.generator.expandQueries(question).catch((err) => {
        console.warn('[recall] query expansion failed:', err)
        return []
      })
    }
    return uniqueQueries([question, ...expanded]).slice(0, MAX_ASK_SEARCH_QUERIES)
  }
}

function uniqueQueries(queries: string[]): string[] {
  const seen = new Set<string>()
  const clean: string[] = []
  for (const query of queries) {
    const text = query.trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    clean.push(text)
  }
  return clean
}

function mergeAnswerResults(resultSets: RankedResult[][]): RankedResult[] {
  const byChunk = new Map<string, { result: RankedResult; hits: number; firstRank: number }>()
  let rankCursor = 0
  for (const results of resultSets) {
    for (const result of results) {
      const found = byChunk.get(result.chunk.id)
      if (found) {
        found.hits += 1
        if (result.score > found.result.score) found.result = result
      } else {
        byChunk.set(result.chunk.id, { result, hits: 1, firstRank: rankCursor })
      }
      rankCursor += 1
    }
  }
  return [...byChunk.values()]
    .sort((a, b) => b.hits - a.hits || b.result.score - a.result.score || a.firstRank - b.firstRank)
    .map((entry) => entry.result)
}
