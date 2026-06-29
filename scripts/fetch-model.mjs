#!/usr/bin/env node
// fetch-model.mjs — idempotent model fetcher for the bundled embedding model.
// Run automatically via `prebuild` before `npm run build`.
// Downloads 4 files for Xenova/multilingual-e5-small from a pinned HuggingFace
// commit SHA into public/models/Xenova/multilingual-e5-small/.
// Skips any file that already exists at the expected byte size.
// No npm dependencies — uses Node built-ins only (fetch + fs).

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { pipeline as streamPipeline } from 'stream/promises'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const SHA = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
const HF_BASE = `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${SHA}`
const MODEL_DIR = resolve(ROOT, 'public/models/Xenova/multilingual-e5-small')

// Files to fetch: [local relative path from MODEL_DIR, remote path suffix, expected min bytes]
// Expected sizes are lower bounds — actual files may be slightly larger. Used only for
// the skip check (if file exists and size >= expected, we skip the download).
const FILES = [
  { rel: 'config.json',             url: `${HF_BASE}/config.json`,             minBytes: 400 },
  { rel: 'tokenizer_config.json',   url: `${HF_BASE}/tokenizer_config.json`,   minBytes: 300 },
  { rel: 'tokenizer.json',          url: `${HF_BASE}/tokenizer.json`,           minBytes: 10_000_000 },
  { rel: 'onnx/model_quantized.onnx', url: `${HF_BASE}/onnx/model_quantized.onnx`, minBytes: 100_000_000 },
]

async function fetchFile(url, dest, minBytes) {
  const absPath = resolve(MODEL_DIR, dest)
  const dir = dirname(absPath)

  // Skip if already present at expected size
  if (existsSync(absPath)) {
    const size = statSync(absPath).size
    if (size >= minBytes) {
      console.log(`[fetch-model] skip  ${dest} (${(size / 1e6).toFixed(1)} MB already present)`)
      return
    }
    console.log(`[fetch-model] stale ${dest} (${size} bytes < ${minBytes} expected) — re-fetching`)
  }

  mkdirSync(dir, { recursive: true })

  console.log(`[fetch-model] fetch ${dest} ...`)
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${url}`)
  }

  // Stream to disk to avoid loading 118MB into memory
  const tmpPath = `${absPath}.tmp`
  const writer = createWriteStream(tmpPath)
  await streamPipeline(resp.body, writer)

  // Rename to final path only on success (atomic enough for our purposes)
  const { renameSync } = await import('fs')
  if (existsSync(absPath)) unlinkSync(absPath)
  renameSync(tmpPath, absPath)

  const finalSize = statSync(absPath).size
  console.log(`[fetch-model] done  ${dest} (${(finalSize / 1e6).toFixed(1)} MB)`)
}

console.log('[fetch-model] Checking bundled model files...')

try {
  for (const { rel, url, minBytes } of FILES) {
    await fetchFile(url, rel, minBytes)
  }
  console.log('[fetch-model] All model files present. Build may proceed.')
} catch (err) {
  console.error('[fetch-model] FAILED:', err.message)
  process.exit(1)
}
