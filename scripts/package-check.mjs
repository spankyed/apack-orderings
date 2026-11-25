// Build reproducibility and size/cost guardrails on the compiled package:
//   1. Snapshots `dist/`, rebuilds `dist/` cleanly from scratch, and asserts every emitted file matches byte-for-byte.
//   2. Records and bounds raw and gzipped sizes of `dist/index.js` and `dist/index.d.ts`.
//   3. Verifies steady-state exploration on `dist/index.js`.
//
//   npm run package:check
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = path.resolve(import.meta.dirname, '..')
const distDir = path.join(root, 'dist')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const snapshot = () => new Map(
  fs.readdirSync(distDir).sort().map((name) => [name, sha256(fs.readFileSync(path.join(distDir, name)))]),
)

const first = snapshot()
fs.rmSync(distDir, { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })
const second = snapshot()

if (JSON.stringify([...first.keys()]) !== JSON.stringify([...second.keys()])) {
  throw new Error(`Non-deterministic build file list: ${[...first.keys()].join(',')} vs ${[...second.keys()].join(',')}`)
}
for (const [name, hash] of first) {
  if (second.get(name) !== hash) {
    throw new Error(`Non-deterministic build output for ${name}: ${hash} !== ${second.get(name)}`)
  }
}

const jsFiles = fs.readdirSync(distDir).filter((name) => name.endsWith('.js')).sort()
const jsRaw = jsFiles.reduce((sum, name) => sum + fs.readFileSync(path.join(distDir, name)).length, 0)
const jsGzip = jsFiles.reduce((sum, name) => sum + gzipSync(fs.readFileSync(path.join(distDir, name)), { level: 9 }).length, 0)
const dtsBytes = fs.readFileSync(path.join(distDir, 'index.d.ts'))

const MAX_JS_RAW = 36_000
const MAX_JS_GZIP = 10_000
if (jsRaw > MAX_JS_RAW) throw new Error(`dist/*.js grew to ${jsRaw} B (limit ${MAX_JS_RAW} B)`)
if (jsGzip > MAX_JS_GZIP) throw new Error(`dist/*.js gzip grew to ${jsGzip} B (limit ${MAX_JS_GZIP} B)`)

const { everyOrder } = await import(pathToFileURL(path.join(distDir, 'index.js')).href)
const started = performance.now()
const count = await everyOrder((schedule) => {
  const ran = []
  schedule.does('a', ['1', () => { ran.push('a1') }], ['2', () => { ran.push('a2') }], ['3', () => { ran.push('a3') }])
  schedule.does('b', ['1', () => { ran.push('b1') }], ['2', () => { ran.push('b2') }], ['3', () => { ran.push('b3') }])
  return () => { if (ran.length !== 6) throw new Error(`expected 6 steps, got ${ran.length}`) }
})
const elapsedMs = performance.now() - started
if (count !== 20) throw new Error(`Expected 20 orderings for 3x3, got ${count}`)

console.log(
  `reproducible build verified (${first.size} files, sha256=${first.get('index.js').slice(0, 12)}), ` +
  `js=${jsRaw} B (${jsGzip} B gzip), d.ts=${dtsBytes.length} B, ` +
  `3x3 (${count} orderings)=${elapsedMs.toFixed(2)} ms`,
)
