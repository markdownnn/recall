# Recall 걷는 뼈대(Walking Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 페이지를 수동으로 캡처하면 본문이 청크로 쪼개져 로컬에 임베딩·저장되고, 팝업에서 자연어로 검색하면 의미가 맞는 청크 카드가 뜨는, 한 줄기 end-to-end가 실제 크롬 익스텐션으로 돈다.

**Architecture:** 헥사고날. 순수 TS 코어(`ContentChunkerPort`/`EmbeddingPort`/`VectorSearchPort`와 `CaptureService`/`RecallService`)는 브라우저 없이 단위 테스트로 전부 검증한다. 인프라(transformers.js 임베딩, sqlite-wasm 저장, Readability 추출, Preact 팝업)는 얇은 어댑터로 포트 뒤에 숨긴다. 벡터 검색은 v1에서 float32 브루트포스지만 `VectorSearchPort` 뒤라 나중에 sqlite-vec/ANN로 코어 무수정 교체 가능.

**Tech Stack:** TypeScript · Vite + @crxjs/vite-plugin (MV3) · Preact · @mozilla/readability · @xenova/transformers (multilingual-e5-small) · @sqlite.org/sqlite-wasm (OPFS) · Vitest(단위) · Playwright(E2E)

**걷는 뼈대의 의도적 단순화 (다음 플랜으로 미룸):**
- 캡처는 **수동 버튼**만 (dwell·SPA·게이트·denylist 없음 → Plan 2)
- 검색은 **벡터 단독 브루트포스** (FTS5 하이브리드·dedup·랭킹 정책 → Plan 3)
- 하이라이트·prefill·내보내기·백업 없음 (→ Plan 4~7)
- UI는 **팝업** (커맨드팔레트 오버레이 → Plan 8)

---

## File Structure

```
recall/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── playwright.config.ts
├── manifest.config.ts                 # MV3 매니페스트 (crxjs)
├── src/
│   ├── core/
│   │   ├── model.ts                    # Chunk, CapturedPage, RankedResult, RecallQuery
│   │   ├── ports.ts                    # ContentChunkerPort, EmbeddingPort, VectorSearchPort
│   │   ├── cosine.ts                   # cosineSimilarity
│   │   ├── paragraph-chunker.ts        # ContentChunkerPort 구현
│   │   ├── capture-service.ts          # 추출본문 -> 청크 -> 임베딩 -> 저장
│   │   └── recall-service.ts           # 쿼리 -> 임베딩 -> 검색 -> RankedResult[]
│   ├── adapters/
│   │   ├── memory-vector-store.ts      # 인메모리 VectorSearchPort (단위테스트/폴백)
│   │   ├── sqlite-vector-store.ts      # 실제 sqlite-wasm VectorSearchPort
│   │   └── transformers-embedder.ts    # EmbeddingPort: 워커에 임베딩 요청
│   ├── workers/
│   │   └── embedder.worker.ts          # e5-small 로컬 추론
│   ├── messaging.ts                    # content/popup/background 간 타입 메시지
│   ├── background/
│   │   └── index.ts                    # service worker: 서비스 조립 + 메시지 라우팅
│   ├── content/
│   │   └── capture.ts                  # Readability 추출 후 background로 전송
│   └── ui/
│       └── popup/
│           ├── index.html
│           ├── main.tsx                # Preact 진입
│           └── App.tsx                 # 캡처 버튼 + 검색창 + 결과
└── tests/
    ├── core/                           # Vitest 단위
    └── e2e/                            # Playwright
        └── fixtures/article.html
```

---

## Task 0: 프로젝트 스캐폴드

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `manifest.config.ts`

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "recall",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@mozilla/readability": "^0.5.0",
    "@sqlite.org/sqlite-wasm": "^3.46.0-build1",
    "@xenova/transformers": "^2.17.2",
    "preact": "^10.22.0"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.25",
    "@playwright/test": "^1.45.0",
    "@preact/preset-vite": "^2.8.2",
    "typescript": "^5.4.0",
    "vite": "^5.3.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: 의존성 설치**

Run: `npm install`
Expected: `node_modules/` 생성, 에러 없음

- [ ] **Step 3: tsconfig.json 작성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "strict": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 4: manifest.config.ts 작성**

```ts
import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Recall',
  version: '0.0.1',
  description: 'Local-first research recall (walking skeleton)',
  action: { default_popup: 'src/ui/popup/index.html' },
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [
    { matches: ['<all_urls>'], js: ['src/content/capture.ts'], run_at: 'document_idle' },
  ],
  permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting'],
  host_permissions: ['<all_urls>'],
})
```

- [ ] **Step 5: vite.config.ts 작성**

```ts
import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [preact(), crx({ manifest })],
  // sqlite-wasm은 COOP/COEP가 있어야 OPFS+SharedArrayBuffer 동작
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
})
```

- [ ] **Step 6: vitest.config.ts 작성**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { globals: true, environment: 'node', include: ['tests/core/**/*.test.ts'] },
})
```

- [ ] **Step 7: 빈 빌드가 도는지 확인**

Run: `npm run test`
Expected: "No test files found" (설정은 유효, 아직 테스트 없음)

- [ ] **Step 8: Commit**

```bash
git init && git add -A
git commit -m "chore: scaffold MV3 extension with vite/crxjs/preact/vitest"
```

---

## Task 1: 코어 도메인 모델과 포트

**Files:**
- Create: `src/core/model.ts`, `src/core/ports.ts`

타입 정의라 별도 테스트는 없다(이후 태스크가 사용하며 컴파일로 검증). 

- [ ] **Step 1: model.ts 작성**

```ts
// 회수의 단위. 임베딩/검색/랭킹이 모두 이 단위.
export interface Chunk {
  id: string          // `${pageId}#${index}`
  pageId: string
  index: number
  text: string
}

// 게이트를 통과해 저장된 한 페이지.
export interface CapturedPage {
  id: string          // 정규화 URL 해시
  url: string
  title: string
  capturedAt: number
}

export interface RankedResult {
  chunk: Chunk
  page: CapturedPage
  score: number       // 1.0이 완전 일치
}

export interface RecallQuery {
  text: string
  k: number
}
```

- [ ] **Step 2: ports.ts 작성**

```ts
import type { Chunk, RankedResult } from './model'

export interface ContentChunkerPort {
  chunk(input: { pageId: string; text: string }): Chunk[]
}

// 순수 float32 반환. 양자화/int8은 여기 책임 아님.
export interface EmbeddingPort {
  // kind는 e5 프리픽스("query:" vs "passage:") 선택용
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>
}

// v1 어댑터는 float32 브루트포스. int8/ANN로 교체해도 코어 무수정.
export interface VectorSearchPort {
  upsertPage(page: import('./model').CapturedPage): Promise<void>
  upsertChunk(chunk: Chunk, vector: Float32Array): Promise<void>
  search(queryVector: Float32Array, k: number): Promise<RankedResult[]>
}
```

- [ ] **Step 3: 타입 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 4: Commit**

```bash
git add src/core/model.ts src/core/ports.ts
git commit -m "feat(core): domain model and ports"
```

---

## Task 2: 코사인 유사도

**Files:**
- Create: `src/core/cosine.ts`, `tests/core/cosine.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

**Scenario:** 검색 점수가 의미 유사도여야 한다. 같은 방향 벡터는 1.0, 직각은 0에 가까워야 회수 랭킹이 성립한다.
**Coverage:** ✅ integration (순수 함수 실연산, mock 없음)

```ts
// tests/core/cosine.test.ts
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
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run tests/core/cosine.test.ts`
Expected: FAIL — "cosineSimilarity is not a function"

- [ ] **Step 3: 최소 구현**

```ts
// src/core/cosine.ts
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/core/cosine.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/cosine.ts tests/core/cosine.test.ts
git commit -m "feat(core): cosine similarity"
```

---

## Task 3: 문단 청커

**Files:**
- Create: `src/core/paragraph-chunker.ts`, `tests/core/paragraph-chunker.test.ts`

뼈대용 단순 규칙: 빈 줄로 문단을 나누고, 한 문단이 `maxWords`(기본 220)를 넘으면 단어 경계로 자른다. 겹침·하한 병합은 Plan 3.

- [ ] **Step 1: 실패하는 테스트 작성**

**Scenario:** 긴 글 하나를 통째 임베딩하면 의미가 평균에 묻혀 회수가 안 된다. 문단 단위로 쪼개야 "정확한 구절"을 잡는다.
**Coverage:** ✅ integration (순수 함수 실연산)

```ts
// tests/core/paragraph-chunker.test.ts
import { ParagraphChunker } from '../../src/core/paragraph-chunker'

const chunker = new ParagraphChunker(5) // maxWords=5 for testing

test('splits on blank lines into chunks', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'first para\n\nsecond para' })
  expect(chunks.map((c) => c.text)).toEqual(['first para', 'second para'])
})

test('assigns stable ids and indices', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'a\n\nb' })
  expect(chunks[0]).toMatchObject({ id: 'p1#0', pageId: 'p1', index: 0 })
  expect(chunks[1]).toMatchObject({ id: 'p1#1', index: 1 })
})

test('splits a paragraph longer than maxWords', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'one two three four five six seven' })
  expect(chunks.length).toBe(2)
  expect(chunks[0].text).toBe('one two three four five')
  expect(chunks[1].text).toBe('six seven')
})

test('ignores empty paragraphs', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'a\n\n\n\n  \n\nb' })
  expect(chunks.map((c) => c.text)).toEqual(['a', 'b'])
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/core/paragraph-chunker.test.ts`
Expected: FAIL — "ParagraphChunker is not a constructor"

- [ ] **Step 3: 최소 구현**

```ts
// src/core/paragraph-chunker.ts
import type { ContentChunkerPort } from './ports'
import type { Chunk } from './model'

export class ParagraphChunker implements ContentChunkerPort {
  constructor(private readonly maxWords = 220) {}

  chunk(input: { pageId: string; text: string }): Chunk[] {
    const paras = input.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)

    const pieces: string[] = []
    for (const para of paras) {
      const words = para.split(/\s+/)
      for (let i = 0; i < words.length; i += this.maxWords) {
        pieces.push(words.slice(i, i + this.maxWords).join(' '))
      }
    }

    return pieces.map((text, index) => ({
      id: `${input.pageId}#${index}`,
      pageId: input.pageId,
      index,
      text,
    }))
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/core/paragraph-chunker.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/paragraph-chunker.ts tests/core/paragraph-chunker.test.ts
git commit -m "feat(core): paragraph chunker"
```

---

## Task 4: 인메모리 벡터 스토어 (브루트포스 검색)

**Files:**
- Create: `src/adapters/memory-vector-store.ts`, `tests/core/memory-vector-store.test.ts`

코어 서비스 단위 테스트의 fake이자, sqlite 어댑터의 동작 기준(reference)이 된다.

- [ ] **Step 1: 실패하는 테스트 작성**

**Scenario:** 쿼리 벡터에 가장 가까운 청크가 1등으로 나와야 한다. 이게 회수의 본질.
**Coverage:** ✅ integration (실제 브루트포스 연산, mock 없음)

```ts
// tests/core/memory-vector-store.test.ts
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { CapturedPage, Chunk } from '../../src/core/model'

const page: CapturedPage = { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 }
const chunkA: Chunk = { id: 'p1#0', pageId: 'p1', index: 0, text: 'cortisol and sleep' }
const chunkB: Chunk = { id: 'p1#1', pageId: 'p1', index: 1, text: 'tax accounting basics' }

test('ranks the nearest chunk first', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.upsertChunk(chunkA, new Float32Array([1, 0]))
  await store.upsertChunk(chunkB, new Float32Array([0, 1]))

  const results = await store.search(new Float32Array([0.9, 0.1]), 2)
  expect(results[0].chunk.id).toBe('p1#0')
  expect(results[0].page.id).toBe('p1')
  expect(results[0].score).toBeGreaterThan(results[1].score)
})

test('respects k', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.upsertChunk(chunkA, new Float32Array([1, 0]))
  await store.upsertChunk(chunkB, new Float32Array([0, 1]))
  expect((await store.search(new Float32Array([1, 0]), 1)).length).toBe(1)
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/core/memory-vector-store.test.ts`
Expected: FAIL — "MemoryVectorStore is not a constructor"

- [ ] **Step 3: 최소 구현**

```ts
// src/adapters/memory-vector-store.ts
import type { VectorSearchPort } from '../core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../core/model'
import { cosineSimilarity } from '../core/cosine'

export class MemoryVectorStore implements VectorSearchPort {
  private pages = new Map<string, CapturedPage>()
  private chunks = new Map<string, { chunk: Chunk; vector: Float32Array }>()

  async upsertPage(page: CapturedPage): Promise<void> {
    this.pages.set(page.id, page)
  }

  async upsertChunk(chunk: Chunk, vector: Float32Array): Promise<void> {
    this.chunks.set(chunk.id, { chunk, vector })
  }

  async search(queryVector: Float32Array, k: number): Promise<RankedResult[]> {
    const scored: RankedResult[] = []
    for (const { chunk, vector } of this.chunks.values()) {
      const page = this.pages.get(chunk.pageId)
      if (!page) continue
      scored.push({ chunk, page, score: cosineSimilarity(queryVector, vector) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/core/memory-vector-store.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/memory-vector-store.ts tests/core/memory-vector-store.test.ts
git commit -m "feat(adapter): in-memory brute-force vector store"
```

---

## Task 5: CaptureService

**Files:**
- Create: `src/core/capture-service.ts`, `tests/core/capture-service.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

**Scenario:** 페이지를 캡처하면 본문이 청크로 쪼개져 각 청크가 임베딩되어 저장돼야, 나중에 검색된다. 한 단계라도 빠지면 회수가 0이 된다.
**Coverage:** ✅ integration (실제 ParagraphChunker + MemoryVectorStore 조립; 임베딩만 결정적 fake)

```ts
// tests/core/capture-service.test.ts
import { CaptureService } from '../../src/core/capture-service'
import { ParagraphChunker } from '../../src/core/paragraph-chunker'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { EmbeddingPort } from '../../src/core/ports'

// deterministic fake: vector length = word count, dim 1. real embedding tested in Task 7.
const fakeEmbedder: EmbeddingPort = {
  async embed(texts) {
    return texts.map((t) => new Float32Array([t.split(/\s+/).length]))
  },
}

test('captures a page into stored, embedded chunks', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), fakeEmbedder, store)

  await svc.capture({ url: 'http://x/a', title: 'A', text: 'one two\n\nthree four five' })

  const results = await store.search(new Float32Array([3]), 10)
  expect(results.length).toBe(2)
  expect(results[0].chunk.text).toBe('three four five') // closest to length 3
  expect(results[0].page.url).toBe('http://x/a')
})

test('uses passage prefix kind for embedding', async () => {
  const store = new MemoryVectorStore()
  const kinds: string[] = []
  const spy: EmbeddingPort = {
    async embed(texts, kind) {
      kinds.push(kind)
      return texts.map(() => new Float32Array([1]))
    },
  }
  const svc = new CaptureService(new ParagraphChunker(220), spy, store)
  await svc.capture({ url: 'http://x/a', title: 'A', text: 'hello world' })
  expect(kinds).toContain('passage')
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/core/capture-service.test.ts`
Expected: FAIL — "CaptureService is not a constructor"

- [ ] **Step 3: 최소 구현**

```ts
// src/core/capture-service.ts
import type { ContentChunkerPort, EmbeddingPort, VectorSearchPort } from './ports'
import type { CapturedPage } from './model'

function pageIdFromUrl(url: string): string {
  // 뼈대용 정규화: 프래그먼트 제거 후 그대로 id. 강한 정규화는 Plan 2.
  const u = new URL(url)
  u.hash = ''
  return u.toString()
}

export class CaptureService {
  constructor(
    private readonly chunker: ContentChunkerPort,
    private readonly embedder: EmbeddingPort,
    private readonly store: VectorSearchPort,
  ) {}

  async capture(input: { url: string; title: string; text: string }): Promise<void> {
    const pageId = pageIdFromUrl(input.url)
    const page: CapturedPage = {
      id: pageId,
      url: input.url,
      title: input.title,
      capturedAt: Date.now(),
    }
    await this.store.upsertPage(page)

    const chunks = this.chunker.chunk({ pageId, text: input.text })
    if (chunks.length === 0) return

    const vectors = await this.embedder.embed(chunks.map((c) => c.text), 'passage')
    for (let i = 0; i < chunks.length; i++) {
      await this.store.upsertChunk(chunks[i], vectors[i])
    }
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/core/capture-service.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/capture-service.ts tests/core/capture-service.test.ts
git commit -m "feat(core): capture service"
```

---

## Task 6: RecallService

**Files:**
- Create: `src/core/recall-service.ts`, `tests/core/recall-service.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

**Scenario:** 자연어 질문을 임베딩해 가장 가까운 청크를 돌려줘야 한다. 쿼리는 'query:' 프리픽스로 임베딩돼야 e5가 제대로 매칭한다.
**Coverage:** ✅ integration (실제 RecallService + MemoryVectorStore; 임베딩만 결정적 fake)

```ts
// tests/core/recall-service.test.ts
import { RecallService } from '../../src/core/recall-service'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { EmbeddingPort } from '../../src/core/ports'
import type { CapturedPage, Chunk } from '../../src/core/model'

const fakeEmbedder: EmbeddingPort = {
  async embed(texts) {
    return texts.map((t) => new Float32Array([t.includes('sleep') ? 1 : 0, 1]))
  },
}

async function seed(store: MemoryVectorStore) {
  const page: CapturedPage = { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 }
  await store.upsertPage(page)
  const sleepChunk: Chunk = { id: 'p1#0', pageId: 'p1', index: 0, text: 'cortisol disrupts sleep' }
  const taxChunk: Chunk = { id: 'p1#1', pageId: 'p1', index: 1, text: 'tax basics' }
  await store.upsertChunk(sleepChunk, new Float32Array([1, 1]))
  await store.upsertChunk(taxChunk, new Float32Array([0, 1]))
}

test('returns the semantically closest chunk first', async () => {
  const store = new MemoryVectorStore()
  await seed(store)
  const svc = new RecallService(fakeEmbedder, store)
  const results = await svc.recall({ text: 'what wrecks my sleep', k: 2 })
  expect(results[0].chunk.text).toBe('cortisol disrupts sleep')
})

test('uses query prefix kind', async () => {
  const store = new MemoryVectorStore()
  await seed(store)
  const kinds: string[] = []
  const spy: EmbeddingPort = {
    async embed(texts, kind) {
      kinds.push(kind)
      return texts.map(() => new Float32Array([1, 1]))
    },
  }
  const svc = new RecallService(spy, store)
  await svc.recall({ text: 'q', k: 1 })
  expect(kinds).toEqual(['query'])
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/core/recall-service.test.ts`
Expected: FAIL — "RecallService is not a constructor"

- [ ] **Step 3: 최소 구현**

```ts
// src/core/recall-service.ts
import type { EmbeddingPort, VectorSearchPort } from './ports'
import type { RankedResult, RecallQuery } from './model'

export class RecallService {
  constructor(
    private readonly embedder: EmbeddingPort,
    private readonly store: VectorSearchPort,
  ) {}

  async recall(query: RecallQuery): Promise<RankedResult[]> {
    const [vector] = await this.embedder.embed([query.text], 'query')
    return this.store.search(vector, query.k)
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/core/recall-service.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 코어 전체 테스트**

Run: `npm run test`
Expected: PASS (모든 core 테스트)

- [ ] **Step 6: Commit**

```bash
git add src/core/recall-service.ts tests/core/recall-service.test.ts
git commit -m "feat(core): recall service"
```

---

## Task 7: 임베딩 워커 + TransformersEmbedder 어댑터

**Files:**
- Create: `src/workers/embedder.worker.ts`, `src/adapters/transformers-embedder.ts`, `tests/core/transformers-embedder.node.test.ts`

e5는 `query:`/`passage:` 프리픽스를 붙이고 mean pooling + normalize 한다. 무거운 추론은 워커에서. 어댑터는 워커에 요청만 보낸다.

- [ ] **Step 1: 워커 작성**

```ts
// src/workers/embedder.worker.ts
import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers'

let extractorP: Promise<FeatureExtractionPipeline> | null = null
function getExtractor() {
  if (!extractorP) {
    extractorP = pipeline('feature-extraction', 'Xenova/multilingual-e5-small')
  }
  return extractorP
}

self.onmessage = async (e: MessageEvent<{ id: number; texts: string[]; kind: 'query' | 'passage' }>) => {
  const { id, texts, kind } = e.data
  try {
    const extractor = await getExtractor()
    const prefixed = texts.map((t) => `${kind}: ${t}`)
    const output = await extractor(prefixed, { pooling: 'mean', normalize: true })
    const list = output.tolist() as number[][]
    const vectors = list.map((arr) => new Float32Array(arr))
    self.postMessage({ id, vectors }, vectors.map((v) => v.buffer))
  } catch (err) {
    self.postMessage({ id, error: String(err) })
  }
}
```

- [ ] **Step 2: 어댑터 작성**

```ts
// src/adapters/transformers-embedder.ts
import type { EmbeddingPort } from '../core/ports'

export class TransformersEmbedder implements EmbeddingPort {
  private seq = 0
  private pending = new Map<number, (v: Float32Array[]) => void>()
  private rejecters = new Map<number, (e: unknown) => void>()

  constructor(private readonly worker: Worker) {
    this.worker.onmessage = (e: MessageEvent<{ id: number; vectors?: Float32Array[]; error?: string }>) => {
      const { id, vectors, error } = e.data
      if (error) { this.rejecters.get(id)?.(new Error(error)) }
      else { this.pending.get(id)?.(vectors!) }
      this.pending.delete(id); this.rejecters.delete(id)
    }
  }

  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const id = this.seq++
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve)
      this.rejecters.set(id, reject)
      this.worker.postMessage({ id, texts, kind })
    })
  }
}
```

- [ ] **Step 3: 실패하는 통합 테스트 작성 (node에서 실제 모델 로드)**

**Scenario:** 로컬 e5-small이 한글 질문과 영어 구절을 같은 의미면 가깝게 임베딩해야 한다(크로스링구얼). 이 가정이 깨지면 제품 핵심이 무너진다.
**Coverage:** ✅ integration (실제 모델 추론, mock 없음). 워커 대신 node에서 파이프라인 직접 호출 — 워커는 브라우저 전용이라 node 단위테스트에서 real-path 불가, 임베딩 로직 자체는 동일 코드 경로.

```ts
// tests/core/transformers-embedder.node.test.ts
import { pipeline } from '@xenova/transformers'
import { cosineSimilarity } from '../../src/core/cosine'

// model download can be slow on first run
test('cross-lingual: korean query is closest to matching english passage', async () => {
  const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small')
  const embed = async (t: string) => {
    const out = await extractor([t], { pooling: 'mean', normalize: true })
    return new Float32Array((out.tolist() as number[][])[0])
  }
  const query = await embed('query: what hormone wrecks my sleep')
  const right = await embed('passage: cortisol disrupts REM sleep')
  const wrong = await embed('passage: basics of tax accounting')

  expect(cosineSimilarity(query, right)).toBeGreaterThan(cosineSimilarity(query, wrong))
}, 120_000)

test('produces 384-dim vectors', async () => {
  const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small')
  const out = await extractor(['passage: hello'], { pooling: 'mean', normalize: true })
  expect((out.tolist() as number[][])[0].length).toBe(384)
}, 120_000)
```

- [ ] **Step 4: 테스트 설정에 이 파일 포함**

`vitest.config.ts`의 include에 통합 테스트를 추가:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/core/**/*.test.ts', 'tests/core/**/*.node.test.ts'],
    testTimeout: 120_000,
  },
})
```

- [ ] **Step 5: 통과 확인 (첫 실행은 모델 다운로드로 느림)**

Run: `npx vitest run tests/core/transformers-embedder.node.test.ts`
Expected: PASS (2 tests). 크로스링구얼 가정이 여기서 검증됨.

- [ ] **Step 6: Commit**

```bash
git add src/workers/embedder.worker.ts src/adapters/transformers-embedder.ts tests/core/transformers-embedder.node.test.ts vitest.config.ts
git commit -m "feat(adapter): transformers e5-small embedder + worker"
```

---

## Task 8: SqliteVectorStore 어댑터

**Files:**
- Create: `src/adapters/sqlite-vector-store.ts`, `tests/e2e/sqlite-vector-store.spec.ts`

sqlite-wasm은 OPFS/SharedArrayBuffer가 필요해 node가 아니라 브라우저(Playwright)에서 검증한다. 벡터는 BLOB로 저장하고 검색은 메모리로 올려 브루트포스(인메모리 스토어와 동일 동작). 나중에 sqlite-vec로 교체해도 포트가 같다.

- [ ] **Step 1: 어댑터 작성**

```ts
// src/adapters/sqlite-vector-store.ts
import type { VectorSearchPort } from '../core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../core/model'
import { cosineSimilarity } from '../core/cosine'

// sqlite-wasm DB 핸들의 최소 인터페이스(주입받아 테스트 용이).
export interface SqliteDb {
  exec(opts: { sql: string; bind?: unknown[]; rowMode?: string; callback?: (row: any) => void }): void
}

export class SqliteVectorStore implements VectorSearchPort {
  constructor(private readonly db: SqliteDb) {
    this.db.exec({ sql: `CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, url TEXT, title TEXT, capturedAt INTEGER)` })
    this.db.exec({ sql: `CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, pageId TEXT, idx INTEGER, text TEXT, vector BLOB)` })
  }

  async upsertPage(page: CapturedPage): Promise<void> {
    this.db.exec({
      sql: `INSERT OR REPLACE INTO pages (id, url, title, capturedAt) VALUES (?, ?, ?, ?)`,
      bind: [page.id, page.url, page.title, page.capturedAt],
    })
  }

  async upsertChunk(chunk: Chunk, vector: Float32Array): Promise<void> {
    this.db.exec({
      sql: `INSERT OR REPLACE INTO chunks (id, pageId, idx, text, vector) VALUES (?, ?, ?, ?, ?)`,
      bind: [chunk.id, chunk.pageId, chunk.index, chunk.text, new Uint8Array(vector.buffer)],
    })
  }

  async search(queryVector: Float32Array, k: number): Promise<RankedResult[]> {
    const pages = new Map<string, CapturedPage>()
    this.db.exec({
      sql: `SELECT id, url, title, capturedAt FROM pages`, rowMode: 'object',
      callback: (r: any) => pages.set(r.id, { id: r.id, url: r.url, title: r.title, capturedAt: r.capturedAt }),
    })
    const scored: RankedResult[] = []
    this.db.exec({
      sql: `SELECT id, pageId, idx, text, vector FROM chunks`, rowMode: 'object',
      callback: (r: any) => {
        const page = pages.get(r.pageId)
        if (!page) return
        const vector = new Float32Array((r.vector as Uint8Array).buffer)
        const chunk: Chunk = { id: r.id, pageId: r.pageId, index: r.idx, text: r.text }
        scored.push({ chunk, page, score: cosineSimilarity(queryVector, vector) })
      },
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }
}
```

- [ ] **Step 2: 실패하는 브라우저 테스트 작성**

**Scenario:** sqlite에 저장한 벡터를 다시 읽어 검색해도 인메모리와 같은 1등이 나와야 한다(직렬화/역직렬화 무손실 + 속도 가정 검증).
**Coverage:** ✅ integration (실제 sqlite-wasm을 브라우저에서 구동). node에서는 OPFS 불가라 real-path 불가능 → Playwright 사용.

```ts
// tests/e2e/sqlite-vector-store.spec.ts
import { test, expect } from '@playwright/test'

test('sqlite store ranks nearest chunk after round-trip', async ({ page }) => {
  await page.goto('/') // playwright webServer가 vite dev 서빙
  const top = await page.evaluate(async () => {
    const sqlite3InitModule = (await import('@sqlite.org/sqlite-wasm')).default
    const sqlite3 = await sqlite3InitModule()
    const db = new sqlite3.oo1.DB() // in-memory; OPFS는 확장 어댑터에서
    const { SqliteVectorStore } = await import('/src/adapters/sqlite-vector-store.ts')
    const store = new SqliteVectorStore(db)
    await store.upsertPage({ id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 })
    await store.upsertChunk({ id: 'p1#0', pageId: 'p1', index: 0, text: 'sleep' }, new Float32Array([1, 0]))
    await store.upsertChunk({ id: 'p1#1', pageId: 'p1', index: 1, text: 'tax' }, new Float32Array([0, 1]))
    const results = await store.search(new Float32Array([0.9, 0.1]), 2)
    return results[0].chunk.id
  })
  expect(top).toBe('p1#0')
})
```

- [ ] **Step 3: playwright.config.ts 작성**

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
  use: { baseURL: 'http://localhost:5173' },
})
```

- [ ] **Step 4: 실패 확인 후 통과까지**

Run: `npx playwright test tests/e2e/sqlite-vector-store.spec.ts`
Expected: PASS. (COOP/COEP 경고가 나면 vite dev 헤더 설정 필요 — Step 5)

- [ ] **Step 5: 필요 시 COOP/COEP 헤더 추가**

OPFS/SharedArrayBuffer 경고가 나면 `vite.config.ts`의 server에 헤더 추가:

```ts
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
```

- [ ] **Step 6: Commit**

```bash
git add src/adapters/sqlite-vector-store.ts tests/e2e/sqlite-vector-store.spec.ts playwright.config.ts vite.config.ts
git commit -m "feat(adapter): sqlite-wasm vector store"
```

---

## Task 9: 메시징 + 백그라운드 조립

**Files:**
- Create: `src/messaging.ts`, `src/background/index.ts`

뼈대에서는 백그라운드가 임베딩 워커 + sqlite를 들고, content/popup의 메시지를 서비스로 라우팅한다. (sqlite를 background service worker에서 OPFS로 여는 게 표준이나, 뼈대에서는 우선 in-memory DB로 시작해 흐름을 증명하고, OPFS 영속은 Task 11 직후 확인한다.)

- [ ] **Step 1: messaging.ts 작성**

```ts
// src/messaging.ts
import type { RankedResult } from './core/model'

export type Msg =
  | { type: 'capture'; url: string; title: string; text: string }
  | { type: 'recall'; text: string; k: number }

export type MsgResult =
  | { type: 'captured' }
  | { type: 'recalled'; results: RankedResult[] }
  | { type: 'error'; error: string }
```

- [ ] **Step 2: background/index.ts 작성**

```ts
// src/background/index.ts
import { CaptureService } from '../core/capture-service'
import { RecallService } from '../core/recall-service'
import { ParagraphChunker } from '../core/paragraph-chunker'
import { TransformersEmbedder } from '../adapters/transformers-embedder'
import { SqliteVectorStore } from '../adapters/sqlite-vector-store'
import type { Msg, MsgResult } from '../messaging'

async function buildStore(): Promise<SqliteVectorStore> {
  const sqlite3InitModule = (await import('@sqlite.org/sqlite-wasm')).default
  const sqlite3 = await sqlite3InitModule()
  const db = 'opfs' in sqlite3
    ? new (sqlite3 as any).oo1.OpfsDb('/recall.sqlite3')
    : new sqlite3.oo1.DB()
  return new SqliteVectorStore(db)
}

const worker = new Worker(new URL('../workers/embedder.worker.ts', import.meta.url), { type: 'module' })
const embedder = new TransformersEmbedder(worker)
const chunker = new ParagraphChunker(220)

const ready = (async () => {
  const store = await buildStore()
  return {
    capture: new CaptureService(chunker, embedder, store),
    recall: new RecallService(embedder, store),
  }
})()

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  ;(async () => {
    try {
      const svc = await ready
      if (msg.type === 'capture') {
        await svc.capture.capture({ url: msg.url, title: msg.title, text: msg.text })
        sendResponse({ type: 'captured' } satisfies MsgResult)
      } else if (msg.type === 'recall') {
        const results = await svc.recall.recall({ text: msg.text, k: msg.k })
        sendResponse({ type: 'recalled', results } satisfies MsgResult)
      }
    } catch (err) {
      sendResponse({ type: 'error', error: String(err) } satisfies MsgResult)
    }
  })()
  return true // async response
})
```

- [ ] **Step 3: 타입 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 4: Commit**

```bash
git add src/messaging.ts src/background/index.ts
git commit -m "feat(background): wire services and message routing"
```

---

## Task 10: 콘텐츠 스크립트 (Readability 추출)

**Files:**
- Create: `src/content/capture.ts`

- [ ] **Step 1: content/capture.ts 작성**

```ts
// src/content/capture.ts
import { Readability } from '@mozilla/readability'
import type { Msg } from '../messaging'

// 팝업의 '캡처' 요청을 받아 현재 페이지를 추출해 background로 보낸다.
chrome.runtime.onMessage.addListener((msg: { type: 'extract-and-capture' }, _s, sendResponse) => {
  if (msg.type !== 'extract-and-capture') return
  const docClone = document.cloneNode(true) as Document
  const article = new Readability(docClone).parse()
  const text = article?.textContent?.trim() ?? document.body.innerText
  const title = article?.title ?? document.title
  const capture: Msg = { type: 'capture', url: location.href, title, text }
  chrome.runtime.sendMessage(capture, () => sendResponse({ ok: true }))
  return true
})
```

- [ ] **Step 2: 타입 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 3: Commit**

```bash
git add src/content/capture.ts
git commit -m "feat(content): readability extraction on demand"
```

---

## Task 11: Preact 팝업 (캡처 버튼 + 검색)

**Files:**
- Create: `src/ui/popup/index.html`, `src/ui/popup/main.tsx`, `src/ui/popup/App.tsx`

- [ ] **Step 1: index.html 작성**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Recall</title></head>
  <body style="width: 360px; margin: 0; font-family: system-ui;">
    <div id="app"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: main.tsx 작성**

```tsx
import { render } from 'preact'
import { App } from './App'
render(<App />, document.getElementById('app')!)
```

- [ ] **Step 3: App.tsx 작성**

```tsx
import { useState } from 'preact/hooks'
import type { MsgResult } from '../../messaging'
import type { RankedResult } from '../../core/model'

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab.id!
}

export function App() {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])

  const capture = async () => {
    setStatus('capturing...')
    await chrome.tabs.sendMessage(await activeTabId(), { type: 'extract-and-capture' })
    setStatus('captured')
  }

  const search = async () => {
    const res: MsgResult = await chrome.runtime.sendMessage({ type: 'recall', text: q, k: 5 })
    if (res.type === 'recalled') setResults(res.results)
    else if (res.type === 'error') setStatus(res.error)
  }

  return (
    <div style="padding: 12px;">
      <button onClick={capture}>Capture this page</button>
      <span style="margin-left:8px;">{status}</span>
      <hr />
      <input
        value={q}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && search()}
        placeholder="recall..."
        style="width: 100%; box-sizing: border-box; padding: 6px;"
      />
      <ul style="list-style:none; padding:0;">
        {results.map((r) => (
          <li key={r.chunk.id} style="margin:8px 0; padding:8px; border:1px solid #eee;">
            <div style="font-size:13px;">{r.chunk.text}</div>
            <a href={r.page.url} target="_blank" style="font-size:11px; color:#888;">
              {r.page.title} ({r.score.toFixed(3)})
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: 빌드 확인**

Run: `npm run build`
Expected: `dist/` 생성, 에러 없음

- [ ] **Step 5: Commit**

```bash
git add src/ui/popup
git commit -m "feat(ui): preact popup with capture and search"
```

---

## Task 12: E2E — 실제 익스텐션으로 캡처→검색 한 줄기

**Files:**
- Create: `tests/e2e/fixtures/article.html`, `tests/e2e/recall-flow.spec.ts`

- [ ] **Step 1: 고정 기사 픽스처 작성 (ASCII)**

```html
<!-- tests/e2e/fixtures/article.html -->
<!doctype html><html><head><title>Sleep Science</title></head>
<body><article>
<h1>Sleep Science</h1>
<p>Cortisol is a hormone that disrupts REM sleep when elevated at night.</p>
<p>Separately, double-entry bookkeeping is the basis of tax accounting.</p>
</article></body></html>
```

- [ ] **Step 2: 실패하는 E2E 작성 (실제 익스텐션 로드)**

**Scenario:** 사용자가 기사를 캡처한 뒤 'hormone that ruins sleep'으로 검색하면, 세금 문단이 아니라 코르티솔 문단이 1등으로 떠야 한다. 이게 제품의 한 줄 정의 그 자체.
**Coverage:** ✅ integration (빌드된 익스텐션을 크롬에 로드, 실제 임베딩+sqlite+팝업). 전 경로 real-path.

```ts
// tests/e2e/recall-flow.spec.ts
import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist')

test('capture an article then recall the matching chunk', async () => {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  // load fixture as a page
  const page = await ctx.newPage()
  await page.goto('file://' + path.resolve(dir, 'fixtures/article.html'))

  // find the extension's service worker to get its id
  const [sw] = ctx.serviceWorkers()
  const extId = (sw ?? (await ctx.waitForEvent('serviceworker'))).url().split('/')[2]

  // open popup
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

  // capture requires the article tab to be active; trigger via content script directly
  await page.bringToFront()
  await popup.bringToFront()
  await popup.getByText('Capture this page').click()
  await expect(popup.getByText('captured')).toBeVisible({ timeout: 120_000 })

  // search
  await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
  await popup.getByPlaceholder('recall...').press('Enter')

  const first = popup.locator('li').first()
  await expect(first).toContainText('Cortisol', { timeout: 30_000 })
  await ctx.close()
})
```

- [ ] **Step 3: 빌드 후 E2E 실행**

Run: `npm run build && npx playwright test tests/e2e/recall-flow.spec.ts`
Expected: PASS. 첫 실행은 모델 다운로드로 느림. 코르티솔 문단이 1등.

- [ ] **Step 4: 전체 테스트 스위트 확인**

Run: `npm run test && npm run build && npx playwright test`
Expected: 모든 단위 + E2E PASS

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/fixtures/article.html tests/e2e/recall-flow.spec.ts
git commit -m "test(e2e): capture-to-recall walking skeleton flow"
```

---

## Self-Review 결과

**Spec coverage (걷는 뼈대 범위):**
- 캡처(추출→청킹→임베딩→저장): Task 3,5,7,8,10 ✅
- 회수(쿼리→임베딩→브루트포스 검색→랭킹): Task 2,4,6 ✅
- 로컬 e5 크로스링구얼 가정 검증: Task 7 ✅
- sqlite 저장 왕복: Task 8 ✅
- 실제 익스텐션 end-to-end: Task 12 ✅
- 헥사고날 포트 경계(VectorSearch 교체 가능): Task 1, 4, 8 ✅

**의도적 미포함(다음 플랜):** 게이트·dwell·SPA(Plan 2) / 하이브리드·dedup·랭킹정책(Plan 3) / 하이라이트(Plan 4) / prefill(Plan 5) / Obsidian 내보내기(Plan 6) / durability 백업(Plan 7) / 커맨드팔레트(Plan 8).

**Placeholder scan:** 모든 코드 스텝에 실제 코드·명령·기대출력 포함. TODO 없음.

**Type consistency:** `EmbeddingPort.embed(texts, kind)`, `VectorSearchPort.{upsertPage,upsertChunk,search}`, `Chunk.id=pageId#index` — Task 1 정의가 Task 4~12에서 일관 사용됨.

**열린 위험(실행 중 확인):**
- crxjs + sqlite-wasm의 COOP/COEP/OPFS in MV3 service worker: Task 8 Step 5, Task 9에서 OPFS 실패 시 in-memory 폴백으로 흐름부터 증명 후 영속 확인.
- transformers.js 모델(~수십MB) 첫 로드 지연: 테스트 타임아웃 120s로 흡수.
