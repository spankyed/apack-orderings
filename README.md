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

> **The soundness trade:** Untracked scenarios run plain unreduced search by construction — DPOR never runs unless a task opts into `{ tracked: true }`. Once a scenario opts tasks into `{ tracked: true }`, soundness depends on every shared mutable read and write being reported with `read()`/`write()`; a missed declaration silently skips real orderings. `auditIndependence()` is a sampled probe that catches most omissions loudly, not a formal proof.

A scenario is a function of a `Schedule` that builds what it checks and returns what must hold at rest.

| | |
|---|---|
| `later(lane, run, { tracked? })` | Runs something after whatever is ahead of it in its lane. This is what the code under test is handed in place of a microtask or a timer: a `Lane` is `{ label }`, and one lane is one thing that keeps its order, such as one direction of a connection. Pass `{ tracked: true }` only from adapters that instrument all shared state with `read`/`write` (give distinct dynamically-created lanes distinct labels for best reduction) |
| `does(label, ...steps)` | A lane of the spec's own: things done one after another, such as what a user clicks. Pass a string for globally conflicting steps, or `{ label, tracked: true }` when every step goes through tracked state |
| `work(label, value, { tracked? })` | Outside work in a lane of its own: a promise that resolves, with this value, when the schedule gets to it |
| `breaks(label, error, { tracked? })` | The same, for work that fails |
| `outside()` | Says something outside the schedule is under way, such as a message on a real socket. The run does not come to rest until what it returns is called; if never called, the run waits indefinitely |
| `resource(label?)` | Allocates a run-scoped opaque `Resource` token for dynamic `read()`/`write()` conflict tracking under wakeup-tree DPOR |
| `read(resource)` / `write(resource)` | Records that the current task (or its settled microtasks) read or wrote `resource`. Concurrent reads commute; read/write and write/write conflict |
| `clock` | The scenario's clock: `now()`, `monotonic()`, `after(ms, run)` and `sleep(ms, { signal? })`. It moves only when the schedule runs one of its timers, in the order they are due, so no test waits on real time. Timer scheduling, cancellation, and firing are currently globally conflicting under reduction for soundness (guard a shared `AbortController` with a `Resource` if a tracked task may abort it before `sleep()` is called) |

What is in one lane keeps its order. Between lanes the schedule chooses, and that is all it may choose.

## Running one

| | |
|---|---|
| `everyOrder(scenario, { limit?, reduce? })` | Runs every order (or reduced equivalence classes via wakeup-tree DPOR when tasks opt into `{ tracked: true }` and `reduce !== false`) and throws for the first that fails, naming each step of it and the choices to replay it with. Returns how many orders were run. Throws past `limit` (50 000 unless given; positive safe integer or `Infinity`) |
| `explore(scenario, { limit?, reduce? })` | The same without throwing: `{ orderings, complete, reduced?, failure? }` |
| `sample(scenario, { seed, runs })` | Orders drawn at random from a 32-bit unsigned integer `seed` for `runs` (positive safe integer), the same ones for the same seed, for a scenario with too many to run them all |
| `replay(scenario, choices)` | One order: the choices a failure came back with. Throws `RangeError` if any choice is negative, non-integer, or out of range, or if the recording is stale (ran out of choices or left unused trailing choices) |
| `auditIndependence(scenario, { seed?, runs?, swaps? })` | Samples traces and swaps adjacent supposedly-independent `{ tracked: true }` steps, catching hidden shared state or disabling bugs loudly (checks pass/fail error identity, ready lanes, step labels, and recorded accesses; silent state divergence that does not affect those or `check()` assertions cannot be observed) |

## What holds

- **Every order once — or reduced equivalence classes under DPOR.** Only a real choice is counted, so two lanes of two steps are six orders and not sixteen. Untracked scenarios fall back directly to plain unreduced search (sound by construction); when adapters opt tasks into `{ tracked: true }` and record `read()`/`write()` on `schedule.resource()` tokens, wakeup-tree DPOR (Abdulla et al., 2017) explores equivalence classes for non-timer lanes while keeping timer scheduling, cancellation, and firing globally conflicting for soundness.
- **Promises settle between steps.** After each thing run, everything that can settle does before the next is
  chosen, so what a step's promise chain does belongs to that step. Post-condition checks may be synchronous or `async`.
- **A run that never comes to rest is a failure**, after 10 000 steps, and not a hang. Pending `sleep()` abort
  listeners are detached even if a run throws or hits the runaway guard.
- **Runs do not share anything.** Two explorations under way at once do not disturb each other.
- **Full `@apackdev/clock` parity.** `schedule.clock` exposes frozen `now()`, `monotonic()`, `after()`, and `sleep()`,
  rejects non-finite waits and overflowing deadlines with `RangeError`, and supports `AbortSignal` on `sleep()`.
- **No dependencies**, and it runs in Node, Chromium, Firefox, WebKit, and dedicated Web Workers from one source.

## How it is checked

- **Cross-runtime specs:** unit specs ([tests/orderings.spec.ts](tests/orderings.spec.ts), [tests/dpor.spec.ts](tests/dpor.spec.ts)), Node child-process exit
  specs ([tests/node-exit.spec.ts](tests/node-exit.spec.ts)), and dedicated Web Worker specs
  ([tests/worker.spec.ts](tests/worker.spec.ts)) run in Node on Linux, macOS, and Windows, and in Chromium, Firefox,
  and WebKit.
- **Differential fuzzing:** `npm run fuzz` compares wakeup-tree DPOR against unreduced exploration across randomized
  nested, timer, and data-dependent branching programs (and nightly CI rotates the seed across 2,100 programs).
- **Every mutant is caught:** `npm run mutants` mutates `src/` and fails CI if a single mutant survives.
- **Packaging & floor types:** `package:check` verifies byte-for-byte build determinism and size ceilings;
  `package:lint` runs `publint` and `attw`; `package:smoke` typechecks the packed tarball against TypeScript `>= 5.7`
  for browser (`ES2023+DOM`, `types: []`), Web Worker (`ES2023+WebWorker`, `types: []`), and Node (`ES2023`) consumers
  and runs the README example.

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
