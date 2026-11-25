// Standalone differential fuzzer comparing Optimal DPOR (`reduce: true`) against full unreduced exploration
// (`reduce: false`) across hundreds of randomized concurrent programs. Runs against the built `dist/index.js`.
//
//   npm run fuzz
//   FUZZ_PROGRAMS=1000 FUZZ_SEED=7 npm run fuzz
import { explore } from '../dist/index.js'
import { runDifferentialFuzz } from '../tests/support/fuzz-programs.ts'

const programs = Number.parseInt(process.env.FUZZ_PROGRAMS ?? '500', 10)
const seed = Number.parseInt(process.env.FUZZ_SEED ?? '42', 10)
if (!Number.isSafeInteger(programs) || programs < 1) throw new RangeError(`Invalid FUZZ_PROGRAMS: ${String(programs)}`)
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new RangeError(`Invalid FUZZ_SEED: ${String(seed)}`)

const started = performance.now()
const summary = await runDifferentialFuzz(explore, { seed, programs })
const elapsedMs = (performance.now() - started).toFixed(0)
const ratio = (summary.totalUnreduced / summary.totalReduced).toFixed(2)
console.log(
  `fuzz ok: ${summary.programs} programs (seed=${seed}) matched exact reachable states in ${elapsedMs} ms `
  + `(unreduced=${summary.totalUnreduced}, dpor=${summary.totalReduced}, ${ratio}x reduction)`,
)
