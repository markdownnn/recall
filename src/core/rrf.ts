// Reciprocal Rank Fusion: combine several ranked id lists into one ordering without
// needing to normalize each source's score scale. score(id) = sum 1/(k + rank), rank
// 1-based; higher is better. k=60 is the standard constant.
export interface FusedHit {
  id: string
  score: number
}
export function rrfFuse(lists: string[][], k = 60): FusedHit[] {
  const score = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1))
    })
  }
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score)
}
