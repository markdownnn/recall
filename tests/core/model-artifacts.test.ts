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
    const bad = new TextEncoder().encode('[]')
    await expect(verifyArtifactBytes(bad, manifest.files[0])).rejects.toThrow(/SHA-256 mismatch/)
  })
})
