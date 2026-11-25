# apack-orderings

Runs a scenario under every order its parts can happen in. `README.md` says what it is for and what holds; this is
what to know before changing it.

## Layout

- `src/index.ts` is the public entry: the `Schedule` (with frozen `@apackdev/clock`-compatible `Clock` and dynamic
  `resource()`/`read()`/`write()` tracking), one run of a scenario under the choices it is given (`once`), and what
  makes those choices: Optimal DPOR or unreduced exploration (`explore`, `everyOrder`), seeded sampling (`sample`),
  strict replay (`replay`), and commutativity auditing (`auditIndependence`). `src/dpor.ts` implements the pure
  Optimal DPOR wakeup-tree and race-detection logic.
- `tests/orderings.spec.ts` holds core scheduler, clock, option/choice validation, listener cleanup, and lazy
  `MessageChannel` specs. `tests/dpor.spec.ts` covers Optimal DPOR, automatic clock tracking, differential fuzzing
  against unreduced exploration, and `auditIndependence()`. `tests/node-exit.spec.ts` verifies that idle Node child
  processes exit cleanly, and `tests/worker.spec.ts` with `tests/support/orderings-worker.ts` verifies dedicated Web
  Workers across Chromium, Firefox, and WebKit.
- `scripts/` is what CI and a release run: build determinism and size/cost checks (`package-check.mjs`), `publint` +
  `attw` (`package-lint.mjs`), consumer runtime + TS 5.7 ES2023 typecheck smoke (`package-smoke.mjs`), and the check
  that no workflow publishes to npm (`workflows-check.mjs`).

## Rules

- **A lane keeps its order, and nothing else is chosen.** Whatever is added goes into a lane; nothing runs outside
  one, and nothing reorders what is in one.
- **A run is the same for the same choices.** Nothing reads the time it is, a random number that was not seeded,
  or anything left by another run. That is what makes `replay` mean something.
- **No dependencies at run time.** It runs in Node, browsers, and Web Workers from one source, with
  `erasableSyntaxOnly: true` and Node `>=24.12.0`.
- **Used by apack-link's and apack-state's test kits.** A change to what `Schedule` offers or to how orders are
  counted moves both: change it here, release, and move their pins.
- **Timers are globally conflicting under DPOR.** All timers share one priority-queue `'clock'` lane whose head task
  can be preempted or cancelled by another lane, which lies outside Abdulla et al. (2017)'s non-disabling / fixed-lane
  assumptions. Timer scheduling, cancellation, and firing therefore set `global = true`, and `preemptedClock` adds the
  single O(1) `['clock']` disabling/preemption wakeup in `findWakeups()`. Do not remove `preemptedClock` or relax
  timer global conflict without replacing `'clock'` with per-timer stable identities and proving soundness against the
  nested differential fuzzer (`npm run fuzz`).
- **Every mutant is caught.** A line whose change no spec notices is a line nothing holds: add the case, or where the
  change is mathematically equivalent, explain why on that line.
- **A spec says what holds, not how.**

## Commands

```bash
npm run typecheck
npm run typecheck:floor
npm test
npm run test:browser
npm run fuzz
npm run mutants
npm run build
npm run package:check
npm run package:lint
npm run package:smoke
npm run workflows:check
```
