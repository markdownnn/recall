import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

describe('r2 model manifest script', () => {
  // Scenario: R2에 올릴 모델 파일 목록이 손으로 적히면 크기나 해시가 틀릴 수 있다.
  // Coverage: ✅ integration
  test('writes a sorted manifest with file size and sha256', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-model-'))
    try {
      mkdirSync(join(root, 'onnx'))
      writeFileSync(join(root, 'config.json'), '{}')
      writeFileSync(join(root, 'onnx', 'model.onnx'), 'abc')
      writeFileSync(join(root, 'manifest.json'), '{"stale":true}')

      execFileSync('node', [
        'scripts/r2-model-manifest.mjs',
        root,
        'bge-test',
        'embedding',
        'v1',
        'https://models.example.test/models/bge-test/',
      ])

      const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
      expect(manifest).toEqual({
        id: 'bge-test',
        kind: 'embedding',
        version: 'v1',
        baseUrl: 'https://models.example.test/models/bge-test/',
        files: [
          { path: 'config.json', size: 2, sha256: sha256('{}') },
          { path: 'onnx/model.onnx', size: 3, sha256: sha256('abc') },
        ],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Scenario: 명령을 기억해서 길게 치면 사람이 빼먹기 쉽다.
  // Coverage: ✅ integration
  test('package exposes the manifest command', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.scripts['models:manifest']).toBe('node scripts/r2-model-manifest.mjs')
  })

  // Scenario: 모델 업로드 명령을 손으로 여러 번 치면 파일을 빼먹거나 잘못된 R2 key로 올릴 수 있다.
  // Coverage: ✅ integration
  test('upload script dry-run prints sorted wrangler object put commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-upload-'))
    try {
      mkdirSync(join(root, 'onnx'))
      writeFileSync(join(root, 'manifest.json'), '{}')
      writeFileSync(join(root, 'onnx', 'model.onnx'), 'abc')

      const out = execFileSync('node', [
        'scripts/upload-r2-models.mjs',
        'recall-models',
        root,
        'models/bge-base-en-v1.5',
        '--dry-run',
      ], { encoding: 'utf8' })

      expect(out).toContain('npx wrangler r2 object put recall-models/models/bge-base-en-v1.5/manifest.json')
      expect(out).toContain('npx wrangler r2 object put recall-models/models/bge-base-en-v1.5/onnx/model.onnx')
      expect(out).toContain('--remote')
      expect(out.indexOf('manifest.json')).toBeLessThan(out.indexOf('onnx/model.onnx'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Scenario: 업로드 스크립트가 package script에 없으면 팀원이 긴 명령을 매번 외워야 한다.
  // Coverage: ✅ integration
  test('package exposes the r2 upload command', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.scripts['models:upload-r2']).toBe('node scripts/upload-r2-models.mjs')
  })
})
