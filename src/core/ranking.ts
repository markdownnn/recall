import type { RankedResult } from './model'

// Per-lane candidate cap. Each retrieval lane (vector, lexical) yields up to this many
// DISTINCT PAGES (each represented by its best chunk in that lane), NOT this many chunks.
// Capping chunks let one busy page with >N high-scoring chunks fill a lane and collapse to
// a single result after topPagesBySnippet; capping DISTINCT PAGES keeps the fused set
// page-diverse so topPagesBySnippet(k) can return min(k, distinctMatchingPages). Shared by
// the sqlite worker and the in-memory oracle so the two engines stay semantically identical.
export const CANDIDATE_PAGE_LIMIT = 50

// Collapse chunk-level results to document-level: keep, per page, the single highest-
// scoring chunk as that page's representative snippet, then rank pages by that best score
// and return the top k. One busy page shows up once (with its strongest match) instead of
// flooding the list with near-duplicate chunks. Pure semantic ranking - the page score is
// its max chunk score, no recency boost (ADR 0003), no spreading across the page's chunks.
export function topPagesBySnippet(results: RankedResult[], k: number): RankedResult[] {
  const bestByPage = new Map<string, RankedResult>()
  for (const r of results) {
    const cur = bestByPage.get(r.page.id)
    if (!cur || r.score > cur.score) bestByPage.set(r.page.id, r)
  }
  return [...bestByPage.values()].sort((a, b) => b.score - a.score).slice(0, k)
}
