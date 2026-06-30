#!/usr/bin/env node
// fetch-model.mjs -> now a VERIFIER (no download). The granite embedding model is COMMITTED
// into the repo under public/models/granite/ (plain git blobs; git-lfs was unavailable in the
// build env so the weights are committed directly), so nothing is fetched at build. This runs
// in `prebuild` and CI to guard two failure modes:
//   1. an incomplete clone (or a clone that did not run `git lfs pull` if LFS is later adopted)
//      -> a missing file or a tiny pointer stub -> the SHA-256 will not match -> we fail with a
//      clear message.
//   2. a corrupted/tampered weight file -> hash mismatch -> build fails.
// No network, no npm deps - Node built-ins only. (Renaming this file to verify-model.mjs is
// cosmetic; the prebuild/eval:fetch-model npm scripts point here.)

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = resolve(ROOT, 'public/models/granite')

// SHA-256 of each committed granite file (printed by scripts/quantize-granite.py).
const HASHES = {
  'config.json':               '624bd250eb6334715c8d76295a65d18c05a3bf3435ca35b74fcce1cb996ea0e0',
  'tokenizer_config.json':     'a572845c401dc50c54729a11ae765fddebeb03d6fd1923e89f4ac93ffb06881b',
  'tokenizer.json':            '14917dd757b81bc44d4af6b028367351702656670c1954e055dabdfcf21593cf',
  'onnx/model_quantized.onnx': '08da7a657ba6069b389b9cc0742a7d623542f48d322b84f489ba3acaf4aab76d',
}

function sha256OfFile(absPath) {
  return new Promise((res, rej) => {
    const hash = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('error', rej)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => res(hash.digest('hex')))
  })
}

console.log('[verify-model] Verifying committed granite artifact...')
try {
  for (const [rel, expected] of Object.entries(HASHES)) {
    const abs = resolve(DIR, rel)
    if (!existsSync(abs)) {
      throw new Error(`missing ${rel} - the granite weights are committed in the repo; ensure a complete clone (if using Git LFS, run \`git lfs install && git lfs pull\`)`)
    }
    const actual = await sha256OfFile(abs)
    if (actual !== expected) {
      throw new Error(
        `SHA-256 mismatch for ${rel}:\n  expected ${expected}\n  got      ${actual}\n` +
        `If ${rel} is a Git LFS pointer stub, run: git lfs install && git lfs pull`,
      )
    }
    console.log(`[verify-model] ok ${rel} (${(statSync(abs).size / 1e6).toFixed(1)} MB)`)
  }
  console.log('[verify-model] granite artifact present and verified. Build may proceed.')
} catch (err) {
  console.error('[verify-model] FAILED:', err.message)
  process.exit(1)
}
