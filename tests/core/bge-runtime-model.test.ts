import { readFileSync } from 'node:fs'

// Scenario: 확장 파일 안에 큰 BGE 모델을 넣으면 설치 파일이 너무 커진다.
// Coverage: ✅ integration
test('runtime bge embedding model is downloaded from the model CDN', () => {
  const embedder = readFileSync('src/offscreen/webgpu-embedder.ts', 'utf8')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  expect(embedder).toContain('MODEL_CDN_BASE_URL')
  expect(embedder).toContain('env.allowLocalModels = false')
  expect(embedder).toContain('env.allowRemoteModels = true')
  expect(embedder).toContain('env.remoteHost = MODEL_CDN_BASE_URL')
  expect(embedder).toContain('env.useBrowserCache = true')
  expect(pkg.scripts).not.toHaveProperty('prebuild')
})

// Scenario: 로컬에 모델 캐시가 남아 있으면 빌드가 실수로 그 큰 파일까지 묶을 수 있다.
// Coverage: ✅ integration
test('production build removes copied local model artifacts', () => {
  const viteConfig = readFileSync('vite.config.ts', 'utf8')

  expect(viteConfig).toContain("rmSync('dist-ext/models'")
})

// Scenario: WebLLM 기본 모델 목록이 번들에 남으면 쓰지 않는 Hugging Face/GitHub fallback 주소까지 같이 배포된다.
// Coverage: ✅ integration
test('production build strips webllm default remote model catalog', () => {
  const viteConfig = readFileSync('vite.config.ts', 'utf8')

  expect(viteConfig).toContain('stripWebLlmPrebuiltModelCatalog')
  expect(viteConfig).toContain('stripExternalModelOrigins')
})

// Scenario: CDN에서 모델을 내려받으려는데 확장 보안 규칙이 막으면 첫 실행이 실패한다.
// Coverage: ✅ integration
test('extension CSP allows the model CDN', () => {
  const manifestConfig = readFileSync('manifest.config.ts', 'utf8')

  expect(manifestConfig).toContain("connect-src 'self' https://cdn.teamnyongs.com")
})

// Scenario: 영어 평가를 다시 돌렸다고 믿었는데 예전 Granite를 보면 모델 회귀를 놓친다.
// Coverage: ⚠️ mock - 평가 실행 자체는 무거우므로 기본값과 npm script만 확인한다.
test('english eval defaults to selected bge settings', () => {
  const embedNode = readFileSync('eval/lib/embed-node.mjs', 'utf8')
  const fetchModel = readFileSync('scripts/fetch-model.mjs', 'utf8')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  expect(embedNode).toContain("const BUNDLED = 'bge-base-en-v1.5'")
  expect(embedNode).toContain("const PREFIX = process.env.EVAL_PREFIX || 'bge'")
  expect(fetchModel).toContain('https://cdn.teamnyongs.com/models/bge-base-en-v1.5/resolve/main/')
  expect(fetchModel).not.toContain('huggingface.co')
  expect(pkg.scripts['eval:english']).toContain('npm run eval:fetch-model')
})
