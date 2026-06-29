// Scenario: InlineEmbedder must produce 384-dim vectors and must apply
// the kind prefix so that query vs passage embeddings differ.
// Coverage: integration (real model, no mock).

import { InlineEmbedder } from '../../src/adapters/inline-embedder'
import { cosineSimilarity } from '../../src/core/cosine'

test('embed returns one Float32Array of length 384', async () => {
  const embedder = new InlineEmbedder()
  const results = await embedder.embed(['hello'], 'passage')
  expect(results.length).toBe(1)
  expect(results[0]).toBeInstanceOf(Float32Array)
  expect(results[0].length).toBe(384)
}, 120_000)

test('query prefix produces a different vector than passage prefix for the same text', async () => {
  const embedder = new InlineEmbedder()
  const [queryVec] = await embedder.embed(['cortisol disrupts sleep'], 'query')
  const [passageVec] = await embedder.embed(['cortisol disrupts sleep'], 'passage')
  const sim = cosineSimilarity(queryVec, passageVec)
  console.log('cosine(query prefix, passage prefix) same text:', sim)
  // Prefixes produce noticeably different directions (not identical).
  expect(sim).toBeLessThan(0.9999)
}, 120_000)

// Scenario: Three concurrent embed() calls on the same embedder must not
// corrupt each other via the shared ONNX session (the serialization queue fix).
// Coverage: integration (real model, exercises the queue code path).
test('3 concurrent embed calls return correct counts, dims, and no cross-contamination between kinds', async () => {
  const embedder = new InlineEmbedder()

  // Fire all three without awaiting — they queue internally.
  const [r1, r2, r3] = await Promise.all([
    embedder.embed(['cortisol disrupts sleep'], 'query'),
    embedder.embed(['cortisol disrupts sleep'], 'passage'),
    embedder.embed(['the quick brown fox'], 'passage'),
  ])

  // Each call returns exactly 1 vector of 384 dims.
  expect(r1.length).toBe(1)
  expect(r2.length).toBe(1)
  expect(r3.length).toBe(1)
  expect(r1[0].length).toBe(384)
  expect(r2[0].length).toBe(384)
  expect(r3[0].length).toBe(384)

  // r1 is 'query' kind, r2 is 'passage' kind for the same text.
  // They must differ — proves kind was not contaminated across queued calls.
  const sim = cosineSimilarity(r1[0], r2[0])
  console.log('cosine(query, passage) same text concurrent:', sim)
  expect(sim).toBeLessThan(0.9999)
}, 120_000)

// Scenario: A page with 40+ chunks must not OOM the service worker; the
// sub-batch loop (BATCH=32) must preserve order and vector count.
// Coverage: integration (real model, exercises the batching loop).
test('embed of 40 distinct texts returns exactly 40 vectors each of length 384', async () => {
  const embedder = new InlineEmbedder()
  const texts = Array.from({ length: 40 }, (_, i) => `sentence number ${i} about recall`)
  const results = await embedder.embed(texts, 'passage')

  expect(results.length).toBe(40)
  for (const vec of results) {
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(384)
  }
}, 120_000)
