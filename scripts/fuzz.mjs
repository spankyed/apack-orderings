// Standalone differential fuzzer comparing wakeup-tree DPOR (`reduce: true`) against full unreduced exploration
// (`reduce: false`) across randomized nested concurrent programs (mixed, all-tracked, and timer-heavy profiles).
// Runs directly against `src/index.ts`.
//
//   npm run fuzz
//   FUZZ_PROGRAMS=1500 FUZZ_SEED=7 npm run fuzz
import { explore } from '../src/index.ts'
import { runDifferentialFuzz } from '../tests/support/fuzz-programs.ts'

const programs = Number.parseInt(process.env.FUZZ_PROGRAMS ?? '600', 10)
const seed = Number.parseInt(process.env.FUZZ_SEED ?? '42', 10)
if (!Number.isSafeInteger(programs) || programs < 1) throw new RangeError(`Invalid FUZZ_PROGRAMS: ${String(programs)}`)
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new RangeError(`Invalid FUZZ_SEED: ${String(seed)}`)

const profiles = ['mixed', 'all', 'timers']
const base = Math.floor(programs / profiles.length)
const extra = programs % profiles.length

const started = performance.now()
let totalPrograms = 0
let totalUnreduced = 0
let totalReduced = 0
for (let i = 0; i < profiles.length; i++) {
  const count = base + (i < extra ? 1 : 0)
  if (count === 0) continue
  const profile = profiles[i]
  const profileSeed = (seed + i * 100_003) >>> 0
  const summary = await runDifferentialFuzz(explore, { seed: profileSeed, programs: count, profile })
  totalPrograms += summary.programs
  totalUnreduced += summary.totalUnreduced
  totalReduced += summary.totalReduced
}
const elapsedMs = (performance.now() - started).toFixed(0)
const ratio = (totalUnreduced / totalReduced).toFixed(2)
console.log(
  `fuzz ok: ${totalPrograms} programs across ${profiles.join('/')} (seed=${seed}) matched exact reachable states in ${elapsedMs} ms `
  + `(unreduced=${totalUnreduced}, dpor=${totalReduced}, ${ratio}x reduction)`,
)
