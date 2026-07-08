import { describe, expect, test } from 'vitest'
import { buildArtifactCacheKey, fileUrl, verifyArtifactBytes, type ModelManifest } from '../../src/core/model-artifacts'

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

  // Scenario: R2 manifest의 상대 경로는 모델 base URL 아래 파일로만 바뀌어야 한다.
  // Coverage: ✅ integration
  test('fileUrl resolves artifact paths under the manifest base url', () => {
    expect(fileUrl(manifest, { ...manifest.files[0], path: 'onnx/model_int8.onnx' })).toBe(
      'https://models.example.test/models/embedding/bge-base-en-v1.5/q8/onnx/model_int8.onnx',
    )
  })

  // Scenario: manifest 파일 경로가 외부 주소나 상위 폴더로 새면 의도하지 않은 곳에서 모델을 받을 수 있다.
  // Coverage: ✅ integration
  test('fileUrl rejects unsafe artifact paths', () => {
    expect(() => fileUrl(manifest, { ...manifest.files[0], path: 'https://other.example/model.onnx' })).toThrow(
      /relative artifact path/,
    )
    expect(() => fileUrl(manifest, { ...manifest.files[0], path: '../model.onnx' })).toThrow(/relative artifact path/)
    expect(() => fileUrl(manifest, { ...manifest.files[0], path: '/model.onnx' })).toThrow(/relative artifact path/)
  })

  // Scenario: 깨진 R2 파일을 그대로 쓰면 검색과 답변이 틀어진다.
  // Coverage: ✅ integration
  test('verifies sha256 before model use', async () => {
    const ok = new TextEncoder().encode('{}')
    await expect(verifyArtifactBytes(ok, manifest.files[0])).resolves.toBeUndefined()
    const bad = new TextEncoder().encode('[]')
    await expect(verifyArtifactBytes(bad, manifest.files[0])).rejects.toThrow(/SHA-256 mismatch/)
  })

  // Scenario: 파일 크기가 다르면 해시 계산 전부터 잘못 받은 모델 파일이다.
  // Coverage: ✅ integration
  test('verifies size before model use', async () => {
    const short = new TextEncoder().encode('x')
    await expect(verifyArtifactBytes(short, manifest.files[0])).rejects.toThrow(/size mismatch/)
  })
})
