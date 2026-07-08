import { readFileSync } from 'node:fs'

// Scenario: 임베딩 모델을 감으로 고르면 검색 품질이 나빠져도 모른다.
// Coverage: ✅ integration
test('english golden set contains only english-to-english cases', () => {
  const golden = JSON.parse(readFileSync('eval/english-golden.json', 'utf8')) as Array<{
    combo: string
    query: string
    expectTopPageIds: string[]
  }>
  const manifest = JSON.parse(readFileSync('eval/manifest.json', 'utf8')) as Array<{ id: string }>
  const manifestIds = new Set(manifest.map((row) => row.id))

  expect(golden.length).toBeGreaterThanOrEqual(12)
  expect(golden.every((row) => row.combo === 'EN->EN')).toBe(true)
  expect(golden.every((row) => /^[\x00-\x7F]*$/.test(row.query))).toBe(true)
  expect(golden.flatMap((row) => row.expectTopPageIds).every((id) => manifestIds.has(id))).toBe(true)
})

// Scenario: 큰 모델도 한 번은 숫자로 비교해야 선택 근거가 생긴다.
// Coverage: ✅ integration
test('bge candidate list includes small base and large', () => {
  const candidates = JSON.parse(readFileSync('eval/model-candidates.json', 'utf8'))
  expect(candidates).toEqual([
    {
      id: 'BAAI/bge-small-en-v1.5',
      dtype: 'q8',
      prefix: 'bge',
      modelFile: '',
      expectedSizeMB: 34,
    },
    {
      id: 'BAAI/bge-base-en-v1.5',
      dtype: 'q8',
      prefix: 'bge',
      modelFile: '',
      expectedSizeMB: 110,
    },
    {
      id: 'BAAI/bge-large-en-v1.5',
      dtype: 'q8',
      prefix: 'bge',
      modelFile: '',
      expectedSizeMB: 330,
    },
  ])
})
