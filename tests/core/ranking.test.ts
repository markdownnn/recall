import { topPagesBySnippet } from '../../src/core/ranking'
import type { RankedResult, CapturedPage } from '../../src/core/model'

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
