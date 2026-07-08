import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Scenario: 영어 전용 제품에서 한국어 locale 파일이 다시 들어오면 방향이 흔들린다.
// Coverage: ✅ integration
test('extension ships english locale only', () => {
  expect(existsSync(resolve('public/_locales/en/messages.json'))).toBe(true)
  expect(existsSync(resolve('public/_locales/ko/messages.json'))).toBe(false)
})

// Scenario: 영어 전용 제품에서 한국어 메시지 테스트가 남으면 새 방향과 반대로 움직인다.
// Coverage: ✅ integration
test('korean message tests are removed from the source tree', () => {
  expect(existsSync(resolve('tests/core/messages-ko.test.ts'))).toBe(false)
  expect(existsSync(resolve('tests/core/messages-ko-render.test.ts'))).toBe(false)
})
