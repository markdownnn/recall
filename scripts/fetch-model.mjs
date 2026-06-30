#!/usr/bin/env node
// fetch-model.mjs -> ensure the granite embedding model is present and INTEGRITY-VERIFIED
// before the build. The model is NOT tracked in git (the ~107MB ONNX file exceeds GitHub's
// 100MB-per-file limit), so this script reconstructs it on a fresh clone.
//
// Runs in `prebuild` (see package.json) and in the eval harness. Two paths:
//
//   PRESENT  -> the 4 files already exist under public/models/granite/ (a local dev box or a
//               CI cache). We only SHA-256-verify them against the pins below and succeed.
//               No network. This is the path a normal `npm run build` takes locally.
//
//   MISSING  -> download each file from a HuggingFace repo (env RECALL_MODEL_HF_REPO, default
//               markdownnn/recall-granite-q8) via the public resolve/main/<path> URL, stream
//               it to disk, then SHA-256-verify. A hash mismatch or any download error fails
//               the build with a clear, actionable message.
//
// The SHA-256 pins are the integrity guarantee: whatever source provides the bytes (HF mirror
// or a local `python scripts/quantize-granite.py` build), they must hash to exactly these
// values or the build refuses to proceed. Node built-ins only - no npm deps, no git-lfs.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = resolve(ROOT, 'public/models/granite')

// HuggingFace repo to download from when the model is missing. Override with RECALL_MODEL_HF_REPO
// (e.g. a fork or a private mirror). Files are fetched from the public resolve/main/<path> URL.
const HF_REPO = process.env.RECALL_MODEL_HF_REPO || 'markdownnn/recall-granite-q8'

// SHA-256 of each granite file (printed by scripts/quantize-granite.py). The integrity pin.
const HASHES = {
  'config.json':               '624bd250eb6334715c8d76295a65d18c05a3bf3435ca35b74fcce1cb996ea0e0',
  'tokenizer_config.json':     'a572845c401dc50c54729a11ae765fddebeb03d6fd1923e89f4ac93ffb06881b',
  'tokenizer.json':            '14917dd757b81bc44d4af6b028367351702656670c1954e055dabdfcf21593cf',
  'onnx/model_quantized.onnx': '08da7a657ba6069b389b9cc0742a7d623542f48d322b84f489ba3acaf4aab76d',
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
    '\nThe granite embedding model is NOT bundled in this repo. To provide it, either:\n' +
    `  1. Point at a HuggingFace repo that has the 4 files:\n` +
    `       RECALL_MODEL_HF_REPO=<owner>/<repo> npm run fetch-model\n` +
    `     (default repo: ${HF_REPO})\n` +
    `  2. Build it locally (produces exactly these files):\n` +
    `       pip install "optimum[onnxruntime]" "transformers"\n` +
    `       python scripts/quantize-granite.py\n` +
    `     then copy its outputs into public/models/granite/ and re-run.\n` +
    `\nIn both cases the files must match the pinned SHA-256 hashes (the integrity guarantee).\n`,
  )
  process.exit(1)
}

async function main() {
  const present = FILES.every((rel) => existsSync(resolve(DIR, rel)))

  if (present) {
    console.log('[fetch-model] model present - verifying SHA-256 (no download)...')
    for (const rel of FILES) {
      const size = await verifyFile(rel)
      console.log(`[fetch-model] ok ${rel} (${(size / 1e6).toFixed(1)} MB)`)
    }
    console.log('[fetch-model] granite model present and verified. Build may proceed.')
    return
  }

  console.log(`[fetch-model] model missing - downloading from HuggingFace repo "${HF_REPO}"...`)
  for (const rel of FILES) {
    await downloadFile(rel)
    const size = await verifyFile(rel)
    console.log(`[fetch-model] ok ${rel} (${(size / 1e6).toFixed(1)} MB) - downloaded + verified`)
  }
  console.log('[fetch-model] granite model downloaded and verified. Build may proceed.')
}

main().catch((err) => fail(err.message))
