// Worker wrapper is browser-only so node tests the embedding logic directly.

import { pipeline, env } from '@huggingface/transformers'
import { resolve } from 'node:path'
import { cosineSimilarity } from '../../src/core/cosine'

env.allowRemoteModels = true
env.cacheDir = resolve('eval/.cache')

async function loadEmbed() {
  const extractor = await pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5', { dtype: 'q8' })
  return async (t: string) => {
    const out = await extractor([t], { pooling: 'mean', normalize: true })
    return new Float32Array((out.tolist() as number[][])[0])
  }
}

// Scenario: 영어 질문은 맞는 영어 글 조각에 더 가까워야 한다.
// Coverage: ✅ integration
test('english query is closest to matching english passage', async () => {
  const embed = await loadEmbed()
  const query = await embed('Represent this sentence for searching relevant passages: what hormone wrecks my sleep')
  const right = await embed('cortisol disrupts REM sleep')
  const wrong = await embed('basics of tax accounting')

  expect(cosineSimilarity(query, right)).toBeGreaterThan(cosineSimilarity(query, wrong))
}, 120_000)

// Scenario: BGE base는 768칸짜리 벡터를 만든다.
// Coverage: ✅ integration
test('produces 768-dim vectors for bge base', async () => {
  const embed = await loadEmbed()
  const v = await embed('hello')
  expect(v.length).toBe(768)
}, 120_000)
