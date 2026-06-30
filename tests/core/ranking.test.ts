import { topPagesBySnippet, chooseSnippetChunk } from '../../src/core/ranking'
import type { RankedResult, CapturedPage } from '../../src/core/model'

// Fix 3: among a page's vector candidates, the displayed SNIPPET should prefer a prose
// chunk within epsilon of the top cosine, while the page RANK score stays the max cosine
// (ADR 0020). CITE is a citation-shaped chunk (proseScore low); PROSE is running text.
const CITE = 'doi 10 1 x PMID 123 ISSN 0022 Bibcode 2003 2019 56 417 PMC 9 S2CID 8'
const PROSE = 'bacteria are ubiquitous mostly free living single celled organisms today'

// Scenario: max-cosine chunk is a citation list; a near-tie prose chunk should be shown.
// Coverage: integration (pure function over real proseScore).
test('prefers a prose chunk within epsilon of the top cosine', () => {
  const cands = [
    { id: 'p#0', cos: 0.81, text: CITE },
    { id: 'p#1', cos: 0.79, text: PROSE },
  ]
  const r = chooseSnippetChunk(cands, 0.05, 0.35)
  expect(r.id).toBe('p#1')
  expect(r.score).toBeCloseTo(0.81) // PAGE score stays the MAX cosine (ADR 0020)
})

// Scenario: the only prose chunk is far below the top cosine; keep the max-cosine chunk.
// Coverage: integration (pure function).
test('keeps the max-cosine chunk when no prose chunk is within epsilon', () => {
  const cands = [
    { id: 'p#0', cos: 0.81, text: CITE },
    { id: 'p#1', cos: 0.6, text: PROSE },
  ]
  const r = chooseSnippetChunk(cands, 0.05, 0.35)
  expect(r.id).toBe('p#0')
  expect(r.score).toBeCloseTo(0.81)
})

// Scenario: the max-cosine chunk is already prose; no swap needed.
// Coverage: integration (pure function).
test('keeps the max-cosine chunk when it is already prose', () => {
  const cands = [
    { id: 'p#0', cos: 0.81, text: PROSE },
    { id: 'p#1', cos: 0.8, text: CITE },
  ]
  expect(chooseSnippetChunk(cands, 0.05, 0.35).id).toBe('p#0')
})

const page = (id: string): CapturedPage => ({ id, url: `http://x/${id}`, title: id.toUpperCase(), capturedAt: 1 })
const r = (pageId: string, idx: number, score: number): RankedResult => ({
  chunk: { id: `${pageId}#${idx}`, pageId, index: idx, text: `${pageId} chunk ${idx}` },
  page: page(pageId),
  score,
})

// Scenario: one page matches on several chunks; results list that page ONCE with its
// best chunk as the snippet, not flood the list with near-duplicate chunks.
// Coverage: integration (pure ranking over the real RankedResult shape).
test('collapses a page to one result carrying its best-scoring chunk', () => {
  const out = topPagesBySnippet([r('p1', 0, 0.4), r('p1', 1, 0.9), r('p2', 0, 0.5)], 5)
  expect(out.map((x) => x.page.id)).toEqual(['p1', 'p2']) // p1 wins via its 0.9 chunk
  expect(out[0].chunk.id).toBe('p1#1') // snippet = the best chunk
})

// Scenario: k caps distinct PAGES, even when one page contributes several top chunks.
// Coverage: integration (pure ranking).
test('k caps distinct pages, not chunks', () => {
  const out = topPagesBySnippet([r('p1', 0, 0.9), r('p1', 1, 0.85), r('p2', 0, 0.8), r('p3', 0, 0.7)], 2)
  expect(out.map((x) => x.page.id)).toEqual(['p1', 'p2'])
})
