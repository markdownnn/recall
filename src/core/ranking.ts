import type { RankedResult } from './model'
import { proseScore } from './prose-score'

// Lexical lane weight in RRF fusion. >1 favors exact-term (FTS) matches over pure-vector
// matches, so a page that LITERALLY contains the query term beats an irrelevant high-cosine
// reference chunk (Fix 4). Tuned on the golden set (S2 exact-term passes) WITHOUT regressing
// pure-semantic queries, which have NO lexical candidates -> the weight has no effect there.
export const LEXICAL_RRF_WEIGHT = 2

// Prose-preferred snippet selection (Fix 3). Shared by the sqlite worker and the in-memory
// oracle so the two engines stay semantically identical (ADR 0020). EPSILON: how far below
// the max cosine a prose chunk may sit and still be shown. TAU: the proseScore threshold for
// "this chunk reads as prose, not a citation list".
export const SNIPPET_EPSILON = 0.03
export const SNIPPET_TAU = 0.35

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

// Given ALL of one page's vector candidates, pick the chunk to SHOW as that page's snippet
// while keeping the page's RANK score equal to the MAX cosine (ADR 0020: page score is the
// page's best chunk score, unchanged). If the max-cosine chunk is non-prose (a citation /
// boilerplate list), swap the snippet for the closest prose chunk within `epsilon` of the
// top cosine. Returns { id, score } where `score` is ALWAYS the page's max cosine, so the
// page's position in the vector lane never moves - only the displayed chunk id can differ.
export function chooseSnippetChunk(
  candidates: { id: string; cos: number; text: string }[],
  epsilon: number,
  tau: number,
): { id: string; score: number } {
  const maxCos = Math.max(...candidates.map((c) => c.cos))
  const top = candidates.reduce((a, b) => (b.cos > a.cos ? b : a))
  if (proseScore(top.text) >= tau) return { id: top.id, score: maxCos }
  const prose = candidates
    .filter((c) => c.cos >= maxCos - epsilon && proseScore(c.text) >= tau)
    .sort((a, b) => b.cos - a.cos)[0]
  return { id: (prose ?? top).id, score: maxCos }
}
