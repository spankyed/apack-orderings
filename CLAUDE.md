# apack-orderings

Runs a scenario under every order its parts can happen in. `README.md` says what it is for and what holds; this is
what to know before changing it.

## Layout

- `src/index.ts` is the whole package: the `Schedule` a scenario is handed, one run of a scenario under the
  choices it is given (`once`), and what makes those choices: every one in turn (`explore`, `everyOrder`), drawn
  from a seed (`sample`), or handed in (`replay`).
- `tests/orderings.spec.ts` holds it to what the README says.
- `scripts/` is what CI and a release run: the package smoke, and the check that no workflow publishes to npm.

## Rules

- **A lane keeps its order, and nothing else is chosen.** Whatever is added goes into a lane; nothing runs outside
  one, and nothing reorders what is in one.
- **A run is the same for the same choices.** Nothing reads the time it is, a random number that was not seeded,
  or anything left by another run. That is what makes `replay` mean something.
- **No dependencies at run time.** It runs in a window and in Node from one source.
- **Used by apack-link's and apack-state's test kits.** A change to what `Schedule` offers or to how orders are
  counted moves both: change it here, release, and move their pins.
- **A spec says what holds, not how.**

## Commands

```bash
npm run typecheck
npm test
npm run build
npm run package:smoke
npm run workflows:check
```
