# English-only Ask to Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recall을 영어 전용 검색 앱으로 바꾸고, BGE 영어 임베딩 모델을 Golden set으로 고른 뒤, Cloudflare R2에서 임베딩 모델과 WebLLM 모델을 받아 Ask to Recall 답변 기능을 만든다.

**Architecture:** 검색은 계속 `EmbeddingPort`와 `VectorSearchPort`를 쓴다. 모델 파일은 `ModelArtifactStore`가 R2 manifest를 읽고 로컬 캐시에 저장한 뒤 해시를 확인한다. Ask to Recall은 `RecallService`로 Chunk를 넉넉히 찾고, `AnswerGeneratorPort`가 그 Chunk만 보고 답을 만든다.

**Tech Stack:** TypeScript, Preact, Vitest, Playwright, `@huggingface/transformers`, WebLLM, SQLite-WASM, Cloudflare R2, Node.js scripts.

---

## Scope Split

이 계획은 네 묶음이다.

1. 영어 전용 정리
2. BGE 후보 평가와 캐시
3. R2 모델 파일 배달
4. Ask to Recall, WebLLM, 로딩 UX

각 묶음은 테스트와 커밋을 따로 가진다.

## File Map

**Create**

- `src/core/model-artifacts.ts`: 모델 manifest, 파일 해시, 캐시 키를 다루는 순수 함수.
- `src/adapters/browser-model-artifact-store.ts`: 브라우저에서 R2 모델 파일을 받고 Cache Storage에 저장한다.
- `src/adapters/node-model-artifact-store.mjs`: eval과 업로드 준비에서 쓰는 Node 캐시 저장소.
- `src/core/ask-service.ts`: Chunk 검색 결과를 답변 입력으로 바꾸고 답을 요청한다.
- `src/core/answer-generator.ts`: WebLLM 어댑터가 따라야 하는 타입.
- `src/offscreen/webllm-answer-generator.ts`: 실제 WebLLM 답변 생성기.
- `scripts/r2-model-manifest.mjs`: 로컬 모델 폴더에서 R2용 manifest를 만든다.
- `scripts/upload-r2-models.mjs`: manifest와 모델 파일을 R2에 올린다.
- `eval/english-golden.json`: 영어 전용 Golden set.
- `eval/model-candidates.json`: BGE 후보 목록.
- `tests/core/model-artifacts.test.ts`
- `tests/core/ask-service.test.ts`
- `tests/core/english-only.test.ts`
- `tests/core/bge-eval-config.test.ts`
- `tests/core/webllm-answer-generator.test.ts`

**Modify**

- `package.json`: 모델 평가, manifest 생성, R2 업로드, WebLLM 의존성 명령을 추가한다.
- `scripts/fetch-model.mjs`: Granite 전용 이름을 없애고 새 artifact 캐시를 쓰게 바꾼다.
- `eval/run.mjs`: 영어 Golden set과 후보 모델 반복 실행을 지원한다.
- `eval/lib/embed-node.mjs`: BGE 후보별 캐시 키와 모델 파일명을 명확히 한다.
- `src/offscreen/webgpu-embedder.ts`: 모델 ID를 `granite`에서 선택된 BGE artifact로 바꾼다.
- `src/core/embed-version.ts`: BGE 선택 뒤 버전 문자열을 바꾼다.
- `src/ui/sidepanel/SearchTab.tsx`: Search와 Ask UI를 분리한다.
- `src/ui/sidepanel/strings.ts`: 영어 전용 문자열과 Ask 문자열을 추가한다.
- `public/_locales/en/messages.json`: 영어 문자열만 유지한다.
- `manifest.config.ts`: `_locales/ko` 제거 뒤 default locale을 영어만 남긴다.
- `README.md`, `docs/store/*`: privacy 문구를 새 약속에 맞게 바꾼다.

---

### Task 1: 영어 전용으로 제품 표면 정리

**Files:**

- Modify: `manifest.config.ts`
- Modify: `src/ui/sidepanel/strings.ts`
- Delete: `public/_locales/ko/messages.json`
- Modify: `tests/core/messages-ko.test.ts`
- Modify: `tests/core/messages-ko-render.test.ts`
- Delete: `tests/e2e/ko-locale.spec.ts`
- Create: `tests/core/english-only.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/english-only.test.ts`.

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/core/english-only.test.ts
```

Expected: FAIL. `public/_locales/ko/messages.json` and Korean message tests still exist.

- [ ] **Step 3: Remove Korean locale files and Korean tests**

Delete these files:

```text
public/_locales/ko/messages.json
tests/core/messages-ko.test.ts
tests/core/messages-ko-render.test.ts
tests/e2e/ko-locale.spec.ts
```

Update the top comment in `src/ui/sidepanel/strings.ts` to this:

```typescript
// UI strings facade. Source of truth: public/_locales/en/messages.json.
// Recall is English-only, so call sites use this facade instead of branching on locale.
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run tests/core/english-only.test.ts tests/core/strings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add manifest.config.ts src/ui/sidepanel/strings.ts public/_locales tests/core
git commit -m "chore: make extension english-only"
```

---

### Task 2: 영어 Golden set과 BGE 후보 목록 만들기

**Files:**

- Create: `eval/english-golden.json`
- Create: `eval/model-candidates.json`
- Modify: `eval/run.mjs`
- Create: `tests/core/bge-eval-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/bge-eval-config.test.ts`.

```typescript
import { readFileSync } from 'node:fs'

// Scenario: 임베딩 모델을 감으로 고르면 검색 품질이 나빠져도 모른다.
// Coverage: ✅ integration
test('english golden set contains only english-to-english cases', () => {
  const golden = JSON.parse(readFileSync('eval/english-golden.json', 'utf8')) as Array<{ combo: string; query: string }>
  expect(golden.length).toBeGreaterThanOrEqual(12)
  expect(golden.every((row) => row.combo === 'EN->EN')).toBe(true)
  expect(golden.every((row) => /^[\x00-\x7F]*$/.test(row.query))).toBe(true)
})

// Scenario: 큰 모델도 한 번은 숫자로 비교해야 선택 근거가 생긴다.
// Coverage: ✅ integration
test('bge candidate list includes small base and large', () => {
  const candidates = JSON.parse(readFileSync('eval/model-candidates.json', 'utf8')) as Array<{ id: string; prefix: string }>
  expect(candidates.map((c) => c.id)).toEqual([
    'BAAI/bge-small-en-v1.5',
    'BAAI/bge-base-en-v1.5',
    'BAAI/bge-large-en-v1.5',
  ])
  expect(candidates.every((c) => c.prefix === 'bge')).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/core/bge-eval-config.test.ts
```

Expected: FAIL. The files do not exist yet.

- [ ] **Step 3: Create `eval/english-golden.json`**

Start by copying only EN->EN rows from `eval/golden.json`. Add enough English queries to reach at least 12 rows.

The shape must be:

```json
[
  {
    "scenario": "EN1",
    "combo": "EN->EN",
    "query": "powerhouse of the cell",
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Mitochondrion"]
  },
  {
    "scenario": "EN2",
    "combo": "EN->EN",
    "query": "hormone that ruins sleep",
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Cortisol"]
  }
]
```

- [ ] **Step 4: Create `eval/model-candidates.json`**

```json
[
  {
    "id": "BAAI/bge-small-en-v1.5",
    "dtype": "q8",
    "prefix": "bge",
    "modelFile": "",
    "expectedSizeMB": 34
  },
  {
    "id": "BAAI/bge-base-en-v1.5",
    "dtype": "q8",
    "prefix": "bge",
    "modelFile": "",
    "expectedSizeMB": 110
  },
  {
    "id": "BAAI/bge-large-en-v1.5",
    "dtype": "q8",
    "prefix": "bge",
    "modelFile": "",
    "expectedSizeMB": 330
  }
]
```

- [ ] **Step 5: Teach eval runner the English set**

In `eval/run.mjs`, change the default golden selection to:

```javascript
const goldenPath =
  args.find((a) => a.startsWith('--golden='))?.split('=')[1] ??
  (ci ? 'eval/ci-golden.json' : 'eval/english-golden.json')
```

Keep `--golden=<path>` working.

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
npx vitest run tests/core/bge-eval-config.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add eval/english-golden.json eval/model-candidates.json eval/run.mjs tests/core/bge-eval-config.test.ts
git commit -m "test(eval): add english golden set and bge candidates"
```

---

### Task 3: eval 캐시가 모델을 매번 다시 받지 않게 잠그기

**Files:**

- Modify: `eval/lib/embed-node.mjs`
- Create: `tests/core/eval-cache-key.test.ts`

- [ ] **Step 1: Export a pure cache key helper**

In `eval/lib/embed-node.mjs`, add this exported function near the cache code:

```javascript
export function embedCacheKey({ model, dtype, modelFile, prefix, mrlDim, kind, text }) {
  return createHash('sha256')
    .update(model).update('\0')
    .update(dtype).update('\0')
    .update(modelFile).update('\0')
    .update(prefix).update('\0')
    .update(String(mrlDim)).update('\0')
    .update(kind).update('\n')
    .update(text)
    .digest('hex')
}
```

Then change `cachePath` to call it:

```javascript
function cachePath(kind, text) {
  const h = embedCacheKey({
    model: MODEL,
    dtype: DTYPE,
    modelFile: MODEL_FILE,
    prefix: PREFIX,
    mrlDim: MRL_DIM,
    kind,
    text,
  })
  return resolve(CACHE_DIR, `${h}.f32`)
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/core/eval-cache-key.test.ts`.

```typescript
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
```

- [ ] **Step 3: Run test to verify it passes**

Run:

```bash
npx vitest run tests/core/eval-cache-key.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add eval/lib/embed-node.mjs tests/core/eval-cache-key.test.ts
git commit -m "test(eval): lock model-specific embedding cache keys"
```

---

### Task 4: BGE 후보를 한 번에 평가하는 스크립트 추가

**Files:**

- Modify: `package.json`
- Create: `eval/run-candidates.mjs`

- [ ] **Step 1: Create `eval/run-candidates.mjs`**

```javascript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const candidates = JSON.parse(readFileSync('eval/model-candidates.json', 'utf8'))
mkdirSync('eval/scorecards', { recursive: true })

const results = []
for (const c of candidates) {
  const safe = c.id.replaceAll('/', '__')
  const env = {
    ...process.env,
    EVAL_MODEL: c.id,
    EVAL_DTYPE: c.dtype,
    EVAL_PREFIX: c.prefix,
    EVAL_MODEL_FILE: c.modelFile ?? '',
  }
  const run = spawnSync(
    'npx',
    ['vite-node', 'eval/run.mjs', '--strip', '--min-prose=0.35', '--golden=eval/english-golden.json'],
    { stdio: 'inherit', env },
  )
  if (run.status !== 0) process.exit(run.status ?? 1)
  const score = JSON.parse(readFileSync('eval/last-scorecard.json', 'utf8'))
  const out = `eval/scorecards/${safe}.json`
  writeFileSync(out, JSON.stringify(score, null, 2) + '\n')
  results.push({ id: c.id, scorecard: out, agg: score.agg })
}

writeFileSync('eval/scorecards/summary.json', JSON.stringify(results, null, 2) + '\n')
console.log('\n[eval] wrote eval/scorecards/summary.json')
```

- [ ] **Step 2: Add package scripts**

In `package.json`, add:

```json
"eval:bge": "vite-node eval/run-candidates.mjs",
"eval:english": "vite-node eval/run.mjs -- --strip --min-prose=0.35 --golden=eval/english-golden.json"
```

- [ ] **Step 3: Run candidate eval once**

Run:

```bash
npm run eval:bge
```

Expected: PASS. The first run may download models into `eval/.cache`. Later runs must reuse the cache.

- [ ] **Step 4: Commit scorecards**

Commit only scorecards and config. Do not commit `eval/.cache`.

```bash
git add package.json eval/run-candidates.mjs eval/scorecards eval/model-candidates.json eval/english-golden.json
git commit -m "eval: compare bge embedding candidates"
```

---

### Task 5: 모델 artifact manifest와 해시 검증

**Files:**

- Create: `src/core/model-artifacts.ts`
- Create: `tests/core/model-artifacts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/model-artifacts.test.ts`.

```typescript
import { describe, expect, test } from 'vitest'
import { buildArtifactCacheKey, verifyArtifactBytes, type ModelManifest } from '../../src/core/model-artifacts'

const manifest: ModelManifest = {
  id: 'bge-base-en-v1.5-q8',
  kind: 'embedding',
  version: 'v1',
  baseUrl: 'https://models.example.test/models/embedding/bge-base-en-v1.5/q8/',
  files: [
    {
      path: 'config.json',
      size: 2,
      sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    },
  ],
}

describe('model artifacts', () => {
  // Scenario: 같은 모델 파일을 이미 받았으면 다시 받지 않아야 한다.
  // Coverage: ✅ integration
  test('cache key includes model id version path and hash', () => {
    expect(buildArtifactCacheKey(manifest, manifest.files[0])).toBe(
      'model-artifact:bge-base-en-v1.5-q8:v1:config.json:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    )
  })

  // Scenario: 깨진 R2 파일을 그대로 쓰면 검색과 답변이 틀어진다.
  // Coverage: ✅ integration
  test('verifies sha256 before model use', async () => {
    const ok = new TextEncoder().encode('{}')
    await expect(verifyArtifactBytes(ok, manifest.files[0])).resolves.toBeUndefined()
    const bad = new TextEncoder().encode('x')
    await expect(verifyArtifactBytes(bad, manifest.files[0])).rejects.toThrow(/SHA-256 mismatch/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/core/model-artifacts.test.ts
```

Expected: FAIL. `src/core/model-artifacts.ts` does not exist.

- [ ] **Step 3: Implement `src/core/model-artifacts.ts`**

```typescript
export type ModelKind = 'embedding' | 'webllm'

export interface ModelArtifactFile {
  path: string
  size: number
  sha256: string
}

export interface ModelManifest {
  id: string
  kind: ModelKind
  version: string
  baseUrl: string
  files: ModelArtifactFile[]
}

export function buildArtifactCacheKey(manifest: ModelManifest, file: ModelArtifactFile): string {
  return `model-artifact:${manifest.id}:${manifest.version}:${file.path}:${file.sha256}`
}

export function fileUrl(manifest: ModelManifest, file: ModelArtifactFile): string {
  return new URL(file.path, manifest.baseUrl).toString()
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function verifyArtifactBytes(bytes: Uint8Array, file: ModelArtifactFile): Promise<void> {
  if (bytes.byteLength !== file.size) {
    throw new Error(`size mismatch for ${file.path}: expected ${file.size}, got ${bytes.byteLength}`)
  }
  const actual = await sha256Hex(bytes)
  if (actual !== file.sha256) {
    throw new Error(`SHA-256 mismatch for ${file.path}: expected ${file.sha256}, got ${actual}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run tests/core/model-artifacts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/model-artifacts.ts tests/core/model-artifacts.test.ts
git commit -m "feat(core): verify model artifact manifests"
```

---

### Task 6: R2 manifest 생성 스크립트

**Files:**

- Create: `scripts/r2-model-manifest.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/r2-model-manifest.mjs`**

```javascript
#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const [root, id, kind, version, baseUrl] = process.argv.slice(2)
if (!root || !id || !kind || !version || !baseUrl) {
  console.error('usage: node scripts/r2-model-manifest.mjs <root> <id> <embedding|webllm> <version> <baseUrl>')
  process.exit(1)
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (b) => h.update(b))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

const files = []
for (const abs of walk(root)) {
  const rel = relative(root, abs).replaceAll('\\', '/')
  const st = statSync(abs)
  files.push({ path: rel, size: st.size, sha256: await sha256(abs) })
}

files.sort((a, b) => a.path.localeCompare(b.path))
const manifest = { id, kind, version, baseUrl, files }
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`[manifest] wrote ${join(root, 'manifest.json')} (${files.length} files)`)
```

- [ ] **Step 2: Add package script**

In `package.json`, add:

```json
"models:manifest": "node scripts/r2-model-manifest.mjs"
```

- [ ] **Step 3: Smoke-test manifest generation**

Run:

```bash
node scripts/r2-model-manifest.mjs public/models/granite granite-test embedding v1 https://example.test/models/granite/
```

Expected: `public/models/granite/manifest.json` is created.

Remove the smoke output before commit if Granite is not the chosen final artifact:

```bash
rm -f public/models/granite/manifest.json
```

- [ ] **Step 4: Commit**

```bash
git add scripts/r2-model-manifest.mjs package.json
git commit -m "chore(models): generate r2 model manifests"
```

---

### Task 7: 선택된 BGE 모델로 임베딩 버전과 로더 교체

**Files:**

- Modify: `src/core/embed-version.ts`
- Modify: `src/offscreen/webgpu-embedder.ts`
- Modify: `tests/core/embed-version.test.ts`
- Modify: `tests/core/embedding-model.node.test.ts`

- [ ] **Step 1: Decide the model from scorecards**

Open `eval/scorecards/summary.json`.

Pick the model with the best balance of:

- `MRR`
- `precisionAt1`
- model file size
- load time
- memory risk

Expected first choice: `bge-base-en-v1.5` unless `bge-large-en-v1.5` wins by a large margin.

- [ ] **Step 2: Write the failing version test**

Update `tests/core/embed-version.test.ts`:

```typescript
import { needsReindex, EMBED_MODEL_VERSION } from '../../src/core/embed-version'

// Scenario: 모델이 Granite에서 BGE로 바뀌면 기존 벡터는 새 모델과 비교할 수 없다.
// Coverage: ✅ integration
test('needsReindex is true for a null or legacy stored version, false when equal', () => {
  expect(needsReindex(null, EMBED_MODEL_VERSION)).toBe(true)
  expect(needsReindex('granite-107m-r1-q8-v1', EMBED_MODEL_VERSION)).toBe(true)
  expect(needsReindex(EMBED_MODEL_VERSION, EMBED_MODEL_VERSION)).toBe(false)
})

// Scenario: 버전 문자열 오타는 재색인을 건너뛰게 만들 수 있다.
// Coverage: ✅ integration
test('version id is the selected bge base q8 identifier', () => {
  expect(EMBED_MODEL_VERSION).toBe('bge-base-en-v1.5-q8-v1')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
npx vitest run tests/core/embed-version.test.ts
```

Expected: FAIL. Version is still Granite.

- [ ] **Step 4: Update version**

In `src/core/embed-version.ts`:

```typescript
export const EMBED_MODEL_VERSION = 'bge-base-en-v1.5-q8-v1'
```

- [ ] **Step 5: Update embedder model id**

In `src/offscreen/webgpu-embedder.ts`, replace:

```typescript
const MODEL_ID = 'granite'
```

with:

```typescript
const MODEL_ID = 'bge-base-en-v1.5'
```

Keep `dtype: 'q8'`.

If the chosen ONNX file does not match transformers.js q8 naming, add the exact `model_file_name` option in both WebGPU and WASM pipeline calls.

- [ ] **Step 6: Update node model test**

Change `tests/core/embedding-model.node.test.ts` so it checks English-only BGE behavior:

```typescript
test('english query is closest to matching english passage', async () => {
  const embed = await loadEmbed()
  const query = await embed('what hormone wrecks my sleep')
  const right = await embed('cortisol disrupts REM sleep')
  const wrong = await embed('basics of tax accounting')

  expect(cosineSimilarity(query, right)).toBeGreaterThan(cosineSimilarity(query, wrong))
}, 120_000)

test('produces 768-dim vectors for bge base', async () => {
  const embed = await loadEmbed()
  const v = await embed('hello')
  expect(v.length).toBe(768)
}, 120_000)
```

Delete the Korean query test.

- [ ] **Step 7: Run tests**

Run:

```bash
npx vitest run tests/core/embed-version.test.ts tests/core/embedding-model.node.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/embed-version.ts src/offscreen/webgpu-embedder.ts tests/core/embed-version.test.ts tests/core/embedding-model.node.test.ts
git commit -m "feat(embed): switch to selected bge english model"
```

---

### Task 8: Ask service core 만들기

**Files:**

- Create: `src/core/answer-generator.ts`
- Create: `src/core/ask-service.ts`
- Create: `tests/core/ask-service.test.ts`
- Modify: `src/core/model.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/ask-service.test.ts`.

```typescript
import { AskService } from '../../src/core/ask-service'
import type { AnswerGeneratorPort } from '../../src/core/answer-generator'
import type { EmbeddingPort, VectorSearchPort } from '../../src/core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../../src/core/model'

const page: CapturedPage = { id: 'p1', url: 'https://example.com/sleep', title: 'Sleep', capturedAt: 1 }
const chunk = (id: string, text: string): RankedResult => ({
  chunk: { id, pageId: 'p1', index: Number(id.split('#')[1]), text } as Chunk,
  page,
  score: 1,
})

// Scenario: Ask가 너무 적은 Chunk만 보면 답변 모델이 근거 없는 말을 만들 수 있다.
// Coverage: ✅ integration
test('ask retrieves more chunks than search and sends a bounded context to generator', async () => {
  const embedder: EmbeddingPort = {
    embed: async () => [new Float32Array([1, 0])],
  }
  const results = Array.from({ length: 12 }, (_, i) => chunk(`p1#${i}`, `context ${i}`))
  const store: VectorSearchPort = {
    upsertPage: async () => undefined,
    putChunks: async () => undefined,
    setVector: async () => undefined,
    pendingChunks: async () => [],
    hasPage: async () => false,
    pagePending: async () => false,
    recentPages: async () => [],
    pagesWithVectors: async () => [],
    clearVectorsForPage: async () => undefined,
    deletePagesByHost: async () => undefined,
    search: async (_vector, _text, k) => results.slice(0, k),
  }
  let seen: string[] = []
  const generator: AnswerGeneratorPort = {
    answer: async ({ chunks }) => {
      seen = chunks.map((c) => c.chunk.text)
      return { text: 'Cortisol can hurt sleep.', citedChunkIds: chunks.slice(0, 3).map((c) => c.chunk.id) }
    },
  }

  const svc = new AskService(embedder, store, generator)
  const answer = await svc.ask({ text: 'what wrecks sleep?', retrieveK: 12, contextK: 8 })

  expect(seen).toHaveLength(8)
  expect(answer.sources).toHaveLength(3)
})

// Scenario: 저장된 근거가 없는데 답을 지어내면 Recall의 신뢰가 깨진다.
// Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 계약을 가진 fake generator를 쓴다.
test('ask returns not-found answer when retrieval has no chunks', async () => {
  const embedder: EmbeddingPort = { embed: async () => [new Float32Array([1, 0])] }
  const store: VectorSearchPort = {
    upsertPage: async () => undefined,
    putChunks: async () => undefined,
    setVector: async () => undefined,
    pendingChunks: async () => [],
    hasPage: async () => false,
    pagePending: async () => false,
    recentPages: async () => [],
    pagesWithVectors: async () => [],
    clearVectorsForPage: async () => undefined,
    deletePagesByHost: async () => undefined,
    search: async () => [],
  }
  const generator: AnswerGeneratorPort = {
    answer: async () => ({ text: 'should not be called', citedChunkIds: [] }),
  }

  const svc = new AskService(embedder, store, generator)
  const answer = await svc.ask({ text: 'unknown thing', retrieveK: 12, contextK: 8 })

  expect(answer.text).toBe('I could not find that in your saved pages.')
  expect(answer.sources).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/core/ask-service.test.ts
```

Expected: FAIL. `AskService` and `AnswerGeneratorPort` do not exist.

- [ ] **Step 3: Add core types**

Create `src/core/answer-generator.ts`:

```typescript
import type { RankedResult } from './model'

export interface AnswerRequest {
  question: string
  chunks: RankedResult[]
}

export interface AnswerDraft {
  text: string
  citedChunkIds: string[]
}

export interface AnswerGeneratorPort {
  answer(request: AnswerRequest): Promise<AnswerDraft>
}
```

Add to `src/core/model.ts`:

```typescript
export interface AskQuery {
  text: string
  retrieveK: number
  contextK: number
}

export interface AskAnswer {
  text: string
  sources: RankedResult[]
}
```

- [ ] **Step 4: Implement `AskService`**

Create `src/core/ask-service.ts`:

```typescript
import type { AnswerGeneratorPort } from './answer-generator'
import type { AskAnswer, AskQuery, RankedResult } from './model'
import type { EmbeddingPort, VectorSearchPort } from './ports'

const NOT_FOUND = 'I could not find that in your saved pages.'

export class AskService {
  constructor(
    private readonly embedder: EmbeddingPort,
    private readonly store: VectorSearchPort,
    private readonly generator: AnswerGeneratorPort,
  ) {}

  async ask(query: AskQuery): Promise<AskAnswer> {
    const [vector] = await this.embedder.embed([query.text], 'query')
    const retrieved = await this.store.search(vector, query.text, query.retrieveK)
    if (retrieved.length === 0) return { text: NOT_FOUND, sources: [] }

    const chunks = retrieved.slice(0, query.contextK)
    const draft = await this.generator.answer({ question: query.text, chunks })
    const sourceIds = new Set(draft.citedChunkIds)
    const sources: RankedResult[] = chunks.filter((r) => sourceIds.has(r.chunk.id)).slice(0, 5)
    return { text: draft.text, sources }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npx vitest run tests/core/ask-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/answer-generator.ts src/core/ask-service.ts src/core/model.ts tests/core/ask-service.test.ts
git commit -m "feat(core): add ask to recall service"
```

---

### Task 9: messaging과 offscreen에 Ask 경로 연결

**Files:**

- Modify: `src/messaging.ts`
- Modify: `src/background/index.ts`
- Modify: `src/offscreen/offscreen.ts`
- Modify: `tests/core/sqlite-worker-client.test.ts`

- [ ] **Step 1: Add message types**

In `src/messaging.ts`, add:

```typescript
| { type: 'ask'; text: string; retrieveK: number; contextK: number }
```

to `Msg`.

Add:

```typescript
| { type: 'asked'; answer: import('./core/model').AskAnswer }
```

to `MsgResult`.

- [ ] **Step 2: Wire background relay**

In `src/background/index.ts`, handle:

```typescript
if (msg.type === 'ask') {
  const r = await callOffscreen<{ answer: import('../core/model').AskAnswer }>({
    op: 'ask',
    text: msg.text,
    retrieveK: msg.retrieveK,
    contextK: msg.contextK,
  })
  sendResponse({ type: 'asked', answer: r.answer })
  return
}
```

- [ ] **Step 3: Wire offscreen op with fake generator first**

In `src/offscreen/offscreen.ts`, create a temporary local generator:

```typescript
const localAnswerGenerator: AnswerGeneratorPort = {
  answer: async ({ chunks }) => ({
    text: chunks[0]?.chunk.text ?? 'I could not find that in your saved pages.',
    citedChunkIds: chunks.slice(0, 3).map((r) => r.chunk.id),
  }),
}
```

Then add the `ask` op:

```typescript
if (op === 'ask') {
  const text = String(p.text ?? '')
  const retrieveK = Number(p.retrieveK ?? 12)
  const contextK = Number(p.contextK ?? 8)
  const ask = new AskService(embedder, store, localAnswerGenerator)
  return { answer: await ask.ask({ text, retrieveK, contextK }) }
}
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run test -- tests/core/ask-service.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/messaging.ts src/background/index.ts src/offscreen/offscreen.ts tests/core/sqlite-worker-client.test.ts
git commit -m "feat(runtime): route ask requests through offscreen"
```

---

### Task 10: WebLLM Llama answer generator

**Files:**

- Modify: `package.json`
- Create: `src/offscreen/webllm-answer-generator.ts`
- Create: `tests/core/webllm-answer-generator.test.ts`
- Modify: `src/offscreen/offscreen.ts`

- [ ] **Step 1: Add WebLLM dependency**

Run:

```bash
npm install @mlc-ai/web-llm
```

Expected: `package.json` and `package-lock.json` update.

- [ ] **Step 2: Write prompt builder test**

Create `tests/core/webllm-answer-generator.test.ts`.

```typescript
import { buildAskMessages } from '../../src/offscreen/webllm-answer-generator'
import type { RankedResult } from '../../src/core/model'

const result: RankedResult = {
  chunk: { id: 'p1#0', pageId: 'p1', index: 0, text: 'Cortisol can disrupt REM sleep.' },
  page: { id: 'p1', url: 'https://example.com/sleep', title: 'Sleep article', capturedAt: 1 },
  score: 1,
}

// Scenario: WebLLM이 저장된 근거 밖의 답을 만들면 Recall의 신뢰가 깨진다.
// Coverage: ✅ integration
test('ask prompt tells model to answer only from chunks', () => {
  const messages = buildAskMessages('what hurts sleep?', [result])
  const joined = messages.map((m) => m.content).join('\n')
  expect(joined).toContain('Use only the saved chunks')
  expect(joined).toContain('I could not find that in your saved pages.')
  expect(joined).toContain('[p1#0]')
  expect(joined).toContain('Cortisol can disrupt REM sleep.')
})
```

- [ ] **Step 3: Implement prompt builder and generator**

Create `src/offscreen/webllm-answer-generator.ts`:

```typescript
import type { ChatCompletionMessageParam, MLCEngineInterface } from '@mlc-ai/web-llm'
import type { AnswerDraft, AnswerGeneratorPort, AnswerRequest } from '../core/answer-generator'
import type { RankedResult } from '../core/model'

export const LLAMA_ASK_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC'

export function buildAskMessages(question: string, chunks: RankedResult[]): ChatCompletionMessageParam[] {
  const context = chunks
    .map((r) => `[${r.chunk.id}] ${r.page.title}\n${r.chunk.text}`)
    .join('\n\n')
  return [
    {
      role: 'system',
      content:
        'Use only the saved chunks to answer. If the chunks do not answer the question, say exactly: I could not find that in your saved pages. Cite chunk ids in square brackets.',
    },
    {
      role: 'user',
      content: `Question: ${question}\n\nSaved chunks:\n${context}`,
    },
  ]
}

export class WebLlmAnswerGenerator implements AnswerGeneratorPort {
  constructor(private readonly engine: MLCEngineInterface) {}

  async answer(request: AnswerRequest): Promise<AnswerDraft> {
    const completion = await this.engine.chat.completions.create({
      messages: buildAskMessages(request.question, request.chunks),
      temperature: 0,
      max_tokens: 220,
    })
    const text = completion.choices[0]?.message.content?.trim() ?? 'I could not find that in your saved pages.'
    const ids = new Set(request.chunks.map((r) => r.chunk.id))
    const citedChunkIds = [...text.matchAll(/\[([^\]]+)\]/g)]
      .map((m) => m[1])
      .filter((id) => ids.has(id))
    return { text, citedChunkIds }
  }
}
```

- [ ] **Step 4: Run test**

Run:

```bash
npx vitest run tests/core/webllm-answer-generator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Replace fake offscreen generator**

In `src/offscreen/offscreen.ts`, create the WebLLM engine lazily and pass `WebLlmAnswerGenerator` into `AskService`.

Use Llama first:

```typescript
const selectedAskModel = LLAMA_ASK_MODEL
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/offscreen/webllm-answer-generator.ts src/offscreen/offscreen.ts tests/core/webllm-answer-generator.test.ts
git commit -m "feat(ask): answer with webllm llama"
```

---

### Task 11: Ask UI와 로딩 UX

**Files:**

- Modify: `src/ui/sidepanel/SearchTab.tsx`
- Modify: `src/ui/sidepanel/strings.ts`
- Modify: `public/_locales/en/messages.json`
- Modify: `tests/e2e/hybrid-search.spec.ts`
- Create: `tests/core/ask-ui-strings.test.ts`

- [ ] **Step 1: Add string test**

Create `tests/core/ask-ui-strings.test.ts`.

```typescript
import en from '../../public/_locales/en/messages.json'

// Scenario: 모델 다운로드가 길어질 때 아무 표시가 없으면 사용자는 앱이 고장났다고 느낀다.
// Coverage: ✅ integration
test('ask and model loading strings exist', () => {
  const keys = Object.keys(en)
  expect(keys).toContain('askButtonLabel')
  expect(keys).toContain('askLoading')
  expect(keys).toContain('modelDownloading')
  expect(keys).toContain('modelVerifying')
  expect(keys).toContain('modelOffline')
  expect(keys).toContain('modelStorageFull')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/core/ask-ui-strings.test.ts
```

Expected: FAIL. Strings do not exist.

- [ ] **Step 3: Add strings**

Add to `public/_locales/en/messages.json`:

```json
"askButtonLabel": { "message": "Ask" },
"askLoading": { "message": "Reading your saved pages..." },
"modelDownloading": { "message": "Downloading model..." },
"modelVerifying": { "message": "Checking model files..." },
"modelOffline": { "message": "Connect to the internet to download the model." },
"modelStorageFull": { "message": "Not enough browser storage for the model." }
```

Add these fields to `UIStrings` and `t` in `src/ui/sidepanel/strings.ts`.

- [ ] **Step 4: Update SearchTab**

Add a second button next to Search:

```tsx
<button class="searchbtn" aria-label={t.askButtonLabel} onClick={ask}>
  {t.askButtonLabel}
</button>
```

Use:

```typescript
const ASK_RETRIEVE_K = 12
const ASK_CONTEXT_K = 8
```

The `ask` function sends:

```typescript
const res: MsgResult = await chrome.runtime.sendMessage({
  type: 'ask',
  text: q,
  retrieveK: ASK_RETRIEVE_K,
  contextK: ASK_CONTEXT_K,
})
```

Render the answer text above the source cards.

- [ ] **Step 5: Run tests**

Run:

```bash
npx vitest run tests/core/ask-ui-strings.test.ts tests/core/strings.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/sidepanel/SearchTab.tsx src/ui/sidepanel/strings.ts public/_locales/en/messages.json tests/core/ask-ui-strings.test.ts tests/e2e/hybrid-search.spec.ts
git commit -m "feat(ui): add ask to recall controls and loading copy"
```

---

### Task 12: Gemma WebLLM 후보 추가

**Files:**

- Modify: `src/offscreen/webllm-answer-generator.ts`
- Create: `tests/core/webllm-model-options.test.ts`

- [ ] **Step 1: Write model option test**

Create `tests/core/webllm-model-options.test.ts`.

```typescript
import { ASK_MODEL_CANDIDATES } from '../../src/offscreen/webllm-answer-generator'

// Scenario: Llama만 실험하면 Gemma와 비교했다는 근거가 없다.
// Coverage: ✅ integration
test('ask model candidates are llama first then gemma', () => {
  expect(ASK_MODEL_CANDIDATES).toEqual([
    'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    'gemma3-1b-it-q4f16_1-MLC',
  ])
})
```

- [ ] **Step 2: Add candidate list**

In `src/offscreen/webllm-answer-generator.ts`:

```typescript
export const ASK_MODEL_CANDIDATES = [
  'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  'gemma3-1b-it-q4f16_1-MLC',
] as const

export const LLAMA_ASK_MODEL = ASK_MODEL_CANDIDATES[0]
```

- [ ] **Step 3: Run test**

Run:

```bash
npx vitest run tests/core/webllm-model-options.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/offscreen/webllm-answer-generator.ts tests/core/webllm-model-options.test.ts
git commit -m "feat(ask): register gemma webllm candidate"
```

---

### Task 13: R2 업로드 스크립트

**Files:**

- Create: `scripts/upload-r2-models.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create script**

Create `scripts/upload-r2-models.mjs`:

```javascript
#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const [bucket, root, prefix] = process.argv.slice(2)
if (!bucket || !root || !prefix) {
  console.error('usage: node scripts/upload-r2-models.mjs <bucket> <root> <prefix>')
  process.exit(1)
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

for (const file of walk(root)) {
  const key = `${prefix}/${relative(root, file).replaceAll('\\', '/')}`
  const run = spawnSync('npx', ['wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--file', file], {
    stdio: 'inherit',
  })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
```

- [ ] **Step 2: Add script**

In `package.json`, add:

```json
"models:upload-r2": "node scripts/upload-r2-models.mjs"
```

- [ ] **Step 3: Do not upload during tests**

No automated test should hit Cloudflare. The script is manually run after model files are ready.

Run only syntax check:

```bash
node --check scripts/upload-r2-models.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/upload-r2-models.mjs package.json
git commit -m "chore(models): add r2 upload script"
```

---

### Task 14: README와 store 문구 갱신

**Files:**

- Modify: `README.md`
- Modify: `docs/store/listing-en.md`
- Modify: `docs/store/privacy-policy.md`
- Modify: `docs/store/data-safety.md`

- [ ] **Step 1: Replace old promise**

Remove claims like:

```text
Zero network egress.
Nothing you read ever leaves your computer.
```

Use this wording:

```text
Your saved pages, questions, vectors, and answers stay on your device. Recall downloads model files from our Cloudflare R2 bucket, but it does not send your reading data or questions to a server.
```

- [ ] **Step 2: Remove bilingual claims**

Remove:

```text
in Korean and English
Bilingual
cross-lingual ceiling
```

Replace with:

```text
Recall is optimized for English web research.
```

- [ ] **Step 3: Run docs grep**

Run:

```bash
rg -n "Zero network|zero network|bilingual|Bilingual|cross-lingual|Korean and English|Nothing you read ever leaves" README.md docs/store
```

Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/store/listing-en.md docs/store/privacy-policy.md docs/store/data-safety.md
git commit -m "docs: update privacy and english-only product copy"
```

---

### Task 15: Final verification

**Files:**

- All changed files

- [ ] **Step 1: Run unit tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run English eval**

```bash
npm run eval:english
```

Expected: PASS and `eval/last-scorecard.json` is written.

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Run e2e**

```bash
npm run e2e
```

Expected: PASS.

- [ ] **Step 5: Check git state**

```bash
git status --short
```

Expected: only intended generated scorecards, or clean.

---

## Self-Review

**Spec coverage**

- 영어 전용 제거: Task 1, Task 14.
- BGE 후보 비교: Task 2, Task 3, Task 4.
- 조금 큰 모델 비교: Task 2 includes `bge-large-en-v1.5`.
- R2 업로드: Task 5, Task 6, Task 13.
- WebLLM Llama first: Task 10.
- WebLLM Gemma next: Task 12.
- 다운로드/로딩 UX: Task 11.
- 매번 다운로드 방지: Task 3, Task 5.
- Ask retrieval 개수 증가: Task 8, Task 11.

**Placeholder scan**

The plan uses concrete file paths, code snippets, commands, and expected results.

**Type consistency**

- `AskQuery`, `AskAnswer`, `AnswerGeneratorPort`, and `AskService.ask()` are introduced before runtime wiring.
- Model artifact names are `ModelManifest`, `ModelArtifactFile`, and `buildArtifactCacheKey()` throughout.
- Ask retrieval defaults are `retrieveK: 12`, `contextK: 8` throughout.
