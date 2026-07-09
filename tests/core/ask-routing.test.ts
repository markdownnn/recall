import { readFileSync } from 'node:fs'

// Scenario: side panel에서 Ask 메시지를 보내도 background가 offscreen으로 넘기지 않으면 답변이 오지 않는다.
// Coverage: ⚠️ mock - Chrome service worker real path는 Vitest에서 직접 실행하기 어렵기 때문에 라우터 소스를 확인한다.
test('background routes ask messages to offscreen', () => {
  const messaging = readFileSync('src/messaging.ts', 'utf8')
  const background = readFileSync('src/background/index.ts', 'utf8')

  expect(messaging).toContain("{ type: 'ask'; text: string; retrieveK: number; contextK: number }")
  expect(messaging).toContain("{ type: 'ask-stream'; requestId: string; text: string; retrieveK: number; contextK: number }")
  expect(messaging).toContain("{ type: 'asked'; answer: AskAnswer }")
  expect(messaging).toContain("type: 'ask-answer-delta'")
  expect(messaging).toContain("type: 'ask-answer-done'")
  expect(messaging).toContain("type: 'ask-answer-queries'")
  expect(background).toContain("msg.type !== 'ask'")
  expect(background).toContain("msg.type !== 'ask-stream'")
  expect(background).toContain("op: 'ask'")
  expect(background).toContain("op: 'ask-stream'")
  expect(background).toContain("type: 'ask-answer-queries'")
  expect(background).toContain("sendResponse({ type: 'asked', answer: r.answer }")
})

// Scenario: offscreen이 AskService를 만들지 않으면 검색된 Chunk를 답변으로 바꿀 수 없다.
// Coverage: ⚠️ mock - offscreen document는 Chrome 전용이라 여기서는 라우터 소스를 확인한다.
test('offscreen handles ask op with the core AskService', () => {
  const offscreen = readFileSync('src/offscreen/offscreen.ts', 'utf8')

  expect(offscreen).toContain("import { AskService } from '../core/ask-service'")
  expect(offscreen).toContain("import { WebLlmAnswerGenerator, createLlamaAskEngine } from './webllm-answer-generator'")
  expect(offscreen).toContain('function getAnswerGenerator()')
  expect(offscreen).toContain("if (op === 'ask')")
  expect(offscreen).toContain("if (op === 'ask-stream')")
  expect(offscreen).toContain('await getAnswerGenerator()')
  expect(offscreen).toContain('await ask.ask({ text, retrieveK, contextK })')
  expect(offscreen).toContain('await ask.askStream(')
  expect(offscreen).toContain("kind: 'ask-answer-queries'")
})
