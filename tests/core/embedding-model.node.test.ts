// Scenario: the bundled model (granite) must place a Korean/English query closer to the
// matching English passage than to an unrelated one - with NO e5-style prefix. If this fails,
// cross-lingual search is broken on the model we actually ship.
// Coverage: integration (real granite inference from the bundled artifact, no mock).
// Worker wrapper is browser-only so node tests the embedding logic directly. Granite is loaded
// OFFLINE from public/models/granite (the same committed artifact the extension ships), dtype
// q8, raw text (no prefix), mirroring the eval + production embedder.

import { pipeline, env } from '@huggingface/transformers'
import { resolve } from 'node:path'
import { cosineSimilarity } from '../../src/core/cosine'

env.allowLocalModels = true
env.allowRemoteModels = false
env.localModelPath = resolve('public/models') // load the bundled 'granite' dir offline

async function loadEmbed() {
  const extractor = await pipeline('feature-extraction', 'granite', { dtype: 'q8' })
  return async (t: string) => {
    const out = await extractor([t], { pooling: 'mean', normalize: true })
    return new Float32Array((out.tolist() as number[][])[0])
  }
}

test('cross-lingual english: english query is closest to matching english passage', async () => {
  const embed = await loadEmbed()
  const query = await embed('what hormone wrecks my sleep')
  const right = await embed('cortisol disrupts REM sleep')
  const wrong = await embed('basics of tax accounting')

  const simRight = cosineSimilarity(query, right)
  const simWrong = cosineSimilarity(query, wrong)
  console.log('sim(english query, right):', simRight, '  sim(english query, wrong):', simWrong)

  expect(simRight).toBeGreaterThan(simWrong)
}, 120_000)

// Non-ASCII allowed here: verifying cross-lingual retrieval with a Korean query.
test('cross-lingual korean query: korean query is closest to matching english passage', async () => {
  const embed = await loadEmbed()
  // Korean: "hormone that ruins sleep"
  const query = await embed('잠을 망치는 호르몬')
  const right = await embed('cortisol disrupts REM sleep')
  const wrong = await embed('basics of tax accounting')

  const simRight = cosineSimilarity(query, right)
  const simWrong = cosineSimilarity(query, wrong)
  console.log('sim(korean query, right):', simRight, '  sim(korean query, wrong):', simWrong)

  expect(simRight).toBeGreaterThan(simWrong)
}, 120_000)

test('produces 384-dim vectors', async () => {
  const embed = await loadEmbed()
  const v = await embed('hello')
  expect(v.length).toBe(384)
}, 120_000)
