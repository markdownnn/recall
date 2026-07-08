import { existsSync, readFileSync } from 'node:fs'

// Scenario: 후보 모델 평가를 사람이 손으로 하나씩 돌리면 빠뜨린 모델이 생길 수 있다.
// Coverage: ✅ integration
test('bge candidate runner script and package command exist', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
  expect(pkg.scripts['eval:bge']).toBe('vite-node eval/run-candidates.mjs')
  expect(pkg.scripts['eval:english']).toBe(
    'vite-node eval/run.mjs -- --strip --min-prose=0.35 --golden=eval/english-golden.json',
  )
  expect(existsSync('eval/run-candidates.mjs')).toBe(true)
})
