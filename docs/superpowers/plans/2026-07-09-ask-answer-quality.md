# Ask 답변 품질 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask(질문에 답하는 기능)가 지금 세 군데서 사실과 다른 걸 사용자에게 보여주는 문제를 고친다 — 가짜 출처(검색 상위 3개를 무조건 근거라고 표시), 서로 뜻이 같은 확장 검색어(검색이 헛돎), 근거가 약해도 무조건 답변(환각 위험). 그리고 이 세 가지가 고쳐졌는지 숫자로 재는 평가 하네스를 새로 만든다.

**Architecture:** 모델이 답변 끝에 화면엔 안 보이는 숨김 인용 태그(`[[cite: 1, 3]]`, 발췌 순번)를 달게 하고 그 태그만 파싱해 출처로 쓴다(태그 없으면 출처는 비움, 상위 N개로 대체하지 않음). 확장 검색어는 임베딩 후 코사인 유사도로 의미 중복을 제거한다. 검색 결과 병합 후 1등 점수가 문턱 아래면 LLM 호출 없이 바로 "못 찾음"을 반환한다. 새 로직은 전부 `src/core/`의 순수 함수로 만들어 브라우저·모델 없이 단위테스트하고, `eval/run-ask.mjs`가 생성(LLM) 직전까지의 파이프라인을 실제 코드로 돌려 숫자를 낸다.

**Tech Stack:** TypeScript, Vitest, vite-node(eval 스크립트), 기존 `@huggingface/transformers` 기반 임베딩 하네스 재사용.

**설계 근거:** [2026-07-09-ask-answer-quality-design.md](../specs/2026-07-09-ask-answer-quality-design.md), [ADR 0024](../../adr/0024-ask-shows-only-verified-grounding.md)

---

## 사전 확인 사항 (구현 중 놓치기 쉬운 것들)

이 계획을 쓰면서 스펙 문서 작성 시점엔 안 보였던 문제 세 가지를 코드로 직접 확인했다. 각 Task에 반영돼 있지만 한눈에 보이게 여기 모아둔다.

1. **`NOT_FOUND` 문구가 두 파일에 따로 박혀 있다.** `src/core/ask-service.ts:6`의 `NOT_FOUND`와 `src/offscreen/webllm-answer-generator.ts:18`의 `NOT_FOUND_ANSWER`가 지금은 우연히 같은 문자열이다. 새로 만드는 `parseAnswerCitation`이 이 문구와 비교해야 하므로, Task 1에서 하나로 합친다.
2. **기존 테스트의 공용 `embedder` fake가 여러 검색어를 구분 못 한다.** `tests/core/ask-service.test.ts`의 `embedder` 상수는 입력 텍스트 개수와 무관하게 항상 벡터 1개만 반환한다(`embed: async () => [new Float32Array([1, 0])]`). 지금까지는 문제없었는데(대부분 테스트가 검색어 1개만 씀), 확장 검색어 중복 제거 로직이 들어가면 벡터가 없는 검색어에서 크래시가 난다. Task 6에서 이 fake를 검색어 인덱스별로 다른 벡터를 주도록 고친다.
3. **기존 인용 관련 테스트 4개가 새 태그 형식과 안 맞는다.** `tests/core/webllm-answer-generator.test.ts`의 `answer returns model text without parser cleanup`, `answer can omit source lines and still uses retrieved chunks as sources`, `answer does not retry when the first draft looks like a raw source snippet`, `answerStream emits deltas as WebLLM chunks arrive`, 이 넷 다 옛 방식(항상 상위 3개, 또는 옛 `[p1#0]` 브래킷 형식)을 전제로 값을 기대한다. Task 5에서 넷 다 새 태그 형식(`[[cite: N]]`)에 맞게 다시 쓴다.

---

## Task 1: `NOT_FOUND_ANSWER`를 `src/core/answer-generator.ts`로 통합

**Files:**
- Modify: `src/core/answer-generator.ts`
- Modify: `src/core/ask-service.ts:6`
- Modify: `src/offscreen/webllm-answer-generator.ts:18`

- [ ] **Step 1: `src/core/answer-generator.ts`에 `NOT_FOUND_ANSWER` 추가**

파일 끝에 추가:

```ts
export const NOT_FOUND_ANSWER = "I couldn't find that in your saved pages."
```

- [ ] **Step 2: `ask-service.ts`가 로컬 상수 대신 이걸 가져다 쓰도록 수정**

`src/core/ask-service.ts` 상단 import를 찾는다:

```ts
import type { AnswerGeneratorPort, AskProgressEvent } from './answer-generator'
import { DEFAULT_ANSWER_RETRIEVAL_OPTIONS, type AnswerRetrievalOptions } from './answer-retrieval'
import type { AskAnswer, AskQuery, RankedResult } from './model'
import type { EmbeddingPort, VectorSearchPort } from './ports'

const NOT_FOUND = "I couldn't find that in your saved pages."
const MAX_ASK_SEARCH_QUERIES = 5
```

다음으로 교체:

```ts
import { NOT_FOUND_ANSWER, type AnswerGeneratorPort, type AskProgressEvent } from './answer-generator'
import { DEFAULT_ANSWER_RETRIEVAL_OPTIONS, type AnswerRetrievalOptions } from './answer-retrieval'
import type { AskAnswer, AskQuery, RankedResult } from './model'
import type { EmbeddingPort, VectorSearchPort } from './ports'

const MAX_ASK_SEARCH_QUERIES = 5
```

파일 안에서 `NOT_FOUND` (밑줄 뒤 `_ANSWER` 없는 버전)를 쓰는 곳을 전부 `NOT_FOUND_ANSWER`로 바꾼다. 지금은 한 곳뿐이다:

```ts
    if (retrieved.length === 0) return { text: NOT_FOUND, sources: [] }
```

다음으로 교체:

```ts
    if (retrieved.length === 0) return { text: NOT_FOUND_ANSWER, sources: [] }
```

- [ ] **Step 3: `webllm-answer-generator.ts`가 로컬 export 대신 이걸 가져다 쓰도록 수정**

`src/offscreen/webllm-answer-generator.ts` 상단에서:

```ts
import type {
  AppConfig,
  ChatCompletionMessageParam,
  InitProgressReport,
  MLCEngineInterface,
} from '@mlc-ai/web-llm'
import type { AnswerDraft, AnswerGeneratorPort, AnswerRequest } from '../core/answer-generator'
import type { RankedResult } from '../core/model'
import { modelCdnUrl } from '../core/model-cdn'
```

다음으로 교체:

```ts
import type {
  AppConfig,
  ChatCompletionMessageParam,
  InitProgressReport,
  MLCEngineInterface,
} from '@mlc-ai/web-llm'
import { NOT_FOUND_ANSWER, type AnswerDraft, type AnswerGeneratorPort, type AnswerRequest } from '../core/answer-generator'
import type { RankedResult } from '../core/model'
import { modelCdnUrl } from '../core/model-cdn'
```

그 다음, 로컬로 정의됐던 줄을 찾아 지운다:

```ts
export const NOT_FOUND_ANSWER = "I couldn't find that in your saved pages."
```

이 줄은 완전히 삭제한다(더 이상 이 파일이 정의하지 않고, import한 걸 그대로 쓴다). 파일 안의 다른 `NOT_FOUND_ANSWER` 사용처(프롬프트 문구, `answer`/`answerStream`의 폴백)는 코드가 그대로라 손댈 필요 없다 — import만 바뀌었을 뿐 이름은 동일하다.

- [ ] **Step 4: 아무것도 안 깨졌는지 확인**

Run: `npx vitest run tests/core/ask-service.test.ts tests/core/webllm-answer-generator.test.ts`
Expected: 기존 테스트 전부 PASS (이 태스크는 상수 위치만 옮겼을 뿐 동작은 그대로다).

- [ ] **Step 5: Commit**

```bash
git add src/core/answer-generator.ts src/core/ask-service.ts src/offscreen/webllm-answer-generator.ts
git commit -m "refactor: consolidate NOT_FOUND_ANSWER into core/answer-generator

Two files independently defined the same not-found sentence. The new
citation parser needs to compare against it, so it must be a single
source of truth instead of two copies that could silently drift apart."
```

---

## Task 2: `src/core/answer-citation.ts` — 인용 태그 파싱 (TDD)

**Files:**
- Create: `src/core/answer-citation.ts`
- Test: `tests/core/answer-citation.test.ts`

- [ ] **Step 1: 실패하는 테스트부터 작성**

Create `tests/core/answer-citation.test.ts`:

```ts
import { expect, test } from 'vitest'
import { parseAnswerCitation } from '../../src/core/answer-citation'
import { NOT_FOUND_ANSWER } from '../../src/core/answer-generator'
import type { CapturedPage, RankedResult } from '../../src/core/model'

const page: CapturedPage = { id: 'p1', url: 'https://example.com/sleep', title: 'Sleep', capturedAt: 1 }
const result = (id: string, text: string): RankedResult => ({
  chunk: { id, pageId: 'p1', index: Number(id.split('#')[1]), text },
  page,
  score: 1,
})
const chunks: RankedResult[] = [
  result('p1#0', 'Cortisol can disrupt REM sleep.'),
  result('p1#1', 'Caffeine blocks adenosine receptors.'),
  result('p1#2', 'Blue light suppresses melatonin.'),
]

// Scenario: 모델이 형식을 정확히 지켜 여러 발췌를 인용하면, 그 발췌들의 청크 id가 그대로 출처가 돼야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation resolves cited excerpt numbers to chunk ids', () => {
  const raw = 'Cortisol and blue light both disrupt sleep.\n[[cite: 1, 3]]'
  const { displayText, citedChunkIds } = parseAnswerCitation(raw, chunks)

  expect(displayText).toBe('Cortisol and blue light both disrupt sleep.')
  expect(citedChunkIds).toEqual(['p1#0', 'p1#2'])
})

// Scenario: 모델이 범위 밖 번호나 중복 번호를 섞어도, 유효한 것만 걸러써야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation drops out-of-range and duplicate excerpt numbers', () => {
  const raw = 'Cortisol disrupts sleep.\n[[cite: 1, 1, 9]]'
  const { citedChunkIds } = parseAnswerCitation(raw, chunks)

  expect(citedChunkIds).toEqual(['p1#0'])
})

// Scenario: 모델이 태그를 아예 안 달면, 상위 청크로 대신 채우지 말고 출처를 비워야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation returns no sources when the model omits the tag', () => {
  const raw = 'Cortisol disrupts sleep.'
  const { displayText, citedChunkIds } = parseAnswerCitation(raw, chunks)

  expect(displayText).toBe('Cortisol disrupts sleep.')
  expect(citedChunkIds).toEqual([])
})

// Scenario: 태그 안에 유효한 번호가 하나도 없으면 출처를 비워야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation returns no sources when every tagged number is invalid', () => {
  const raw = 'Cortisol disrupts sleep.\n[[cite: 0, 99]]'
  const { citedChunkIds } = parseAnswerCitation(raw, chunks)

  expect(citedChunkIds).toEqual([])
})

// Scenario: 답변이 "저장된 자료에서 못 찾았다"는 고정 문구면, 태그가 있어도 출처를 강제로 비워야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation forces no sources when the answer is the not-found sentence', () => {
  const raw = `${NOT_FOUND_ANSWER}\n[[cite: 1]]`
  const { displayText, citedChunkIds } = parseAnswerCitation(raw, chunks)

  expect(displayText).toBe(NOT_FOUND_ANSWER)
  expect(citedChunkIds).toEqual([])
})

// Scenario: 화면에 보이는 텍스트에서 태그 줄이 깔끔히 잘려나가야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation strips the citation tag from the displayed text', () => {
  const raw = 'Cortisol disrupts sleep.\n[[cite: 1]]'
  const { displayText } = parseAnswerCitation(raw, chunks)

  expect(displayText).not.toContain('[[cite:')
})

// Scenario: 청크가 하나뿐이면 태그 없이도(과거 동작과 달리) 여전히 출처가 비어야 한다 — 청크 1개 상황에서
// "태그 파싱"과 "무조건 상위 N개"가 우연히 같은 값을 내던 예전 사각지대를 이 테스트가 명시적으로 막는다.
// Coverage: ✅ integration
test('parseAnswerCitation does not fall back to the only chunk when no tag is present', () => {
  const single = [chunks[0]]
  const { citedChunkIds } = parseAnswerCitation('Cortisol disrupts sleep.', single)

  expect(citedChunkIds).toEqual([])
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run tests/core/answer-citation.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/answer-citation'`

- [ ] **Step 3: 최소 구현 작성**

Create `src/core/answer-citation.ts`:

```ts
import type { RankedResult } from './model'
import { NOT_FOUND_ANSWER } from './answer-generator'

// Trailing hidden marker the model appends to point at which numbered excerpt(s) it used.
// Anchored to the END of the text (no /m flag) so it only matches the final line, not any
// "[[cite: ...]]"-shaped text that might appear mid-answer for some other reason.
const CITATION_TAG_PATTERN = /\n?\[\[cite:\s*([0-9,\s]+)\]\]\s*$/i

export interface ParsedCitation {
  displayText: string
  citedChunkIds: string[]
}

// Parses the model's raw answer into what the user should see (displayText, tag stripped)
// and which chunks it actually cited (citedChunkIds). No fallback: a missing or fully-invalid
// tag means citedChunkIds is empty rather than guessing at the top chunks (ADR 0024).
export function parseAnswerCitation(rawText: string, chunks: RankedResult[]): ParsedCitation {
  const match = rawText.match(CITATION_TAG_PATTERN)
  const displayText = match ? rawText.slice(0, match.index).trimEnd() : rawText

  if (displayText.trim() === NOT_FOUND_ANSWER) {
    return { displayText, citedChunkIds: [] }
  }
  if (!match) {
    return { displayText, citedChunkIds: [] }
  }

  const seen = new Set<number>()
  const citedChunkIds: string[] = []
  for (const raw of match[1].split(',')) {
    const n = Number(raw.trim())
    if (!Number.isInteger(n) || n < 1 || n > chunks.length) continue
    if (seen.has(n)) continue
    seen.add(n)
    citedChunkIds.push(chunks[n - 1].chunk.id)
  }
  return { displayText, citedChunkIds }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run tests/core/answer-citation.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/answer-citation.ts tests/core/answer-citation.test.ts
git commit -m "feat: add parseAnswerCitation for tag-based Ask source attribution

Pure function that resolves a model's hidden [[cite: N, N]] marker to real
chunk ids, with no top-N fallback when the tag is missing or invalid
(ADR 0024: show nothing over guessing)."
```

---

## Task 3: `src/core/query-dedup.ts` — 임베딩 기반 확장 검색어 중복 제거 (TDD)

**Files:**
- Create: `src/core/query-dedup.ts`
- Test: `tests/core/query-dedup.test.ts`

- [ ] **Step 1: 실패하는 테스트부터 작성**

Create `tests/core/query-dedup.test.ts`:

```ts
import { expect, test } from 'vitest'
import { dedupeSimilarQueries } from '../../src/core/query-dedup'

// Scenario: 코사인이 문턱 이상인 두 검색어가 있으면, 뒤에 나온 쪽을 버려야 한다.
// Coverage: ✅ integration
test('dedupeSimilarQueries drops a later query too similar to an earlier one', () => {
  const items = [
    { text: 'who invented rnn', vector: new Float32Array([1, 0]) },
    { text: 'who is the inventor of rnn', vector: new Float32Array([0.99, Math.sqrt(1 - 0.99 * 0.99)]) },
  ]

  const kept = dedupeSimilarQueries(items, 0.92)

  expect(kept.map((k) => k.text)).toEqual(['who invented rnn'])
})

// Scenario: 원본 질문(항상 첫 항목)은 절대 버리지 않아야 한다.
// Coverage: ✅ integration
test('dedupeSimilarQueries always keeps the first item', () => {
  const items = [{ text: 'only query', vector: new Float32Array([1, 0]) }]

  const kept = dedupeSimilarQueries(items, 0.92)

  expect(kept).toEqual(items)
})

// Scenario: 서로 충분히 다른 검색어들은 전부 살아남아야 한다.
// Coverage: ✅ integration
test('dedupeSimilarQueries keeps queries below the similarity threshold', () => {
  const items = [
    { text: 'rnn history', vector: new Float32Array([1, 0]) },
    { text: 'lstm inventors', vector: new Float32Array([0, 1]) },
  ]

  const kept = dedupeSimilarQueries(items, 0.92)

  expect(kept.map((k) => k.text)).toEqual(['rnn history', 'lstm inventors'])
})

// Scenario: 세 번째 검색어가 첫 번째와만 겹치고 두 번째와는 안 겹쳐도, 이미 채택된 어느 하나와
// 겹치면 버려야 한다(비교 대상은 "채택된 목록 전체", "직전 항목"이 아님).
// Coverage: ✅ integration
test('dedupeSimilarQueries compares against every already-kept item, not just the previous one', () => {
  const items = [
    { text: 'rnn history', vector: new Float32Array([1, 0]) },
    { text: 'lstm inventors', vector: new Float32Array([0, 1]) },
    { text: 'rnn origin story', vector: new Float32Array([0.99, Math.sqrt(1 - 0.99 * 0.99)]) },
  ]

  const kept = dedupeSimilarQueries(items, 0.92)

  expect(kept.map((k) => k.text)).toEqual(['rnn history', 'lstm inventors'])
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run tests/core/query-dedup.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/query-dedup'`

- [ ] **Step 3: 최소 구현 작성**

Create `src/core/query-dedup.ts`:

```ts
import { cosineSimilarity } from './cosine'

export interface EmbeddedQuery {
  text: string
  vector: Float32Array
}

// Keeps the first item unconditionally (the original question), then drops any later item
// whose cosine similarity to ANY already-kept item is at or above the threshold. This is the
// safety net for query expansion: an LLM that reworded the same question instead of finding a
// different angle should not waste a search pass.
export function dedupeSimilarQueries(items: EmbeddedQuery[], threshold: number): EmbeddedQuery[] {
  const kept: EmbeddedQuery[] = []
  for (const item of items) {
    const isDuplicate = kept.some((k) => cosineSimilarity(item.vector, k.vector) >= threshold)
    if (!isDuplicate) kept.push(item)
  }
  return kept
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run tests/core/query-dedup.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/query-dedup.ts tests/core/query-dedup.test.ts
git commit -m "feat: add dedupeSimilarQueries for Ask query expansion diversity

Embedding-based safety net: drops expanded search queries that are
semantically near-duplicates of one already kept, regardless of the
LLM's wording."
```

---

## Task 4: `src/core/eval-metrics.ts` — Ask 하네스용 신규 지표 (TDD)

**Files:**
- Modify: `src/core/eval-metrics.ts`
- Modify: `tests/core/eval-metrics.test.ts`

- [ ] **Step 1: 실패하는 테스트부터 작성**

`tests/core/eval-metrics.test.ts` 맨 위 import를 찾는다:

```ts
import {
  precisionAt1,
  recallAtK,
  mrr,
  referenceSnippetRate,
  aggregate,
} from '../../src/core/eval-metrics'
```

다음으로 교체:

```ts
import {
  precisionAt1,
  recallAtK,
  mrr,
  referenceSnippetRate,
  aggregate,
  evidenceRecallAtContext,
  confidenceGateCorrect,
} from '../../src/core/eval-metrics'
```

파일 끝에 추가:

```ts

// Scenario: Ask가 LLM에 넘기는 최종 문맥 안에 정답 페이지의 청크가 있는가.
// Coverage: integration (pure arithmetic).
test('evidenceRecallAtContext is 1 when any context chunk belongs to an expected page', () => {
  expect(evidenceRecallAtContext(['p1', 'p2'], ['p2'])).toBe(1)
  expect(evidenceRecallAtContext(['p1', 'p2'], ['p3'])).toBe(0)
  expect(evidenceRecallAtContext([], ['p1'])).toBe(0)
})

// Scenario: 저신뢰 게이트의 판정이 실제로 "답 가능/불가능" 기대와 일치하는가.
// Coverage: integration (pure arithmetic).
test('confidenceGateCorrect compares the gate decision against expectAnswerable', () => {
  expect(confidenceGateCorrect(true, true)).toBe(1)
  expect(confidenceGateCorrect(false, false)).toBe(1)
  expect(confidenceGateCorrect(true, false)).toBe(0)
  expect(confidenceGateCorrect(false, true)).toBe(0)
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run tests/core/eval-metrics.test.ts`
Expected: FAIL — `evidenceRecallAtContext is not a function` (또는 동일 취지의 import 오류)

- [ ] **Step 3: 구현 추가**

`src/core/eval-metrics.ts` 파일 끝에 추가:

```ts

// Ask-quality harness metrics (docs/superpowers/specs/2026-07-09-ask-answer-quality-design.md).
// Ground truth is PAGE-level, matching the existing golden-set convention (see CONTEXT.md's
// "Golden set" entry) — chunk ids shift whenever chunking changes, pages do not.

// Whether the final context handed to the answer model contains any chunk from an expected
// page. Catches "search found the right page but truncating to N context chunks dropped it."
export function evidenceRecallAtContext(contextPageIds: string[], expectedPageIds: string[]): number {
  return contextPageIds.some((id) => expectedPageIds.includes(id)) ? 1 : 0
}

// Whether the confidence gate's pass/block decision matches the golden set's expectation.
export function confidenceGateCorrect(passesGate: boolean, expectAnswerable: boolean): number {
  return passesGate === expectAnswerable ? 1 : 0
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run tests/core/eval-metrics.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/eval-metrics.ts tests/core/eval-metrics.test.ts
git commit -m "feat: add evidenceRecallAtContext and confidenceGateCorrect metrics

New page-level metrics for the upcoming Ask eval harness (eval/run-ask.mjs)."
```

---

## Task 5: `webllm-answer-generator.ts` — 프롬프트 재작성 + 인용 태그 배선

**Files:**
- Modify: `src/offscreen/webllm-answer-generator.ts`
- Modify: `tests/core/webllm-answer-generator.test.ts`

이 태스크는 세 가지를 한 번에 건드린다: (1) 발췌 번호 매기기, (2) 인용 태그 지시 추가, (3) 확장 검색어 다양화 지시. 순서대로 진행한다.

### 5a. 발췌 번호 매기기 (`formatSavedExcerpts`)

- [ ] **Step 1: 기존 관련 테스트가 여전히 통과하는지 먼저 확인 (베이스라인)**

Run: `npx vitest run tests/core/webllm-answer-generator.test.ts`
Expected: 전부 PASS (아직 아무것도 안 고쳤으므로)

- [ ] **Step 2: `formatSavedExcerpts`에 번호 매기기 추가**

`src/offscreen/webllm-answer-generator.ts`에서 찾는다:

```ts
function formatSavedExcerpts(chunks: RankedResult[], maxChunks: number): string {
  return chunks
    .slice(0, maxChunks)
    .map((r) => `Page title: ${r.page.title}\nSaved text: ${promptSafeChunkText(r.chunk.text)}`)
    .join('\n\n')
}
```

다음으로 교체:

```ts
function formatSavedExcerpts(chunks: RankedResult[], maxChunks: number): string {
  return chunks
    .slice(0, maxChunks)
    .map((r, i) => `Excerpt ${i + 1})\nPage title: ${r.page.title}\nSaved text: ${promptSafeChunkText(r.chunk.text)}`)
    .join('\n\n')
}
```

- [ ] **Step 3: 번호가 실제로 프롬프트에 나오는지 새 테스트로 확인**

`tests/core/webllm-answer-generator.test.ts`의 `describe('webllm answer generator', () => {` 블록 안, 첫 번째 test 앞에 추가:

```ts
  // Scenario: 인용 태그가 청크를 정확히 가리키려면 프롬프트에서 발췌마다 번호가 보여야 한다.
  // Coverage: ✅ integration
  test('ask prompt numbers each excerpt so the model can cite by number', () => {
    const second: RankedResult = {
      chunk: { id: 'p2#0', pageId: 'p2', index: 0, text: 'Caffeine blocks adenosine receptors.' },
      page: { id: 'p2', url: 'https://example.com/caffeine', title: 'Caffeine article', capturedAt: 1 },
      score: 1,
    }
    const messages = buildAskMessages('what hurts sleep?', [result, second])
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).toContain('Excerpt 1)')
    expect(joined).toContain('Excerpt 2)')
  })

```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run tests/core/webllm-answer-generator.test.ts`
Expected: PASS. `prompt builders cap chunk count and chunk text length before calling WebLLM` 테스트도 여전히 PASS해야 한다(그 테스트는 `Page title: Long page` 등장 횟수만 세므로 번호 추가는 영향 없음).

### 5b. 인용 태그 지시 추가 (`buildAskMessages`)

- [ ] **Step 5: 시스템 프롬프트에 태그 지시 추가**

`src/offscreen/webllm-answer-generator.ts`에서 찾는다:

```ts
          'Do not write audit sections like "what is provided", "what is missing", or "this saved chunk supports".',
          'Do not include a sources section; Recall shows sources below the answer.',
          notes ? 'Use the working notes as a relevance guide, but the saved excerpts are the source of truth. Do not mention the working notes.' : '',
        ].join(' '),
```

다음으로 교체:

```ts
          'Do not write audit sections like "what is provided", "what is missing", or "this saved chunk supports".',
          'Do not include a sources section; Recall shows sources below the answer.',
          'After your answer, on a new line, add the excerpt numbers you actually used like this: [[cite: 1, 3]] using the numbers shown below. This line is hidden from the user and does not count as a visible sources section. If you cannot answer from the excerpts, do not add this line.',
          notes ? 'Use the working notes as a relevance guide, but the saved excerpts are the source of truth. Do not mention the working notes.' : '',
        ].join(' '),
```

- [ ] **Step 6: 지시가 프롬프트에 실제로 들어가는지 테스트 추가**

같은 테스트 파일, 방금 추가한 `ask prompt numbers each excerpt...` 테스트 바로 뒤에 추가:

```ts
  // Scenario: 모델이 실제로 사용한 발췌를 답 끝에 숨김 태그로 표시해야 citedChunkIds를 신뢰할 수 있다.
  // Coverage: ✅ integration
  test('ask prompt instructs the model to append a hidden citation tag', () => {
    const messages = buildAskMessages('what hurts sleep?', [result])
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).toContain('[[cite:')
    expect(joined).toContain('hidden from the user')
    expect(joined).not.toContain('Sources:')
  })

```

- [ ] **Step 7: 테스트 통과 확인**

Run: `npx vitest run tests/core/webllm-answer-generator.test.ts`
Expected: 새 테스트 2개 PASS. `ask prompt tells model to answer only from chunks` 테스트도 여전히 PASS해야 한다 (`not.toContain('Sources:')` 어서션이 있는데, 새로 추가한 문구엔 `Sources:`가 없으므로 안 깨진다).

### 5c. 확장 검색어 다양화 지시 (`buildQueryExpansionMessages`)

- [ ] **Step 8: 프롬프트를 "말 바꾸기"에서 "다른 측면 쪼개기"로 재작성**

`src/offscreen/webllm-answer-generator.ts`에서 찾는다:

```ts
export function buildQueryExpansionMessages(question: string): ChatCompletionMessageParam[] {
  return [
    {
      role: 'user',
      content:
        [
          "You rewrite a user's search query into multiple search queries to improve retrieval coverage.",
          '',
          "Given the user's question, output 3-4 alternative search queries that:",
          '- Rephrase the question using different keywords or synonyms',
          '- Break a complex question into sub-queries if needed',
          '- Include both broad and specific versions',
          '',
          'Output ONLY a JSON array of strings. No explanation, no markdown.',
          '',
          `User question: ${question}`,
        ].join('\n'),
    },
  ]
}
```

다음으로 교체:

```ts
export function buildQueryExpansionMessages(question: string): ChatCompletionMessageParam[] {
  return [
    {
      role: 'user',
      content:
        [
          "You expand a user's search query into multiple search queries to improve retrieval coverage.",
          '',
          "Given the user's question, output 3-4 alternative search queries that each explore a DIFFERENT angle, entity, or sub-topic of the question.",
          '- Do NOT just reword the same idea with synonyms. Each query should be able to surface DIFFERENT saved content than the others.',
          '- Break a complex question into distinct sub-questions if it has multiple parts.',
          '- Include both broad and specific versions.',
          '',
          'Output ONLY a JSON array of strings. No explanation, no markdown.',
          '',
          `User question: ${question}`,
        ].join('\n'),
    },
  ]
}
```

- [ ] **Step 9: 옛 문구를 확인하던 기존 테스트를 새 문구로 갱신**

`tests/core/webllm-answer-generator.test.ts`에서 찾는다:

```ts
  // Scenario: 원문 질문과 저장 글의 단어가 다르면 검색이 놓칠 수 있으므로 WebLLM이 검색용 변형 문장을 만들어야 한다.
  // Coverage: ✅ integration
  test('query expansion prompt asks for JSON search queries only', () => {
    const messages = buildQueryExpansionMessages('what is cf r2?')
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).toContain("You rewrite a user's search query into multiple search queries")
    expect(joined).toContain('output 3-4 alternative search queries')
    expect(joined).toContain('Output ONLY a JSON array of strings.')
    expect(joined).toContain('No explanation, no markdown.')
    expect(joined).toContain('User question: what is cf r2?')
    expect(joined).not.toContain('<thinking>')
    expect(joined).not.toContain('<answer>')
  })
```

다음으로 교체:

```ts
  // Scenario: 확장 검색어가 원문과 뜻만 같은 동의어면 검색이 매번 같은 결과만 낸다. WebLLM이 서로 다른
  // 측면(인물/개념/하위질문)으로 쪼개야 실제로 다른 저장 글을 찾아낼 수 있다.
  // Coverage: ✅ integration
  test('query expansion prompt asks for distinct-angle search queries as JSON', () => {
    const messages = buildQueryExpansionMessages('what is cf r2?')
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).toContain("You expand a user's search query into multiple search queries")
    expect(joined).toContain('each explore a DIFFERENT angle, entity, or sub-topic')
    expect(joined).toContain('Do NOT just reword the same idea with synonyms')
    expect(joined).toContain('Output ONLY a JSON array of strings.')
    expect(joined).toContain('No explanation, no markdown.')
    expect(joined).toContain('User question: what is cf r2?')
    expect(joined).not.toContain('<thinking>')
    expect(joined).not.toContain('<answer>')
  })
```

- [ ] **Step 10: 테스트 통과 확인**

Run: `npx vitest run tests/core/webllm-answer-generator.test.ts`
Expected: PASS.

### 5d. `answer`/`answerStream`이 `parseAnswerCitation`을 쓰도록 교체

- [ ] **Step 11: import 추가**

`src/offscreen/webllm-answer-generator.ts` 상단 import에 추가:

```ts
import { NOT_FOUND_ANSWER, type AnswerDraft, type AnswerGeneratorPort, type AnswerRequest } from '../core/answer-generator'
```

다음으로 교체(`parseAnswerCitation` import 추가):

```ts
import { NOT_FOUND_ANSWER, type AnswerDraft, type AnswerGeneratorPort, type AnswerRequest } from '../core/answer-generator'
import { parseAnswerCitation } from '../core/answer-citation'
```

- [ ] **Step 12: `answerStream`이 `parseAnswerCitation`을 쓰도록 교체**

찾는다:

```ts
  async answerStream(request: AnswerRequest, onDelta: (delta: string) => void): Promise<AnswerDraft> {
    const workingNotes = await this.createEvidenceNotes(request)
    const stream = await this.engine.chat.completions.create({
      messages: buildAskMessages(request.question, request.chunks, workingNotes),
      temperature: 0,
      max_tokens: MAX_ANSWER_TOKENS,
      stream: true,
    })
    let text = ''
    for await (const chunk of stream as AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }> }>) {
      const delta = chunk.choices?.[0]?.delta?.content ?? ''
      if (!delta) continue
      text += delta
      onDelta(delta)
    }
    return {
      text: text.trim() || NOT_FOUND_ANSWER,
      citedChunkIds: request.chunks.slice(0, 3).map((r) => r.chunk.id),
    }
  }
```

다음으로 교체:

```ts
  async answerStream(request: AnswerRequest, onDelta: (delta: string) => void): Promise<AnswerDraft> {
    const workingNotes = await this.createEvidenceNotes(request)
    const stream = await this.engine.chat.completions.create({
      messages: buildAskMessages(request.question, request.chunks, workingNotes),
      temperature: 0,
      max_tokens: MAX_ANSWER_TOKENS,
      stream: true,
    })
    let text = ''
    for await (const chunk of stream as AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }> }>) {
      const delta = chunk.choices?.[0]?.delta?.content ?? ''
      if (!delta) continue
      text += delta
      // Known limitation: the trailing [[cite: ...]] tag streams to onDelta character-by-
      // character like any other model output before we can strip it (we only know a
      // suffix is a citation tag once the FULL text is in hand). It briefly appears in the
      // live-typing UI and disappears once ask-answer-done replaces it with parseAnswerCitation's
      // stripped displayText. Not fixed here: buffering the tail to hide it would add real
      // complexity for a sub-second cosmetic flicker.
      onDelta(delta)
    }
    const raw = text.trim() || NOT_FOUND_ANSWER
    const { displayText, citedChunkIds } = parseAnswerCitation(raw, request.chunks)
    return { text: displayText, citedChunkIds }
  }
```

- [ ] **Step 13: `answer`가 `parseAnswerCitation`을 쓰도록 교체**

찾는다:

```ts
  async answer(request: AnswerRequest): Promise<AnswerDraft> {
    const workingNotes = await this.createEvidenceNotes(request)
    const raw = await this.createAnswerText(request, workingNotes)
    return {
      text: raw,
      citedChunkIds: request.chunks.slice(0, 3).map((r) => r.chunk.id),
    }
  }
```

다음으로 교체:

```ts
  async answer(request: AnswerRequest): Promise<AnswerDraft> {
    const workingNotes = await this.createEvidenceNotes(request)
    const raw = await this.createAnswerText(request, workingNotes)
    const { displayText, citedChunkIds } = parseAnswerCitation(raw, request.chunks)
    return { text: displayText, citedChunkIds }
  }
```

- [ ] **Step 14: 지금 이대로 테스트 돌려서 어떤 게 깨지는지 확인**

Run: `npx vitest run tests/core/webllm-answer-generator.test.ts`
Expected: FAIL — 아래 Step 15에서 다시 쓸 4개 테스트가 실패한다:
- `answer returns model text without parser cleanup`
- `answer can omit source lines and still uses retrieved chunks as sources`
- `answer does not retry when the first draft looks like a raw source snippet`
- `answerStream emits deltas as WebLLM chunks arrive`

이 넷은 전부 "태그 없이도 상위 청크가 출처가 된다"는 옛 동작을 전제로 하거나(2, 3, 4번) 옛 `[p1#0]` 브래킷 형식을 쓴다(1번). 새 설계(ADR 0024)는 태그가 없으면 출처를 비운다.

- [ ] **Step 15: 깨진 4개 테스트를 새 태그 형식에 맞게 다시 쓴다**

먼저 `answer returns model text without parser cleanup`을 찾는다:

```ts
  // Scenario: 모델 출력을 코드가 몰래 고치면 스트리밍과 디버깅이 모두 어려워진다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 chat 계약을 가진 fake engine을 쓴다.
  test('answer returns model text without parser cleanup', async () => {
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'Cortisol can disrupt sleep.\\nSources: [p1#0] [missing#9]' } }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(answer.text).toBe('Cortisol can disrupt sleep.\\nSources: [p1#0] [missing#9]')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })
```

다음으로 교체:

```ts
  // Scenario: 모델이 [[cite: N]] 형식을 정확히 지키면, 답변 본문은 그대로 두고 태그 줄만 잘라내며
  // citedChunkIds는 태그가 가리킨 청크가 된다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 chat 계약을 가진 fake engine을 쓴다.
  test('answer keeps the model text as-is and only strips the trailing citation tag', async () => {
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'Cortisol can disrupt sleep.\n[[cite: 1]]' } }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(answer.text).toBe('Cortisol can disrupt sleep.')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })
```

다음으로 `answer can omit source lines and still uses retrieved chunks as sources`를 찾는다:

```ts
  // Scenario: 출처는 답변 카드 하단에 이미 보이므로 WebLLM 답변 본문에 내부용 Sources 줄을 강요하지 않는다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 source 없는 chat 응답 계약만 fake로 둔다.
  test('answer can omit source lines and still uses retrieved chunks as sources', async () => {
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'The saved page says cortisol can disrupt REM sleep.' } }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(answer.text).toBe('The saved page says cortisol can disrupt REM sleep.')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })
```

다음으로 교체:

```ts
  // Scenario: 모델이 인용 태그를 아예 안 달면, 상위 청크로 대신 채우지 말고 출처를 비워야 한다
  // (ADR 0024: 근거가 불확실하면 추측 대신 비운다).
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 태그 없는 chat 응답 계약만 fake로 둔다.
  test('answer returns no sources when the model omits the citation tag', async () => {
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'The saved page says cortisol can disrupt REM sleep.' } }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(answer.text).toBe('The saved page says cortisol can disrupt REM sleep.')
    expect(answer.citedChunkIds).toEqual([])
  })
```

다음으로 `answer does not retry when the first draft looks like a raw source snippet`를 찾는다:

```ts
  // Scenario: 스트리밍으로 가려면 첫 답을 숨겼다가 다시 쓰는 흐름이 화면을 복잡하게 만든다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 chat 호출 횟수만 fake로 확인한다.
  test('answer does not retry when the first draft looks like a raw source snippet', async () => {
    let calls = 0
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: calls++ === 0 ? 'Relevant fact: sleep article.' : '[p1#0] Sleep article',
              },
            }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(calls).toBe(2)
    expect(answer.text).toBe('[p1#0] Sleep article')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })
```

다음으로 교체:

```ts
  // Scenario: 스트리밍으로 가려면 첫 답을 숨겼다가 다시 쓰는 흐름이 화면을 복잡하게 만든다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 chat 호출 횟수만 fake로 확인한다.
  test('answer does not retry when the first draft looks like a raw source snippet', async () => {
    let calls = 0
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: calls++ === 0
                  ? 'Relevant fact: sleep article.'
                  : 'Sleep article says cortisol disrupts sleep.\n[[cite: 1]]',
              },
            }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(calls).toBe(2)
    expect(answer.text).toBe('Sleep article says cortisol disrupts sleep.')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })
```

마지막으로 `answerStream emits deltas as WebLLM chunks arrive`를 찾는다:

```ts
  // Scenario: WebLLM 답변을 다 만든 뒤 한 번에 보여주면 사용자는 loading 상태에서 멈춘 것처럼 느낀다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 stream chunk 계약을 가진 fake engine을 쓴다.
  test('answerStream emits deltas as WebLLM chunks arrive', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: 'GABA is ' } }] }
      yield { choices: [{ delta: { content: 'an inhibitory neurotransmitter.' } }] }
      yield { choices: [{ delta: {} }] }
    }
    let sawStream = false
    const engine = {
      chat: {
        completions: {
          create: async (request: { stream?: boolean }) => {
            sawStream = request.stream === true
            return chunks()
          },
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const deltas: string[] = []
    const answer = await generator.answerStream(
      { question: 'what is GABA?', chunks: [result] },
      (delta) => deltas.push(delta),
    )

    expect(sawStream).toBe(true)
    expect(deltas).toEqual(['GABA is ', 'an inhibitory neurotransmitter.'])
    expect(answer.text).toBe('GABA is an inhibitory neurotransmitter.')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })
```

다음으로 교체:

```ts
  // Scenario: WebLLM 답변을 다 만든 뒤 한 번에 보여주면 사용자는 loading 상태에서 멈춘 것처럼 느낀다.
  // 인용 태그는 스트리밍 도중엔 그대로 흘러나오지만(마지막 조각이라 미리 알 방법이 없음), 최종
  // answer.text에서는 잘려나가야 한다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 stream chunk 계약을 가진 fake engine을 쓴다.
  test('answerStream emits deltas as WebLLM chunks arrive and strips the trailing citation tag from the final text', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: 'GABA is ' } }] }
      yield { choices: [{ delta: { content: 'an inhibitory neurotransmitter.' } }] }
      yield { choices: [{ delta: { content: '\n[[cite: 1]]' } }] }
      yield { choices: [{ delta: {} }] }
    }
    let sawStream = false
    const engine = {
      chat: {
        completions: {
          create: async (request: { stream?: boolean }) => {
            sawStream = request.stream === true
            return chunks()
          },
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const deltas: string[] = []
    const answer = await generator.answerStream(
      { question: 'what is GABA?', chunks: [result] },
      (delta) => deltas.push(delta),
    )

    expect(sawStream).toBe(true)
    expect(deltas).toEqual(['GABA is ', 'an inhibitory neurotransmitter.', '\n[[cite: 1]]'])
    expect(answer.text).toBe('GABA is an inhibitory neurotransmitter.')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })
```

- [ ] **Step 16: 청크 여러 개일 때 실제로 인용 안 한 청크는 빠지는지 확인하는 테스트 추가**

지금까지 다시 쓴 4개 테스트는 전부 청크 1개짜리 `[result]`만 쓴다. 청크가 1개면 "태그를 진짜로 파싱하는지"와 "옛날처럼 그냥 상위 3개(=전부)를 돌려주는지"를 구분할 수 없다 — 이게 원래 버그가 숨어 있던 사각지대였다(스펙 문서 4.1절). 이 사각지대를 명시적으로 막는 테스트를 청크 3개로 추가한다.

같은 테스트 파일, `describe('webllm answer generator', () => {` 블록 맨 끝(마지막 `})` 바로 앞)에 추가:

```ts

  // Scenario: 청크가 여러 개일 때, 모델이 실제로 인용한 발췌만 출처가 되고 인용 안 한 발췌는 빠져야
  // 한다. 청크 1개짜리 테스트로는 "태그를 읽는지"와 "무조건 상위 N개인지"를 구분 못 하므로, 이 구멍을
  // 청크 3개로 명시적으로 막는다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 chat 계약을 가진 fake engine을 쓴다.
  test('answer cites only the excerpts the model tagged, not every retrieved chunk', async () => {
    const chunks: RankedResult[] = [
      { chunk: { id: 'p1#0', pageId: 'p1', index: 0, text: 'Cortisol can disrupt REM sleep.' },
        page: { id: 'p1', url: 'https://example.com/sleep', title: 'Sleep article', capturedAt: 1 }, score: 1 },
      { chunk: { id: 'p2#0', pageId: 'p2', index: 0, text: 'Caffeine blocks adenosine receptors.' },
        page: { id: 'p2', url: 'https://example.com/caffeine', title: 'Caffeine article', capturedAt: 1 }, score: 1 },
      { chunk: { id: 'p3#0', pageId: 'p3', index: 0, text: 'Blue light suppresses melatonin.' },
        page: { id: 'p3', url: 'https://example.com/light', title: 'Light article', capturedAt: 1 }, score: 1 },
    ]
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: { content: 'Cortisol and blue light both disrupt sleep.\n[[cite: 1, 3]]' },
            }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what disrupts sleep?', chunks })

    expect(answer.text).toBe('Cortisol and blue light both disrupt sleep.')
    expect(answer.citedChunkIds).toEqual(['p1#0', 'p3#0'])
    expect(answer.citedChunkIds).not.toContain('p2#0')
  })
```

- [ ] **Step 17: 전체 테스트 통과 확인**

Run: `npx vitest run tests/core/webllm-answer-generator.test.ts`
Expected: PASS (전체).

- [ ] **Step 18: Commit**

```bash
git add src/offscreen/webllm-answer-generator.ts tests/core/webllm-answer-generator.test.ts
git commit -m "feat: Ask cites only excerpts the model actually tagged

- Prompt numbers each excerpt (Excerpt N)) and asks the model to append a
  hidden [[cite: N, N]] marker instead of a visible sources section.
- answer/answerStream now parse that tag via parseAnswerCitation instead
  of hardcoding the top-3 chunks as citedChunkIds.
- Query expansion prompt rewritten to ask for distinct angles/entities
  instead of synonym rewording, so expanded searches surface different
  saved content instead of repeating the same search.
- Rewrites the 4 existing tests that assumed the old always-top-3
  fallback or the old [chunkId] bracket format."
```

---

## Task 6: `ask-service.ts` — 검색어 중복 제거 배선 + 저신뢰 게이트

**Files:**
- Modify: `src/core/ask-service.ts`
- Modify: `tests/core/ask-service.test.ts`

### 6a. 공용 fake `embedder`를 검색어별로 다른 벡터를 주도록 먼저 고친다

이 수정을 먼저 하지 않으면, 이후 단계에서 도입할 의미 기반 중복 제거가 벡터 없는(undefined) 검색어를 만나 크래시가 난다 — 지금 공용 `embedder`는 입력 개수와 무관하게 항상 벡터 1개만 반환하기 때문이다.

- [ ] **Step 1: `tests/core/ask-service.test.ts`의 공용 `embedder`를 인덱스별로 다른 벡터를 주도록 고친다**

찾는다:

```ts
const embedder: EmbeddingPort = {
  embed: async () => [new Float32Array([1, 0])],
}
```

다음으로 교체:

```ts
const embedder: EmbeddingPort = {
  embed: async (texts) => texts.map((_, i) => new Float32Array([1, i])),
}
```

- [ ] **Step 2: 기존 테스트가 여전히 통과하는지 확인**

Run: `npx vitest run tests/core/ask-service.test.ts`
Expected: PASS (전체). 검색어가 1개인 테스트는 여전히 `[1, 0]`을 받으므로(인덱스 0), 이 변경으로 아무것도 안 깨진다. 검색어가 2개인 `askStream reports expanded queries only when expansion succeeds` 테스트는 `[1,0]`과 `[1,1]`을 받는데, 코사인 유사도가 threshold(이번 태스크에서 추가할 0.92)보다 한참 낮아 다음 단계에서 중복 제거가 들어와도 둘 다 살아남는다.

### 6b. `resolveSearchQueries`로 재구성 + 저신뢰 게이트 추가

- [ ] **Step 3: import 및 상수 수정**

`src/core/ask-service.ts` 상단을 찾는다(Task 1에서 이미 한 번 수정했으므로 지금은 이 상태다):

```ts
import { NOT_FOUND_ANSWER, type AnswerGeneratorPort, type AskProgressEvent } from './answer-generator'
import { DEFAULT_ANSWER_RETRIEVAL_OPTIONS, type AnswerRetrievalOptions } from './answer-retrieval'
import type { AskAnswer, AskQuery, RankedResult } from './model'
import type { EmbeddingPort, VectorSearchPort } from './ports'

const MAX_ASK_SEARCH_QUERIES = 5
```

다음으로 교체:

```ts
import { NOT_FOUND_ANSWER, type AnswerGeneratorPort, type AskProgressEvent } from './answer-generator'
import { DEFAULT_ANSWER_RETRIEVAL_OPTIONS, type AnswerRetrievalOptions } from './answer-retrieval'
import type { AskAnswer, AskQuery, RankedResult } from './model'
import type { EmbeddingPort, VectorSearchPort } from './ports'
import { dedupeSimilarQueries, type EmbeddedQuery } from './query-dedup'

const MAX_ASK_SEARCH_QUERIES = 5
export const QUERY_DEDUP_THRESHOLD = 0.92
export const ASK_MIN_CONFIDENCE = 0.3
```

- [ ] **Step 4: `askWithGenerator`가 새 흐름과 게이트를 쓰도록 교체**

찾는다:

```ts
  private async askWithGenerator(
    query: AskQuery,
    generate: (chunks: RankedResult[]) => Promise<{ text: string; citedChunkIds: string[] }>,
    onProgress?: (event: AskProgressEvent) => void,
  ): Promise<AskAnswer> {
    const options: AnswerRetrievalOptions = this.retrievalOptions
      ? { ...DEFAULT_ANSWER_RETRIEVAL_OPTIONS, ...this.retrievalOptions }
      : {
          ...DEFAULT_ANSWER_RETRIEVAL_OPTIONS,
          pageK: Math.max(1, Math.ceil(query.retrieveK / 4)),
          maxContextChunks: query.contextK,
        }
    const searchQueries = await this.searchQueriesFor(query.text)
    if (searchQueries.length > 1) onProgress?.({ type: 'expanded-queries', queries: searchQueries })
    const vectors = await this.embedder.embed(searchQueries, 'query')
    const resultSets = await Promise.all(
      searchQueries.map((text, i) => this.store.searchForAnswer(vectors[i], text, options)),
    )
    const retrieved = mergeAnswerResults(resultSets)
    if (retrieved.length === 0) return { text: NOT_FOUND_ANSWER, sources: [] }

    const chunks = retrieved.slice(0, options.maxContextChunks)
    const draft = await generate(chunks)
    const sourceIds = new Set(draft.citedChunkIds)
    const sourcesByPage = new Map<string, RankedResult>()
    for (const result of chunks) {
      if (!sourceIds.has(result.chunk.id)) continue
      if (!sourcesByPage.has(result.page.id)) sourcesByPage.set(result.page.id, result)
      if (sourcesByPage.size >= 5) break
    }
    const sources = [...sourcesByPage.values()]
    return { text: draft.text, sources }
  }

  private async searchQueriesFor(question: string): Promise<string[]> {
    let expanded: string[] = []
    if (this.generator.expandQueries) {
      expanded = await this.generator.expandQueries(question).catch((err) => {
        console.warn('[recall] query expansion failed:', err)
        return []
      })
    }
    return uniqueQueries([question, ...expanded]).slice(0, MAX_ASK_SEARCH_QUERIES)
  }
}
```

다음으로 교체:

```ts
  private async askWithGenerator(
    query: AskQuery,
    generate: (chunks: RankedResult[]) => Promise<{ text: string; citedChunkIds: string[] }>,
    onProgress?: (event: AskProgressEvent) => void,
  ): Promise<AskAnswer> {
    const options: AnswerRetrievalOptions = this.retrievalOptions
      ? { ...DEFAULT_ANSWER_RETRIEVAL_OPTIONS, ...this.retrievalOptions }
      : {
          ...DEFAULT_ANSWER_RETRIEVAL_OPTIONS,
          pageK: Math.max(1, Math.ceil(query.retrieveK / 4)),
          maxContextChunks: query.contextK,
        }
    const searchQueries = await this.resolveSearchQueries(query.text)
    if (searchQueries.length > 1) {
      onProgress?.({ type: 'expanded-queries', queries: searchQueries.map((q) => q.text) })
    }
    const resultSets = await Promise.all(
      searchQueries.map((q) => this.store.searchForAnswer(q.vector, q.text, options)),
    )
    const retrieved = mergeAnswerResults(resultSets)
    if (retrieved.length === 0) return { text: NOT_FOUND_ANSWER, sources: [] }
    if (!passesConfidenceGate(retrieved[0].score, ASK_MIN_CONFIDENCE)) {
      return { text: NOT_FOUND_ANSWER, sources: [] }
    }

    const chunks = retrieved.slice(0, options.maxContextChunks)
    const draft = await generate(chunks)
    const sourceIds = new Set(draft.citedChunkIds)
    const sourcesByPage = new Map<string, RankedResult>()
    for (const result of chunks) {
      if (!sourceIds.has(result.chunk.id)) continue
      if (!sourcesByPage.has(result.page.id)) sourcesByPage.set(result.page.id, result)
      if (sourcesByPage.size >= 5) break
    }
    const sources = [...sourcesByPage.values()]
    return { text: draft.text, sources }
  }

  // Expands the question via the generator (best-effort), textually dedupes, embeds every
  // surviving candidate in one batch, then semantically dedupes so a reworded-not-diversified
  // expansion never burns a second search pass on the same idea. The original question is
  // always first and is never dropped (dedupeSimilarQueries keeps the first item unconditionally).
  private async resolveSearchQueries(question: string): Promise<EmbeddedQuery[]> {
    let expanded: string[] = []
    if (this.generator.expandQueries) {
      expanded = await this.generator.expandQueries(question).catch((err) => {
        console.warn('[recall] query expansion failed:', err)
        return []
      })
    }
    const texts = uniqueQueries([question, ...expanded]).slice(0, MAX_ASK_SEARCH_QUERIES)
    const vectors = await this.embedder.embed(texts, 'query')
    const candidates = texts.map((text, i) => ({ text, vector: vectors[i] }))
    return dedupeSimilarQueries(candidates, QUERY_DEDUP_THRESHOLD)
  }
}

// Whether the top (best) merged result is strong enough to answer from. Below the threshold,
// AskService returns NOT_FOUND_ANSWER without ever calling the generator (ADR 0024: a weak
// match should not be dressed up into a confident-sounding hallucination).
export function passesConfidenceGate(topScore: number, minScore: number): boolean {
  return topScore >= minScore
}
```

- [ ] **Step 5: `mergeAnswerResults`를 export로 바꾼다 (평가 하네스가 재사용할 수 있도록)**

찾는다:

```ts
function mergeAnswerResults(resultSets: RankedResult[][]): RankedResult[] {
```

다음으로 교체:

```ts
export function mergeAnswerResults(resultSets: RankedResult[][]): RankedResult[] {
```

- [ ] **Step 6: 지금까지 변경으로 기존 테스트가 통과하는지 확인**

Run: `npx vitest run tests/core/ask-service.test.ts`
Expected: PASS (전체). 모든 기존 테스트가 `chunk()` 헬퍼로 `score: 1`을 쓰므로(0.3 문턱보다 훨씬 높음), 새로 추가한 게이트가 기존 테스트를 막지 않는다.

- [ ] **Step 7: 저신뢰 게이트가 실제로 생성기를 막는지 새 테스트 추가**

`tests/core/ask-service.test.ts` 맨 끝, `test('ask returns not-found answer when retrieval has no chunks', ...)` 다음에 추가:

```ts

// Scenario: 검색 결과가 있어도 1등 점수가 너무 낮으면(관련 없는 근거), LLM을 호출해 그럴듯한 답을
// 지어내지 말고 바로 못 찾았다고 답해야 한다.
// Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 계약을 가진 fake generator를 쓴다.
test('ask returns not-found and skips the generator when the top score is below the confidence gate', async () => {
  const weak: RankedResult = { ...chunk('p1#0', 'barely related text'), score: 0.1 }
  const store = fakeStore(async () => [weak])
  let generatorCalled = false
  const generator: AnswerGeneratorPort = {
    answer: async () => {
      generatorCalled = true
      return { text: 'should not be called', citedChunkIds: [] }
    },
  }

  const svc = new AskService(embedder, store, generator)
  const answer = await svc.ask({ text: 'unrelated question', retrieveK: 12, contextK: 8 })

  expect(generatorCalled).toBe(false)
  expect(answer.text).toBe("I couldn't find that in your saved pages.")
  expect(answer.sources).toEqual([])
})

// Scenario: 확장 검색어 중 원본과 뜻이 겹치는 게 있으면(의미 유사도가 높으면) 실제로 검색에서
// 제외돼야 한다 — LLM이 다양화 지시를 안 따르고 동의어만 바꿔도 검색 낭비가 없어야 한다.
// Coverage: ⚠️ mock - 임베딩 벡터는 테스트가 직접 준 합성 값이라, "중복 제거가 배선대로 불리는가"만
// 확인한다. 실제 임베딩으로 진짜 다양화 효과가 나는지는 eval/run-ask.mjs 하네스의 몫.
test('ask drops an expanded query that is semantically too similar to one already kept', async () => {
  const result = chunk('p1#0', 'R2 is object storage.')
  const searchedTexts: string[] = []
  const spyEmbedder: EmbeddingPort = {
    embed: async (texts) => {
      // First two texts collapse to nearly the same vector (paraphrase), the third is distinct.
      return texts.map((_, i) => (i < 2 ? new Float32Array([1, 0]) : new Float32Array([0, 1])))
    },
  }
  const store: VectorSearchPort = {
    ...fakeStore(async () => []),
    searchForAnswer: async (_vector, text) => {
      searchedTexts.push(text)
      return [result]
    },
  }
  const generator: AnswerGeneratorPort = {
    expandQueries: async () => ['who invented rnn (paraphrase)', 'lstm inventors'],
    answer: async ({ chunks }) => ({
      text: 'R2 is object storage.',
      citedChunkIds: chunks.map((r) => r.chunk.id),
    }),
  }

  const svc = new AskService(spyEmbedder, store, generator)
  await svc.ask({ text: 'who invented rnn', retrieveK: 12, contextK: 8 })

  expect(searchedTexts).toEqual(['who invented rnn', 'lstm inventors'])
})
```

- [ ] **Step 8: 테스트 통과 확인**

Run: `npx vitest run tests/core/ask-service.test.ts`
Expected: PASS (전체, 기존 9개 + 신규 2개 = 11개).

- [ ] **Step 9: Commit**

```bash
git add src/core/ask-service.ts tests/core/ask-service.test.ts
git commit -m "feat: Ask deduplicates expanded queries and gates low-confidence answers

- resolveSearchQueries embeds every expansion candidate up front, then
  drops semantic near-duplicates via dedupeSimilarQueries (0.92 cosine)
  before spending a search pass on them. The 'Tried searches' chips the
  user sees now reflect the deduplicated list.
- askWithGenerator checks the merged top score against a 0.3 confidence
  floor (passesConfidenceGate) and returns NOT_FOUND_ANSWER without
  calling the generator when it's too weak to answer from.
- mergeAnswerResults exported for reuse by the upcoming eval/run-ask.mjs
  harness.
- Fixes the shared test embedder fake to return a distinct vector per
  input text (previously always returned one vector regardless of input
  count, which is unrealistic — production embedders always return one
  vector per text)."
```

---

## Task 7: Ask 평가 하네스 (`eval/run-ask.mjs`)

**Files:**
- Create: `eval/ask-golden.json`
- Create: `eval/fixtures/expansions.json`
- Create: `eval/run-ask.mjs`
- Modify: `package.json`

- [ ] **Step 1: 골든셋 작성 (기존 `golden.json`의 검증된 EN->EN 항목 재사용)**

Create `eval/ask-golden.json`:

```json
[
  { "query": "bacteria", "expectAnswerable": true,
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Bacteria"] },
  { "query": "deep learning neural networks", "expectAnswerable": true,
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Deep_learning"] },
  { "query": "hormone that ruins sleep", "expectAnswerable": true,
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Cortisol"] },
  { "query": "powerhouse of the cell", "expectAnswerable": true,
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Mitochondrion"] },
  { "query": "what is a protein", "expectAnswerable": true,
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Protein"] },
  { "query": "genetic material in chromosomes", "expectAnswerable": true,
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/DNA"] },

  { "query": "what dose of melatonin supplement should I take before bed", "expectAnswerable": false },
  { "query": "how much does a home DNA testing kit cost", "expectAnswerable": false },
  { "query": "what gpu should I buy to train a deep learning model at home", "expectAnswerable": false }
]
```

이 6개 `expectAnswerable:true` 항목은 기존 `eval/golden.json`의 S1/S4/S5(EN->EN) 항목과 완전히 동일한 질문·정답 페이지다 — 이미 검증된 값이라 새로 지어내지 않는다. 3개 `expectAnswerable:false` 항목은 코퍼스와 같은 도메인이지만(수면 호르몬, DNA, 딥러닝) 그 페이지에 실제로 없는 구체적 사실을 묻는다.

- [ ] **Step 2: 확장 검색어 픽스처를 빈 객체로 시작**

Create `eval/fixtures/expansions.json`:

```json
{}
```

**왜 비어 있는가**: 확장 검색어는 실제 WebLLM(브라우저 GPU 전용)이 만든다. Node.js 하네스에서 WebLLM을 못 돌리므로, 이 파일은 "실제로 한 번 기록한 진짜 모델 출력"만 담아야 한다 — 내가 그럴듯하게 지어낸 문장을 "진짜 모델 출력"이라고 적어두는 건 검증을 속이는 것과 같다. 비어 있으면 하네스는 각 질문을 원본 텍스트만으로 검색한다(중복 제거·병합·게이트 로직은 전부 정상 동작, 확장의 다양성 효과만 아직 안 재는 상태). 나중에 실제로 재고 싶으면:

1. 확장판 익스텐션을 로드하고 사이드패널에서 Ask로 전환한다.
2. `eval/ask-golden.json`의 각 `expectAnswerable:true` 질문을 실제로 입력한다.
3. 화면에 뜨는 "Tried searches" 칩(원본 제외, 중복 제거된 확장 검색어들)을 그대로 옮겨 적는다.
4. `{ "<원본 질문>": ["확장1", "확장2", ...] }` 형태로 이 파일에 채운다.

- [ ] **Step 3: 하네스 스크립트 작성**

Create `eval/run-ask.mjs`:

```js
// Ask-quality harness: runs the REAL retrieval/dedup/merge/gate pipeline (everything up to
// but not including the LLM's final answer — WebLLM only runs in-browser, so generation
// itself is out of scope here; see the spec's "잴 수 없는 것" section).
// Usage: vite-node eval/run-ask.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { buildStore } from './lib/build-and-search.mjs'
import { embed } from './lib/embed-node.mjs'
import { dedupeSimilarQueries } from '../src/core/query-dedup.ts'
import {
  mergeAnswerResults,
  passesConfidenceGate,
  ASK_MIN_CONFIDENCE,
  QUERY_DEDUP_THRESHOLD,
} from '../src/core/ask-service.ts'
import { DEFAULT_ANSWER_RETRIEVAL_OPTIONS } from '../src/core/answer-retrieval.ts'
import { evidenceRecallAtContext, confidenceGateCorrect } from '../src/core/eval-metrics.ts'

const manifest = JSON.parse(readFileSync('eval/manifest.json', 'utf8'))
const golden = JSON.parse(readFileSync('eval/ask-golden.json', 'utf8'))
const expansionsPath = 'eval/fixtures/expansions.json'
const expansions = existsSync(expansionsPath) ? JSON.parse(readFileSync(expansionsPath, 'utf8')) : {}

console.log(`[eval:ask] corpus=${manifest.length} pages  queries=${golden.length}`)
const t0 = Date.now()
const store = await buildStore(manifest, { strip: true, minProse: 0.35 })
console.log(`[eval:ask] indexed + embedded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)

const rows = []
for (const g of golden) {
  const candidateTexts = [g.query, ...(expansions[g.query] ?? [])]
  const vectors = await embed(candidateTexts, 'query')
  const candidates = candidateTexts.map((text, i) => ({ text, vector: vectors[i] }))
  const survivors = dedupeSimilarQueries(candidates, QUERY_DEDUP_THRESHOLD)

  const resultSets = await Promise.all(
    survivors.map((s) => store.searchForAnswer(s.vector, s.text, DEFAULT_ANSWER_RETRIEVAL_OPTIONS)),
  )
  const merged = mergeAnswerResults(resultSets)
  const topScore = merged[0]?.score ?? 0
  const passesGate = merged.length > 0 && passesConfidenceGate(topScore, ASK_MIN_CONFIDENCE)

  const context = merged.slice(0, DEFAULT_ANSWER_RETRIEVAL_OPTIONS.maxContextChunks)
  const contextPageIds = context.map((r) => r.page.id)

  rows.push({
    query: g.query,
    expectAnswerable: g.expectAnswerable,
    survivingQueries: survivors.length,
    topScore: Number(topScore.toFixed(3)),
    passesGate,
    gateCorrect: confidenceGateCorrect(passesGate, g.expectAnswerable),
    evidenceRecall: g.expectAnswerable
      ? evidenceRecallAtContext(contextPageIds, g.expectTopPageIds ?? [])
      : null,
  })
}

console.log('QUERY                                          answerable  gate    OK   evidRecall  survQ  topScore')
for (const r of rows) {
  console.log(
    `${r.query.slice(0, 46).padEnd(46)}  ${String(r.expectAnswerable).padEnd(10)}  ` +
      `${(r.passesGate ? 'pass' : 'block').padEnd(6)}  ${r.gateCorrect ? 'yes' : 'NO '}  ` +
      `${r.evidenceRecall === null ? '   n/a' : `     ${r.evidenceRecall}`}       ${r.survivingQueries}      ${r.topScore}`,
  )
}

const gateAccuracy = rows.reduce((a, r) => a + r.gateCorrect, 0) / rows.length
const answerable = rows.filter((r) => r.expectAnswerable)
const evidenceRecallAvg = answerable.length
  ? answerable.reduce((a, r) => a + r.evidenceRecall, 0) / answerable.length
  : 0
console.log('---')
console.log(`gate-accuracy=${gateAccuracy.toFixed(2)}  evidence-recall@context=${evidenceRecallAvg.toFixed(2)}`)

writeFileSync(
  'eval/last-ask-scorecard.json',
  JSON.stringify({ gateAccuracy, evidenceRecallAvg, rows }, null, 2) + '\n',
)
```

- [ ] **Step 4: `package.json`에 실행 스크립트 추가**

`package.json`의 `"scripts"` 블록에서 찾는다:

```json
    "eval:ci": "npm run eval:fetch-model && vite-node eval/run.mjs -- --ci --strip --min-prose=0.35",
```

다음 줄을 바로 아래에 추가:

```json
    "eval:ci": "npm run eval:fetch-model && vite-node eval/run.mjs -- --ci --strip --min-prose=0.35",
    "eval:ask": "npm run eval:fetch-model && vite-node eval/run-ask.mjs",
```

- [ ] **Step 5: 하네스가 실제로 돌아가는지 실행**

Run: `npm run eval:ask`
Expected: 에러 없이 끝까지 돌고, `gate-accuracy=1.00`에 가까운 값(모든 `expectAnswerable` 행이 옳게 판정됨)과 `evidence-recall@context=1.00`에 가까운 값(정답 페이지가 전부 문맥에 들어옴)이 나온다. `eval/last-ask-scorecard.json`이 새로 생긴다.

만약 `gate-accuracy`나 `evidence-recall@context`가 1.00에서 많이 벗어나면, `eval/last-ask-scorecard.json`의 `rows`를 열어 어떤 질문이 틀렸는지 보고 `ASK_MIN_CONFIDENCE`(`src/core/ask-service.ts`, 지금 0.3) 값을 조정한다 — 이 값은 스펙 문서에 "실측 후 조정"이라고 명시된 시작값이다.

- [ ] **Step 6: Commit**

```bash
git add eval/ask-golden.json eval/fixtures/expansions.json eval/run-ask.mjs package.json
git commit -m "feat: add eval:ask harness for Ask retrieval/gate quality

Runs the real dedup -> search -> merge -> confidence-gate pipeline (no
LLM — WebLLM only runs in-browser) against a page-level golden set and
reports evidence-recall@context and confidence-gate accuracy. Query
expansion fixtures start empty; see eval/fixtures/expansions.json for
how to record real WebLLM output later."
```

---

## Task 8: 전체 검증 + 임계값 실측 메모

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 전체 단위테스트 실행**

Run: `npm run test`
Expected: 전체 PASS. 특히 이번에 건드린 파일 전부 포함되는지 확인 — `answer-citation.test.ts`, `query-dedup.test.ts`, `eval-metrics.test.ts`, `webllm-answer-generator.test.ts`, `ask-service.test.ts`.

- [ ] **Step 2: 기존 검색 골든셋이 안 깨졌는지 확인 (이번 작업은 검색 랭킹 자체를 안 건드렸어야 함)**

Run: `npm run eval:english`
Expected: 이전과 동일한 스코어카드(이번 작업은 `src/core/ranking.ts`, `src/offscreen/sqlite-worker.ts`, `src/core/paragraph-chunker.ts` 중 어느 것도 건드리지 않았으므로 숫자가 그대로여야 한다).

- [ ] **Step 3: Ask 하네스 스코어카드 재확인**

Run: `npm run eval:ask`
Expected: Task 7에서 확인한 것과 동일한 결과.

- [ ] **Step 4: 임계값 최종 확정 여부 판단**

`eval/last-ask-scorecard.json`을 읽고:
- `gateAccuracy`가 1.00이 아니면, 어느 쪽으로 틀렸는지 본다(관련 있는데 막힘 = 문턱이 너무 높음 → `ASK_MIN_CONFIDENCE` 낮추기. 무관한데 통과 = 문턱이 너무 낮음 → 올리기).
- `evidenceRecallAvg`가 1.00이 아니면, `context`(상위 14개)에 정답 페이지가 없다는 뜻 — 이번 작업 범위(검색 랭킹 자체)가 아니라 검색 품질 서브스펙(리랭커 등, 스펙 문서 2절 "제외" 참고)의 몫이니 여기서 임계값을 억지로 맞추려 하지 않는다.

값을 바꿨다면 `src/core/ask-service.ts`의 `ASK_MIN_CONFIDENCE`/`QUERY_DEDUP_THRESHOLD` 상수 옆 주석에 실측 근거를 한 줄 남기고, Step 1~3을 다시 돌려 전부 PASS인지 재확인한다.

- [ ] **Step 5: (값을 바꿨을 경우만) Commit**

```bash
git add src/core/ask-service.ts
git commit -m "tune: adjust Ask confidence/dedup thresholds based on eval:ask scorecard"
```

값을 안 바꿨다면 이 커밋은 건너뛴다.

---

## 완료 후 남는 것 (이번 계획 범위 밖, 스펙 문서 12절과 동일)

- 검색 랭킹 자체 개선(크로스인코더 리랭커, 청킹 겹침) — 별도 서브스펙.
- `eval/fixtures/expansions.json`에 실제 WebLLM 출력 기록 — Task 7 Step 2에 절차 문서화됨, 브라우저 필요라 이번 계획엔 필수 아님.
- 새 지표(`evidence-recall@context`, `confidence-gate-accuracy`)의 CI 게이트화 — 임계값이 몇 번의 실행으로 안정된 뒤 별도 작업.
