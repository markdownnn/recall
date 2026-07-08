#!/usr/bin/env node
// fetch-model.mjs -> ensure the selected BGE embedding model is present and INTEGRITY-VERIFIED
// before the build. The model is NOT tracked in git (the ~107MB ONNX file exceeds GitHub's
// 100MB-per-file limit), so this script reconstructs it on a fresh clone.
//
// Runs in `prebuild` (see package.json) and in the eval harness. Two paths:
//
//   PRESENT  -> the 4 files already exist under public/models/bge-base-en-v1.5/ (a local dev box or a
//               CI cache). We only SHA-256-verify them against the pins below and succeed.
//               No network. This is the path a normal `npm run build` takes locally.
//
//   MISSING  -> download each file from a HuggingFace repo (env RECALL_MODEL_HF_REPO, default
//               Xenova/bge-base-en-v1.5) via the public resolve/main/<path> URL, stream
//               it to disk, then SHA-256-verify. A hash mismatch or any download error fails
//               the build with a clear, actionable message.
//
// The SHA-256 pins are the integrity guarantee: whatever source provides the bytes (HF mirror
// or a local `python scripts/quantize-granite.py` build), they must hash to exactly these
// values or the build refuses to proceed. Node built-ins only - no npm deps, no git-lfs.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = resolve(ROOT, 'public/models/bge-base-en-v1.5')
const STALE_DIRS = [resolve(ROOT, 'public/models/granite')]

// HuggingFace repo to download from when the model is missing. Override with RECALL_MODEL_HF_REPO
// (e.g. a fork or a private mirror). Files are fetched from the public resolve/main/<path> URL.
const HF_REPO = process.env.RECALL_MODEL_HF_REPO || 'Xenova/bge-base-en-v1.5'

// SHA-256 of each BGE base q8 file. The integrity pin.
const HASHES = {
  'config.json':               'd83c21fa7366994560727112ef0a31d8a2ec1c280c2a3e66326fdb877f64c91e',
  'tokenizer_config.json':     '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  'tokenizer.json':            'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
  'onnx/model_quantized.onnx': 'c9729cc84cbd0e9fecc759505d2be65916c9fe05222d7ea26c65fcb3382af38d',
}

const FILES = Object.keys(HASHES)

function sha256OfFile(absPath) {
  return new Promise((res, rej) => {
    const hash = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('error', rej)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => res(hash.digest('hex')))
  })
}

async function verifyFile(rel) {
  const abs = resolve(DIR, rel)
  const actual = await sha256OfFile(abs)
  const expected = HASHES[rel]
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${rel}:\n  expected ${expected}\n  got      ${actual}`)
  }
  return statSync(abs).size
}

async function downloadFile(rel) {
  const abs = resolve(DIR, rel)
  mkdirSync(dirname(abs), { recursive: true })
  const url = `https://huggingface.co/${HF_REPO}/resolve/main/${rel}`
  console.log(`[fetch-model] downloading ${rel}\n               <- ${url}`)
  let resp
  try {
    resp = await fetch(url, { redirect: 'follow' })
  } catch (err) {
    throw new Error(`network error fetching ${rel} from ${url}: ${err.message}`)
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} fetching ${rel} from ${url}`)
  }
  if (!resp.body) {
    throw new Error(`empty response body fetching ${rel} from ${url}`)
  }
  try {
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(abs))
  } catch (err) {
    // Don't leave a half-written file around to confuse the next run.
    try { if (existsSync(abs)) unlinkSync(abs) } catch { /* best effort */ }
    throw new Error(`failed writing ${rel} to disk: ${err.message}`)
  }
}

function fail(message) {
  console.error('\n[fetch-model] FAILED:', message)
  console.error(
    '\nThe BGE embedding model is NOT bundled in this repo. To provide it, either:\n' +
    `  1. Point at a HuggingFace repo that has the 4 files:\n` +
    `       RECALL_MODEL_HF_REPO=<owner>/<repo> npm run fetch-model\n` +
    `     (default repo: ${HF_REPO})\n` +
    `  2. Copy an already-downloaded transformers.js cache into public/models/bge-base-en-v1.5/.\n` +
    `\nIn both cases the files must match the pinned SHA-256 hashes (the integrity guarantee).\n`,
  )
  process.exit(1)
}

function removeStaleModels() {
  for (const dir of STALE_DIRS) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      console.log(`[fetch-model] removed stale model dir ${dir}`)
    }
  }
}

async function main() {
  const present = FILES.every((rel) => existsSync(resolve(DIR, rel)))

  if (present) {
    console.log('[fetch-model] model present - verifying SHA-256 (no download)...')
    for (const rel of FILES) {
      const size = await verifyFile(rel)
      console.log(`[fetch-model] ok ${rel} (${(size / 1e6).toFixed(1)} MB)`)
    }
    removeStaleModels()
    console.log('[fetch-model] BGE model present and verified. Build may proceed.')
    return
  }

  console.log(`[fetch-model] model missing - downloading from HuggingFace repo "${HF_REPO}"...`)
  for (const rel of FILES) {
    await downloadFile(rel)
    const size = await verifyFile(rel)
    console.log(`[fetch-model] ok ${rel} (${(size / 1e6).toFixed(1)} MB) - downloaded + verified`)
  }
  removeStaleModels()
  console.log('[fetch-model] BGE model downloaded and verified. Build may proceed.')
}

main().catch((err) => fail(err.message))
