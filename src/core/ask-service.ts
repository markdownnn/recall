import { NOT_FOUND_ANSWER, type AnswerGeneratorPort, type AskProgressEvent } from './answer-generator'
import { DEFAULT_ANSWER_RETRIEVAL_OPTIONS, type AnswerRetrievalOptions } from './answer-retrieval'
import type { AskAnswer, AskQuery, RankedResult } from './model'
import type { EmbeddingPort, VectorSearchPort } from './ports'
import { dedupeSimilarQueries, type EmbeddedQuery } from './query-dedup'

const MAX_ASK_SEARCH_QUERIES = 5
// Starting values (docs/superpowers/specs/2026-07-09-ask-answer-quality-design.md §11).
// Tuned via `npm run eval:ask`; update this comment with the final value + rationale once
// measured.
// QUERY_DEDUP_THRESHOLD: left at the starting value. `eval/fixtures/expansions.json` is
// empty, so the 9-query eval:ask set never produces more than 1 surviving query per
// question (survQ was 1 for all 9 rows) — dedup never actually triggers, so this run
// gives no signal to tune it from.
export const QUERY_DEDUP_THRESHOLD = 0.92
// ASK_MIN_CONFIDENCE: measured 2026-07-09 via eval:ask (9-query set: 6 answerable, 3
// unanswerable). Raised from 0.3 to 0.70 -> gate-accuracy 7/9 (was 6/9 at 0.3). The two
// groups' top scores overlap (answerable: 0.648-0.776, unanswerable: 0.556-0.691), so no
// single threshold on this sample reaches 9/9 -- 7/9 is the measured ceiling, tied between
// two disjoint bands: (0.556, 0.648] (0 false negatives, 2 false positives) and
// (0.691, 0.707] (2 false negatives, 0 false positives). Picked the latter (0.70) per
// ADR 0024 (docs/adr/0024-ask-shows-only-verified-grounding.md): an unanswered "not
// found" is safer than a hallucinated answer, and one of the 2 false positives at the
// lower band is a medical-dosage question ("what dose of melatonin..."), the worst case
// to get wrong. More negative examples in the golden set would be needed to separate the
// bands further.
export const ASK_MIN_CONFIDENCE = 0.7

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
    const searchQueries = await this.resolveSearchQueries(query.text)
    if (searchQueries.length > 1) {
      onProgress?.({ type: 'expanded-queries', queries: searchQueries.map((q) => q.text) })
    }
    const resultSets = await Promise.all(
      searchQueries.map((q) => this.store.searchForAnswer(q.vector, q.text, options)),
    )
    const retrieved = mergeAnswerResults(resultSets)
    if (!passesConfidenceGate(topScoreOf(retrieved), ASK_MIN_CONFIDENCE)) {
      return { text: NOT_FOUND_ANSWER, sources: [] }
    }

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

  // Expands the question via the generator (best-effort), textually dedupes, embeds every
  // surviving candidate in one batch, then semantically dedupes so a reworded-not-diversified
  // expansion never burns a second search pass on the same idea. The original question is
  // always first and is never dropped (dedupeSimilarQueries keeps the first item unconditionally).
  private async resolveSearchQueries(question: string): Promise<EmbeddedQuery[]> {
    let expanded: string[] = []
    if (this.generator.expandQueries) {
      expanded = await this.generator.expandQueries(question).catch((err) => {
        console.warn('[recall] query expansion failed:', err)
        return []
      })
    }
    const texts = uniqueQueries([question, ...expanded]).slice(0, MAX_ASK_SEARCH_QUERIES)
    const vectors = await this.embedder.embed(texts, 'query')
    const candidates = texts.map((text, i) => ({ text, vector: vectors[i] }))
    return dedupeSimilarQueries(candidates, QUERY_DEDUP_THRESHOLD)
  }
}

// Whether the top (best) merged result is strong enough to answer from. Below the threshold,
// AskService returns NOT_FOUND_ANSWER without ever calling the generator (ADR 0024: a weak
// match should not be dressed up into a confident-sounding hallucination).
export function passesConfidenceGate(topScore: number, minScore: number): boolean {
  return topScore >= minScore
}

// mergeAnswerResults sorts by hit-count (how many expanded queries corroborated a chunk)
// BEFORE score, so results[0] is not necessarily the highest-scoring chunk -- a mediocre
// chunk two queries agree on can outrank a single query's much stronger match. The confidence
// gate needs the true best evidence, so this takes the max score across everything retrieved
// rather than trusting merge order. -Infinity on an empty array means passesConfidenceGate
// fails naturally, with no separate empty-array branch needed. Exported so eval/run-ask.mjs
// measures the exact same "top score" production actually gates on, instead of a second
// hand-written copy that could silently drift from this one.
export function topScoreOf(results: RankedResult[]): number {
  return results.reduce((max, r) => Math.max(max, r.score), -Infinity)
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

export function mergeAnswerResults(resultSets: RankedResult[][]): RankedResult[] {
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
