import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('ask side panel ui contract', () => {
  // Scenario: BGE 모델이 아직 다운로드/로딩 중인데 저장을 누르면 저장은 됐지만 검색은 안 되는 헷갈린 상태가 된다.
  // Coverage: ⚠️ mock - Chrome side panel은 브라우저 전용이라 컴포넌트 소스 계약으로 버튼 비활성화를 고정한다.
  test('capture is disabled while the search model is loading', () => {
    const sidePanel = readFileSync('src/ui/sidepanel/SidePanel.tsx', 'utf8')
    const thisPageBar = readFileSync('src/ui/sidepanel/ThisPageBar.tsx', 'utf8')

    expect(sidePanel).toContain('<ThisPageBar onCapture={capture} refreshSignal={savedRefresh} modelStatus={modelStatus} />')
    expect(thisPageBar).toContain("modelStatus.state === 'loading'")
    expect(thisPageBar).toContain('t.loadingSearchModel')
    expect(thisPageBar).toContain('modelLoading')
  })

  // Scenario: Ask가 Search 안의 작은 스위치에 숨어 있으면 사용자가 기능이 없는 줄 안다.
  // Coverage: ⚠️ mock - Chrome side panel은 브라우저 전용이라 탭 소스 계약으로 보이는 위치를 고정한다.
  test('Ask is a top-level side panel tab', () => {
    const tabs = readFileSync('src/ui/sidepanel/Tabs.tsx', 'utf8')
    const sidePanel = readFileSync('src/ui/sidepanel/SidePanel.tsx', 'utf8')

    expect(tabs).toContain("export type TabKey = 'search' | 'ask' | 'history' | 'settings'")
    expect(tabs).toContain("{ key: 'ask', label: t.askModeLabel }")
    expect(sidePanel).toContain("tab === 'ask' && (")
    expect(sidePanel).toContain('askModelStatus={askModelStatus}')
    expect(sidePanel).toContain('onPrepareAskModel={prepareAskModel}')
  })

  // Scenario: 사용자가 질문 모드를 눌러도 UI가 검색 메시지만 보내면 답변 기능을 쓸 수 없다.
  // Coverage: ⚠️ mock - Chrome side panel은 브라우저 전용이라 소스 계약으로 메시지 모양을 고정한다.
  test('SearchTab exposes ask mode and sends the ask message', () => {
    const source = readFileSync('src/ui/sidepanel/SearchTab.tsx', 'utf8')

    expect(source).toContain("initialMode?: 'search' | 'ask'")
    expect(source).toContain("mode === 'ask'")
    expect(source).toContain("type: 'ask-stream'")
    expect(source).toContain('crypto.randomUUID()')
    expect(source).toContain("msg.type === 'ask-answer-delta'")
    expect(source).toContain("msg.type === 'ask-answer-done'")
    expect(source).toContain('retrieveK: 12')
    expect(source).toContain('contextK: 8')
    expect(source).toContain('setAnswer(null)')
    expect(source).toContain('!answer?.text')
    expect(source).toContain('class="answerloader"')
  })

  // Scenario: WebLLM이 아직 없는데 Ask를 누르면 첫 질문이 긴 다운로드처럼 보여 사용자가 고장으로 느낀다.
  // Coverage: ⚠️ mock - Chrome side panel은 브라우저 전용이라 Ask 탭 소스 계약으로 ready 전 비활성화를 고정한다.
  test('Ask tab requires an explicit WebLLM download before asking', () => {
    const source = readFileSync('src/ui/sidepanel/SearchTab.tsx', 'utf8')
    const messaging = readFileSync('src/messaging.ts', 'utf8')

    expect(source).toContain('askModelStatus.state === \'ready\'')
    expect(source).toContain('onPrepareAskModel')
    expect(source).toContain('t.downloadWebLlm')
    expect(source).toContain('disabled={mode === \'ask\' && !askReady}')
    expect(messaging).toContain("{ type: 'prepare-ask-model' }")
    expect(messaging).toContain("{ type: 'ask-model-status' }")
  })

  // Scenario: WebLLM이 이미 준비됐는데 왼쪽에도 "ready"가 보이면 같은 말이 두 번 보여 헷갈린다.
  // Coverage: ⚠️ mock - Chrome side panel은 브라우저 전용이라 컴포넌트 소스 계약으로 버튼 표시 조건을 고정한다.
  test('WebLLM download button only renders while downloadable', () => {
    const source = readFileSync('src/ui/sidepanel/SearchTab.tsx', 'utf8')

    expect(source).toContain("askModelStatus.state === 'not-loaded' || askModelStatus.state === 'error'")
    expect(source).toContain('askModelDownloadable && (')
    expect(source).not.toContain('askReady ? t.webLlmReady : t.downloadWebLlm')
  })

  // Scenario: 저장된 페이지 URL처럼 긴 글자가 답변 카드 밖으로 삐져나오면 Ask 화면을 읽을 수 없다.
  // Coverage: ⚠️ mock - CSS 렌더링은 브라우저 전용이라 답변 영역 줄바꿈 규칙을 소스 계약으로 고정한다.
  test('Ask answer text wraps long strings inside the card', () => {
    const css = readFileSync('src/ui/sidepanel/sidepanel.css', 'utf8')

    expect(css).toContain('overflow-wrap: anywhere')
    expect(css).toContain('word-break: break-word')
    expect(css).toContain('.answersources > a')
  })

  // Scenario: 첫 토큰이 오기 전 빈 답변 카드가 보이면 얇은 빈 박스처럼 보여 어색하다.
  // Coverage: ⚠️ mock - Chrome side panel 렌더링은 브라우저 전용이라 CSS/컴포넌트 소스 계약으로 로딩 모양을 고정한다.
  test('Ask waits with a visual loader before rendering the answer card', () => {
    const source = readFileSync('src/ui/sidepanel/SearchTab.tsx', 'utf8')
    const css = readFileSync('src/ui/sidepanel/sidepanel.css', 'utf8')

    expect(source).toContain("searching && mode === 'ask' && !answer?.text")
    expect(source).toContain('aria-label={t.answering}')
    expect(source).toContain('answerloader-dot')
    expect(source).not.toContain("setAnswer({ text: '', sources: [] })")
    expect(css).toContain('.answerloader')
    expect(css).toContain('@keyframes answerloader-pulse')
  })

  // Scenario: query expansion이 성공했을 때 사용자는 Recall이 어떤 검색어들을 함께 시도했는지 확인할 수 있어야 한다.
  // Coverage: ⚠️ mock - Chrome side panel 렌더링은 브라우저 전용이라 메시지 처리와 CSS 소스 계약으로 고정한다.
  test('Ask shows expanded query chips only after successful expansion', () => {
    const source = readFileSync('src/ui/sidepanel/SearchTab.tsx', 'utf8')
    const css = readFileSync('src/ui/sidepanel/sidepanel.css', 'utf8')

    expect(source).toContain('AskAnswerQueriesMsg')
    expect(source).toContain("msg.type === 'ask-answer-queries'")
    expect(source).toContain('setExpandedQueries(msg.queries)')
    expect(source).toContain('setExpandedQueries([])')
    expect(source).toContain('expandedQueries.length > 1')
    expect(source).toContain('class="querychips"')
    expect(source).toContain('t.triedSearches')
    expect(css).toContain('.querychips')
    expect(css).toContain('.querychip')
  })
})
