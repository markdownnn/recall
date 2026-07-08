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
})
