import { readFileSync } from 'node:fs'

// Scenario: 확장은 원격 모델을 못 읽고 public/models 아래 로컬 모델만 읽는다.
// Coverage: ⚠️ mock - 큰 모델 다운로드 없이 빌드 준비 스크립트의 고정 경로를 확인한다.
test('fetch-model prepares the selected bge runtime directory', () => {
  const script = readFileSync('scripts/fetch-model.mjs', 'utf8')
  const gitignore = readFileSync('.gitignore', 'utf8')

  expect(script).toContain("public/models/bge-base-en-v1.5")
  expect(script).toContain("Xenova/bge-base-en-v1.5")
  expect(script).toContain("public/models/granite")
  expect(script).toContain('removed stale model dir')
  expect(gitignore).toContain('public/models/bge-base-en-v1.5/')
})

// Scenario: 영어 평가를 다시 돌렸다고 믿었는데 예전 Granite를 보면 모델 회귀를 놓친다.
// Coverage: ⚠️ mock - 평가 실행 자체는 무거우므로 기본값과 npm script만 확인한다.
test('english eval defaults to selected bge settings', () => {
  const embedNode = readFileSync('eval/lib/embed-node.mjs', 'utf8')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  expect(embedNode).toContain("const BUNDLED = 'bge-base-en-v1.5'")
  expect(embedNode).toContain("const PREFIX = process.env.EVAL_PREFIX || 'bge'")
  expect(pkg.scripts['eval:english']).toContain('npm run eval:fetch-model')
})
