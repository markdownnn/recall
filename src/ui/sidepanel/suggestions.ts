// Example queries for the search placeholder. One is picked at random on mount and kept
// (no rotation). Dev/research, sentence-form. Kept ASCII/English for v1.
export const SUGGESTIONS = [
  'that article about transformer attention',
  'the paper on retrieval-augmented generation',
  'how to cancel a fetch in React',
  'that thread on database index types',
  'the explainer on CRDTs',
  'the study about sleep and memory',
  'that post comparing vector databases',
  'how rate limiting actually works',
  'the survey on diffusion models',
  'that Stack Overflow answer about race conditions',
  'the writeup on Postgres query planning',
]

// Pure index helper so the random pick is testable without a DOM.
export function randomIndex(len: number, rng: () => number = Math.random): number {
  return Math.min(len - 1, Math.floor(rng() * len))
}
