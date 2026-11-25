# @apackdev/orderings

Runs a scenario under every order its parts can happen in, and says which order failed.

Code that waits on more than one thing (a message each way on a connection, a user's click, work that finishes
later) is right only if it is right in every order those can land in. A test that runs it once checks one order,
the one the event loop happened to choose. This runs all of them, each exactly once, and a failure comes back with
the choices that led to it, to run that one order again.

```ts
import { everyOrder } from '@apackdev/orderings'

// Two tabs each add one to a count they read a moment before: one of them can be lost.
const failed = await everyOrder((schedule) => {
  let count = 0
  const tab = (name: string): void => {
    let read = 0
    // A lane: what is in it keeps its order, and the schedule chooses between lanes.
    schedule.does(name, ['reads', () => { read = count }], ['writes', () => { count = read + 1 }])
  }
  tab('a')
  tab('b')
  // What must hold once everything has come to rest.
  return () => { if (count !== 2) throw new Error(`the count is ${count}`) }
}).catch((error: Error) => error.message)

console.log(failed)
```

That prints the first order that breaks it, each step in turn, and the choices to `replay` it with:

```text
Failed in ordering 2 (replay with [0, 1, 0]):
  a: reads
  b: reads
  a: writes
  b: writes
the count is 1
```

## What a scenario is given

A scenario is a function of a `Schedule` that builds what it checks and returns what must hold at rest.

| | |
|---|---|
| `later(lane, run)` | Runs something after whatever is ahead of it in its lane. This is what the code under test is handed in place of a microtask or a timer: a `Lane` is `{ label }`, and one lane is one thing that keeps its order, such as one direction of a connection |
| `does(label, ...steps)` | A lane of the spec's own: things done one after another, such as what a user clicks |
| `work(label, value)` | Outside work in a lane of its own: a promise that resolves, with this value, when the schedule gets to it |
| `breaks(label, error)` | The same, for work that fails |
| `outside()` | Says something outside the schedule is under way, such as a message on a real socket. The run does not come to rest until what it returns is called; if never called, the run waits indefinitely |
| `clock` | The scenario's clock: `now()`, `monotonic()`, `after(ms, run)` and `sleep(ms, { signal? })`. It moves only when the schedule runs one of its timers, in the order they are due, so no test waits on real time |

What is in one lane keeps its order. Between lanes the schedule chooses, and that is all it may choose.

## Running one

| | |
|---|---|
| `everyOrder(scenario, { limit? })` | Runs every order and throws for the first that fails, naming each step of it and the choices to replay it with. Returns how many orders there were. Throws past `limit` (50 000 unless given; positive safe integer or `Infinity`): a scenario too wide to run whole is one to `sample`, said where it is written |
| `explore(scenario, { limit? })` | The same without throwing: `{ orderings, complete, failure? }` |
| `sample(scenario, { seed, runs })` | Orders drawn at random from a 32-bit unsigned integer `seed` for `runs` (positive safe integer), the same ones for the same seed, for a scenario with too many to run them all |
| `replay(scenario, choices)` | One order: the choices a failure came back with. Throws `RangeError` if any choice is negative, non-integer, or out of range, or if the recording is stale (ran out of choices or left unused trailing choices) |

## What holds

- **Every order once.** Only a real choice is counted, so two lanes of two steps are six orders and not sixteen.
- **Promises settle between steps.** After each thing run, everything that can settle does before the next is
  chosen, so what a step's promise chain does belongs to that step. Post-condition checks may be synchronous or `async`.
- **A run that never comes to rest is a failure**, after 10 000 steps, and not a hang. Pending `sleep()` abort
  listeners are detached even if a run throws or hits the runaway guard.
- **Runs do not share anything.** Two explorations under way at once do not disturb each other.
- **Full `@apackdev/clock` parity.** `schedule.clock` exposes frozen `now()`, `monotonic()`, `after()`, and `sleep()`,
  rejects non-finite waits and overflowing deadlines with `RangeError`, and supports `AbortSignal` on `sleep()`.
- **No dependencies**, and it runs in Node, Chromium, Firefox, WebKit, and dedicated Web Workers from one source.

## How it is checked

- **Cross-runtime specs:** unit specs ([tests/orderings.spec.ts](tests/orderings.spec.ts)), Node child-process exit
  specs ([tests/node-exit.spec.ts](tests/node-exit.spec.ts)), and dedicated Web Worker specs
  ([tests/worker.spec.ts](tests/worker.spec.ts)) run in Node on Linux, macOS, and Windows, and in Chromium, Firefox,
  and WebKit.
- **Every mutant is caught:** `npm run mutants` mutates `src/` and fails CI if a single mutant survives.
- **Packaging & floor types:** `package:check` verifies byte-for-byte build determinism and size ceilings;
  `package:lint` runs `publint` and `attw`; `package:smoke` typechecks the packed tarball against TypeScript `>= 5.7`
  for both browser (`ES2023+DOM`, `types: []`) and Node (`ES2023`) consumers and runs the README example.

## Requirements & installing

- **Runtime:** Node `>= 24.12.0`, or any browser / Web Worker with `MessageChannel` and `AbortSignal`.
- **Types:** TypeScript `>= 5.7` (tested against `ES2023` consumers with `skipLibCheck: false` and no `ESNext.Disposable`).

It is not on npm. Each `master` commit whose CI passed has a prerelease, `pkg-<commit>`, holding the package as
`npm pack` writes it, and a consumer installs it by that asset's URL:

```json
"@apackdev/orderings": "https://github.com/spankyed/apack-orderings/releases/download/pkg-<commit>/apackdev-orderings-0.1.0.tgz"
```

## License

MIT or Apache-2.0, at your option.
