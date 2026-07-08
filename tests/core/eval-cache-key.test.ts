import { describe, expect, test } from 'vitest'

const { embedCacheKey } = await import('../../eval/lib/embed-node.mjs')

describe('eval embed cache key', () => {
  // Scenario: 같은 모델과 같은 텍스트를 다시 평가할 때 큰 파일을 새로 처리하면 시간이 낭비된다.
  // Coverage: ✅ integration
  test('same model settings produce same cache key', () => {
    const input = {
      model: 'BAAI/bge-base-en-v1.5',
      dtype: 'q8',
      modelFile: '',
      prefix: 'bge',
      mrlDim: 0,
      kind: 'query',
      text: 'powerhouse of the cell',
    }
    expect(embedCacheKey(input)).toBe(embedCacheKey(input))
  })

  // Scenario: 모델이 다른데 같은 캐시를 쓰면 잘못된 점수가 나온다.
  // Coverage: ✅ integration
  test('different model settings produce different cache keys', () => {
    const base = {
      model: 'BAAI/bge-base-en-v1.5',
      dtype: 'q8',
      modelFile: '',
      prefix: 'bge',
      mrlDim: 0,
      kind: 'query',
      text: 'powerhouse of the cell',
    }
    expect(embedCacheKey(base)).not.toBe(embedCacheKey({ ...base, model: 'BAAI/bge-large-en-v1.5' }))
  })
})
