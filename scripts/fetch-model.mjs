#!/usr/bin/env node
// fetch-model.mjs — idempotent model fetcher for the bundled embedding model.
// Run automatically via `prebuild` before `npm run build`.
// Downloads 4 files for Xenova/multilingual-e5-small from a pinned HuggingFace
// commit SHA into public/models/Xenova/multilingual-e5-small/.
// Skips any file already present with the correct SHA-256 hash.
// No npm dependencies — uses Node built-ins only (fetch + fs + crypto).

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { pipeline as streamPipeline } from 'stream/promises'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const SHA = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
const HF_BASE = `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${SHA}`
const MODEL_DIR = resolve(ROOT, 'public/models/Xenova/multilingual-e5-small')

// SHA-256 hashes pinned to commit 761b726dd34fb83930e26aab4e9ac3899aa1fa78.
// A file whose hash does not match is deleted and a build error is raised —
// this closes the TOFU gap where a correctly-sized but tampered file passes silently.
const EXPECTED_HASHES = {
  'config.json':                     'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
  'tokenizer_config.json':           'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
  'tokenizer.json':                  '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
  'onnx/model_quantized.onnx':       'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
}

// Files to fetch: [local relative path from MODEL_DIR, remote path suffix]
const FILES = [
  { rel: 'config.json',               url: `${HF_BASE}/config.json` },
  { rel: 'tokenizer_config.json',     url: `${HF_BASE}/tokenizer_config.json` },
  { rel: 'tokenizer.json',            url: `${HF_BASE}/tokenizer.json` },
  { rel: 'onnx/model_quantized.onnx', url: `${HF_BASE}/onnx/model_quantized.onnx` },
]

/** Compute the SHA-256 hex digest of a file on disk. */
async function sha256OfFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function fetchFile(rel, url) {
  const absPath = resolve(MODEL_DIR, rel)
  const dir = dirname(absPath)
  const expectedHash = EXPECTED_HASHES[rel]

  // If the file already exists, verify its hash instead of re-downloading.
  // A file with the wrong hash is stale/tampered — delete it and re-fetch.
  if (existsSync(absPath)) {
    const actualHash = await sha256OfFile(absPath)
    if (actualHash === expectedHash) {
      const size = statSync(absPath).size
      console.log(`[fetch-model] skip  ${rel} (${(size / 1e6).toFixed(1)} MB, hash ok)`)
      return
    }
    console.log(`[fetch-model] hash mismatch on existing ${rel} — re-fetching`)
    unlinkSync(absPath)
  }

  mkdirSync(dir, { recursive: true })

  console.log(`[fetch-model] fetch ${rel} ...`)
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${url}`)
  }

  // Stream to disk to avoid loading 118MB into memory
  const tmpPath = `${absPath}.tmp`
  const writer = createWriteStream(tmpPath)
  await streamPipeline(resp.body, writer)

  // Verify hash of the downloaded file before promoting to the final path.
  const downloadedHash = await sha256OfFile(tmpPath)
  if (downloadedHash !== expectedHash) {
    unlinkSync(tmpPath)
    throw new Error(
      `[fetch-model] SHA-256 mismatch for ${rel}:\n` +
      `  expected: ${expectedHash}\n` +
      `  got:      ${downloadedHash}\n` +
      `Downloaded file was deleted. Do NOT bundle an unverified model.`
    )
  }

  // Rename to final path only on success (atomic enough for our purposes)
  const { renameSync } = await import('fs')
  if (existsSync(absPath)) unlinkSync(absPath)
  renameSync(tmpPath, absPath)

  const finalSize = statSync(absPath).size
  console.log(`[fetch-model] done  ${rel} (${(finalSize / 1e6).toFixed(1)} MB, hash ok)`)
}

console.log('[fetch-model] Checking bundled model files...')

try {
  for (const { rel, url } of FILES) {
    await fetchFile(rel, url)
  }
  console.log('[fetch-model] All model files present and verified. Build may proceed.')
} catch (err) {
  console.error('[fetch-model] FAILED:', err.message)
  process.exit(1)
}
