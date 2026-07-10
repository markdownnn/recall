// Pure retrieval metrics for the golden-set harness. Inputs are already-ranked PAGE-id
// lists plus the expected page id(s). Single relevant doc per query, so recall@k is binary.

export function precisionAt1(ranked: string[], expected: string[]): number {
  return ranked.length > 0 && expected.includes(ranked[0]) ? 1 : 0
}

export function recallAtK(ranked: string[], expected: string[], k: number): number {
  return ranked.slice(0, k).some((id) => expected.includes(id)) ? 1 : 0
}

export function mrr(ranked: string[], expected: string[]): number {
  const i = ranked.findIndex((id) => expected.includes(id))
  return i === -1 ? 0 : 1 / (i + 1)
}

// The headline regression number. Each query contributes whether its TOP-1 result's
// snippet read as prose (true) or as a citation/boilerplate list (false). The rate is
// the fraction that were NON-prose - i.e. the bug rate. Lower is better; the fix target
// is 0.
export function referenceSnippetRate(perQuery: { topIsProse: boolean }[]): number {
  if (perQuery.length === 0) return 0
  const bad = perQuery.filter((q) => !q.topIsProse).length
  return bad / perQuery.length
}

export interface PerQuery {
  p1: number
  r5: number
  rr: number
}
export function aggregate(rows: PerQuery[]): { precisionAt1: number; recallAt5: number; mrr: number } {
  if (rows.length === 0) return { precisionAt1: 0, recallAt5: 0, mrr: 0 }
  const sum = (sel: (r: PerQuery) => number) => rows.reduce((a, r) => a + sel(r), 0) / rows.length
  return { precisionAt1: sum((r) => r.p1), recallAt5: sum((r) => r.r5), mrr: sum((r) => r.rr) }
}

// Ask-quality harness metrics (docs/superpowers/specs/2026-07-09-ask-answer-quality-design.md).
// Ground truth is PAGE-level, matching the existing golden-set convention (see CONTEXT.md's
// "Golden set" entry) — chunk ids shift whenever chunking changes, pages do not.

// Whether the final context handed to the answer model contains any chunk from an expected
// page. Catches "search found the right page but truncating to N context chunks dropped it."
export function evidenceRecallAtContext(contextPageIds: string[], expectedPageIds: string[]): number {
  return contextPageIds.some((id) => expectedPageIds.includes(id)) ? 1 : 0
}

// Whether the confidence gate's pass/block decision matches the golden set's expectation.
export function confidenceGateCorrect(passesGate: boolean, expectAnswerable: boolean): number {
  return passesGate === expectAnswerable ? 1 : 0
}
