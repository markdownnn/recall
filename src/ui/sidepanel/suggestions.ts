// Rotating example queries for the search placeholder. Kept ASCII/English for v1.
export const SUGGESTIONS = [
  'that article about sleep and cortisol',
  'double entry bookkeeping basics',
  'how photosynthesis works',
  'the marsupial reproduction page',
  'notes on RRF hybrid search',
  'local-first browser extensions',
  'OPFS sqlite performance',
  'WebGPU embedding models',
  'paragraph chunking strategy',
  'that thing about service workers',
]

// Pure index helpers so the rotation logic is testable without a timer or a DOM.
export function randomIndex(len: number, rng: () => number = Math.random): number {
  return Math.min(len - 1, Math.floor(rng() * len))
}
export function nextIndex(cur: number, len: number): number {
  return (cur + 1) % len
}
