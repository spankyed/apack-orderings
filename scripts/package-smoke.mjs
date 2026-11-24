// The package as a consumer gets it: packed, installed into a project of its own, imported by its name, and the
// README's example run there. Removes what it made either way.
//
//   node scripts/package-smoke.mjs [tarball]   (without one, packs this checkout: `prepack` builds dist/ first)
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (args, cwd) => execFileSync(npm, args.map((arg) => (process.platform === 'win32' && /\s/.test(arg) ? `"${arg}"` : arg)), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'apack-orderings-consumer-'))
try {
  let tarball = process.argv[2] && path.resolve(process.argv[2])
  if (!tarball) {
    const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', consumer], path.resolve(import.meta.dirname, '..')))
    tarball = path.join(consumer, packed.filename)
  }
  if (!fs.existsSync(tarball)) throw new Error(`No tarball at ${tarball}`)
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  run(['install', '--no-audit', '--no-fund', '--no-package-lock', tarball], consumer)
  fs.writeFileSync(path.join(consumer, 'entries.mjs'), `
import * as orderings from '@apackdev/orderings'
for (const name of ['everyOrder', 'explore', 'replay', 'sample']) if (typeof orderings[name] !== 'function') throw new Error('@apackdev/orderings has no ' + name)
`)
  execFileSync(process.execPath, ['entries.mjs'], { cwd: consumer, stdio: 'inherit' })
  // The README's first example, as it is written there, run with its types stripped: it logs the order that failed.
  const readme = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n')
  const example = /```ts\n([\s\S]*?)```/.exec(readme)?.[1]
  if (!example) throw new Error('The README has no ts example')
  fs.writeFileSync(path.join(consumer, 'example.mts'), example)
  const logged = execFileSync(process.execPath, ['example.mts'], { cwd: consumer, encoding: 'utf8' })
  const said = /```text\n([\s\S]*?)```/.exec(readme)?.[1]
  if (!said || logged.trim() !== said.trim()) throw new Error(`The README example logged ${logged}, and the README says ${said}`)
  console.log('the entry loaded, and the README example logged what the README says it does')
} finally {
  fs.rmSync(consumer, { recursive: true, force: true })
}
