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
