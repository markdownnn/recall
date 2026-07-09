#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const [root, id, kind, version, baseUrl] = process.argv.slice(2)
if (!root || !id || !kind || !version || !baseUrl || !['embedding', 'webllm'].includes(kind)) {
  console.error('usage: node scripts/r2-model-manifest.mjs <root> <id> <embedding|webllm> <version> <baseUrl>')
  process.exit(1)
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      out.push(...walk(path))
    } else {
      out.push(path)
    }
  }
  return out
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

const files = []
for (const abs of walk(root)) {
  const path = relative(root, abs).replaceAll('\\', '/')
  if (path === 'manifest.json') continue
  const stat = statSync(abs)
  files.push({ path, size: stat.size, sha256: await sha256(abs) })
}

files.sort((a, b) => a.path.localeCompare(b.path))

const manifest = { id, kind, version, baseUrl, files }
const manifestPath = join(root, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`[manifest] wrote ${manifestPath} (${files.length} files)`)
