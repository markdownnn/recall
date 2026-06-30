// Reciprocal Rank Fusion: combine several ranked id lists into one ordering without
// needing to normalize each source's score scale. score(id) = sum 1/(k + rank), rank
// 1-based; higher is better. k=60 is the standard constant.
export interface FusedHit {
  id: string
  score: number
}
// `weights` is an OPTIONAL per-list multiplier: score(id) = sum w_list/(k + rank).
// It defaults to all-1, which is byte-for-byte the original behavior. Up-weighting the
// lexical list lets an exact-term page beat an irrelevant high-cosine vector match (Fix 4)
// without touching pure-semantic queries (they have an EMPTY lexical list, so its weight is
// moot).
export function rrfFuse(lists: string[][], k = 60, weights?: number[]): FusedHit[] {
  const score = new Map<string, number>()
  lists.forEach((list, li) => {
    const w = weights?.[li] ?? 1
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + w / (k + i + 1))
    })
  })
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score)
}
