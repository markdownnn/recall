import { cosineSimilarity } from '../../src/core/cosine'

test('identical direction scores 1', () => {
  const a = new Float32Array([1, 0, 0])
  const b = new Float32Array([2, 0, 0])
  expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5)
})

test('orthogonal scores 0', () => {
  const a = new Float32Array([1, 0])
  const b = new Float32Array([0, 1])
  expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5)
})

test('opposite direction scores -1', () => {
  const a = new Float32Array([1, 0])
  const b = new Float32Array([-1, 0])
  expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5)
})

test('zero vector scores 0 (no divide by zero)', () => {
  const a = new Float32Array([0, 0])
  const b = new Float32Array([1, 0])
  expect(cosineSimilarity(a, b)).toBe(0)
})
