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
