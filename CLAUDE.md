# apack-orderings

Runs a scenario under every order its parts can happen in. `README.md` says what it is for and what holds; this is
what to know before changing it.

## Layout

- `src/index.ts` is the whole package: the `Schedule` (and frozen `@apackdev/clock`-compatible `Clock`) a scenario is
  handed, one run of a scenario under the choices it is given (`once`), and what makes those choices: every one in turn
  (`explore`, `everyOrder`), drawn from a seed (`sample`), or handed in (`replay`).
- `tests/orderings.spec.ts` holds every guarantee in the README (including `outside()`, clock parity, option/choice
  validation, async checks, listener cleanup, and lazy `MessageChannel` ref/unref). `tests/worker.spec.ts` and
  `tests/support/orderings-worker.ts` verify dedicated Web Workers across Chromium, Firefox, and WebKit.
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
- **Every mutant is caught.** A line whose change no spec notices is a line nothing holds: add the case, or where the
  change is mathematically equivalent, explain why on that line.
- **A spec says what holds, not how.**

## Commands

```bash
npm run typecheck
npm run typecheck:floor
npm test
npm run test:browser
npm run mutants
npm run build
npm run package:check
npm run package:lint
npm run package:smoke
npm run workflows:check
```
