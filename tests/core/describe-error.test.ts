import { describeError } from '../../src/core/describe-error'

// Scenario: WebLLM 로드 실패는 message 없는 객체로 던져질 때가 있어, String(err)이 "[object Object]"가
// 되면 사용자와 개발자가 진짜 원인을 못 본다. describeError는 어떤 형태의 에러든 읽을 수 있는 문자열로 푼다.
// Coverage: ✅ integration (순수 함수).
test('returns the string as-is', () => {
  expect(describeError('boom')).toBe('boom')
})

test('uses Error.message for Error instances', () => {
  expect(describeError(new Error('bad thing'))).toBe('bad thing')
})

test('uses .message when present on a plain object', () => {
  expect(describeError({ message: 'oops', code: 5 })).toBe('oops')
})

test('serializes a message-less object to JSON so its shape is visible (not [object Object])', () => {
  expect(describeError({ code: 42, detail: 'window' })).toBe('{"code":42,"detail":"window"}')
  expect(describeError({ code: 42 })).not.toBe('[object Object]')
})

test('falls back to a readable label for null/undefined', () => {
  expect(describeError(null)).toBe('Unknown error')
  expect(describeError(undefined)).toBe('Unknown error')
})

test('handles a circular object without throwing', () => {
  const a: Record<string, unknown> = { name: 'x' }
  a.self = a
  const out = describeError(a)
  expect(typeof out).toBe('string')
  expect(out.length).toBeGreaterThan(0)
})
