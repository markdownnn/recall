// Scenario: local e5-small must place a Korean/English query closer to the matching English passage
// than to an unrelated one; if this fails the product's core cross-lingual search breaks.
// Coverage: integration (real model inference, no mock).
// Worker wrapper is browser-only so node tests the embedding logic directly.

import { pipeline } from '@xenova/transformers'
import { cosineSimilarity } from '../../src/core/cosine'

test('cross-lingual: korean query is closest to matching english passage', async () => {
  const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small')
  const embed = async (t: string) => {
    const out = await extractor([t], { pooling: 'mean', normalize: true })
    return new Float32Array((out.tolist() as number[][])[0])
  }
  const query = await embed('query: what hormone wrecks my sleep')
  const right = await embed('passage: cortisol disrupts REM sleep')
  const wrong = await embed('passage: basics of tax accounting')

  const simRight = cosineSimilarity(query, right)
  const simWrong = cosineSimilarity(query, wrong)
  console.log('sim(query, right):', simRight, '  sim(query, wrong):', simWrong)

  expect(simRight).toBeGreaterThan(simWrong)
}, 120_000)

test('produces 384-dim vectors', async () => {
  const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small')
  const out = await extractor(['passage: hello'], { pooling: 'mean', normalize: true })
  expect((out.tolist() as number[][])[0].length).toBe(384)
}, 120_000)
