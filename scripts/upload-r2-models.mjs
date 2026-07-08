#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const [bucket, root, prefix, ...flags] = process.argv.slice(2)
const dryRun = flags.includes('--dry-run')

if (!bucket || !root || !prefix) {
  console.error('usage: node scripts/upload-r2-models.mjs <bucket> <root> <prefix> [--dry-run]')
  process.exit(1)
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

function contentType(path) {
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.wasm')) return 'application/wasm'
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '')
const files = walk(root).sort((a, b) => relative(root, a).localeCompare(relative(root, b)))

for (const file of files) {
  const rel = relative(root, file).replaceAll('\\', '/')
  const key = `${cleanPrefix}/${rel}`
  const objectPath = `${bucket}/${key}`
  const args = [
    'wrangler',
    'r2',
    'object',
    'put',
    objectPath,
    '--file',
    file,
    '--content-type',
    contentType(rel),
  ]

  if (dryRun) {
    console.log(`npx ${args.join(' ')}`)
    continue
  }

  const run = spawnSync('npx', args, { stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}

console.log(`[upload-r2] ${dryRun ? 'checked' : 'uploaded'} ${files.length} files`)
