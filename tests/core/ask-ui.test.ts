import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('ask side panel ui contract', () => {
  // Scenario: 사용자가 질문 모드를 눌러도 UI가 검색 메시지만 보내면 답변 기능을 쓸 수 없다.
  // Coverage: ⚠️ mock - Chrome side panel은 브라우저 전용이라 소스 계약으로 메시지 모양을 고정한다.
  test('SearchTab exposes ask mode and sends the ask message', () => {
    const source = readFileSync('src/ui/sidepanel/SearchTab.tsx', 'utf8')

    expect(source).toContain("useState<'search' | 'ask'>('search')")
    expect(source).toContain("mode === 'ask'")
    expect(source).toContain("type: 'ask'")
    expect(source).toContain('retrieveK: 12')
    expect(source).toContain('contextK: 8')
    expect(source).toContain('res.type === \'asked\'')
  })
})
