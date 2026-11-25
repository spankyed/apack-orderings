// A schedule a spec gives what it checks in place of the event loop, so that the order things happen in is chosen
// and not left to timing. Everything put off goes into a lane: what crosses a connection one way is one, and so is
// what one system does in turn. A spec adds lanes of its own: what a user does, and outside work that finishes when
// the schedule gets to it.
//
// What is in one lane keeps its order. Between lanes the schedule chooses, and `explore` runs a scenario once for
// every way of choosing. A failure comes back with the choices that led to it, and `replay` runs exactly those again.
//
// Time is the schedule's too. A scenario's clock moves only when the schedule runs one of its timers, which wait in a
// lane of their own in the order they are due: a timer falls in every place among everything else, and what is due
// sooner fires first.

/**
 * Things that happen one after another: what crosses a connection in one direction. What is in one lane keeps its
 * order, as messages on one socket do. What is in two lanes can come in either order, and that is the whole of what a
 * schedule may choose.
 */
export interface Lane { readonly label: string }

type Task = { readonly what: string; run(): void }

/** A clock a schedule owns: it reads what its timers have moved it to, and never the time it is. */
export interface Clock {
  /** How long since the scenario began, in milliseconds: the time the last timer to fire was set for. */
  now(): number
  /** Monotonic time since the scenario began, in milliseconds: matches `now()` on a schedule clock. */
  monotonic(): number
  /**
   * Runs `run` once, `ms` from now, when the schedule gets to it. Returns an idempotent cancel function.
   * Negative finite waits are treated as `0`. Throws `RangeError` for a non-finite `ms` or overflowing deadline.
   */
  after(ms: number, run: () => void): () => void
  /**
   * Resolves `ms` from now, when the schedule gets to it. Rejects with `RangeError` for a non-finite `ms` or
   * overflowing deadline, or with `options.signal.reason` if aborted.
   */
  sleep(ms: number, options?: { readonly signal?: AbortSignal }): Promise<void>
}

export interface Schedule {
  /** Runs something after whatever is ahead of it in its lane. What a system or a link is given as `later`. */
  later(lane: Lane, run: () => void): void
  /** A lane of the spec's own: things done one after another, such as what a user clicks. */
  does(label: string, ...steps: ReadonlyArray<readonly [what: string, run: () => void]>): void
  /** Outside work, in a lane of its own: it is done, with this value, when the schedule gets to it. */
  work<T>(label: string, value: T): Promise<T>
  /** The same, for work that fails. */
  breaks(label: string, error: Error): Promise<never>
  /**
   * Something outside the schedule is under way, such as a message on a real socket: the run does not come to rest
   * until what is returned is called. What it does when it lands, it puts into a lane, and the schedule chooses as
   * ever. Nothing outside is chosen: it lands when it lands.
   */
  outside(): () => void
  /** The scenario's clock, which the schedule moves. */
  readonly clock: Clock
}

/** What a scenario is: it builds what it checks from the schedule, and returns what must hold once all is at rest. */
export type Scenario = (schedule: Schedule) => () => void | Promise<void>

/** How one run went: each choice made, how many there were to choose from, and what was run, in order. */
interface Run { choices: number[]; counts: number[]; taken: string[]; error?: unknown }

/**
 * Lets every promise that can settle do so: a message is delivered on a turn of the event loop, which comes after all
 * of them. Lazily created on the first run so importing the module allocates no handle; in Node, `port1` is reffed
 * only while at least one run is active so an idle process can exit cleanly.
 */
let turn: InstanceType<typeof MessageChannel> | undefined
let hold: { onmessage: (() => void) | null; ref?(): void; unref?(): void } | undefined
const onTurns: Array<() => void> = []
let activeRuns = 0
const ensureTurn = (): void => {
  if (!turn) {
    turn = new MessageChannel()
    hold = turn.port1 as unknown as { onmessage: (() => void) | null; ref?(): void; unref?(): void }
    hold.onmessage = () => { onTurns.shift()!() }
  }
}
const settled = (): Promise<void> => new Promise((resolve) => { onTurns.push(resolve); turn!.port2.postMessage(0) })

/** More than this in one run is two things telling each other forever. */
const RUNAWAY = 10_000

const assertFiniteWait = (ms: number): void => {
  if (!Number.isFinite(ms)) throw new RangeError(`A clock expects a finite wait in milliseconds, and was given ${String(ms)}`)
}

async function once(scenario: Scenario, choose: (depth: number, among: number) => number): Promise<Run> {
  const lanes = new Map<object, Task[]>()
  const into = (lane: object, task: Task): void => { (lanes.get(lane) ?? lanes.set(lane, []).get(lane)!).push(task) }
  // The clock's timers: a lane kept in the order they are due, and of two due at once, the one set first.
  let time = 0
  const timers: Array<Task & { readonly due: number }> = []
  const clockLane = {}
  const sleepCleanups = new Set<() => void>()
  const clock: Clock = Object.freeze<Clock>({
    now: () => time,
    monotonic: () => time,
    after: (ms, run) => {
      assertFiniteWait(ms)
      const due = time + Math.max(0, ms)
      if (!Number.isFinite(due)) throw new RangeError(`A clock wait of ${String(ms)} ms overflows the scenario clock`)
      const timer = { what: `the clock: ${due} ms`, due, run: () => { time = due; run() } }
      let at = timers.length
      while (at > 0 && timers[at - 1]!.due > due) at--
      timers.splice(at, 0, timer)
      lanes.set(clockLane, timers)
      return () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1) }
    },
    sleep: (ms, options) => new Promise((resolve, reject) => {
      assertFiniteWait(ms)
      const signal = options?.signal
      if (signal?.aborted) { reject(signal.reason); return }
      let cancel: () => void
      const cleanup = (): void => {
        sleepCleanups.delete(cleanup)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        cleanup()
        cancel()
        reject(signal!.reason)
      }
      cancel = clock.after(ms, () => {
        cleanup()
        resolve()
      })
      if (signal) {
        sleepCleanups.add(cleanup)
        signal.addEventListener('abort', onAbort)
      }
    }),
  })
  let away = 0
  let landed: (() => void) | undefined
  const schedule: Schedule = Object.freeze<Schedule>({
    clock,
    later: (lane, run) => into(lane, { what: lane.label, run }),
    does: (label, ...steps) => { const lane = {}; for (const [what, run] of steps) into(lane, { what: `${label}: ${what}`, run }) },
    work: (label, value) => new Promise((resolve) => { into({}, { what: label, run: () => resolve(value) }) }),
    breaks: (label, error) => new Promise((_, reject) => { into({}, { what: label, run: () => reject(error) }) }),
    outside: () => {
      away++
      let done = false
      return () => {
        if (done) return
        done = true
        away--
        const wake = landed
        landed = undefined
        wake?.()
      }
    },
  })
  const made: Run = { choices: [], counts: [], taken: [] }
  if (++activeRuns === 1) { ensureTurn(); hold!.ref?.() }
  try {
    const check = scenario(schedule)
    for (;;) {
      await settled()
      const ready = [...lanes.values()].filter((waiting) => waiting.length)
      if (!ready.length && away) { await new Promise<void>((resolve) => { landed = resolve }); continue }
      if (!ready.length) break
      if (made.taken.length >= RUNAWAY) throw new Error(`Still going after ${RUNAWAY} things: something never comes to rest`)
      // Only a real choice is written down, so that the choices are as short as the ordering they name.
      let chosen = 0
      if (ready.length > 1) { chosen = choose(made.choices.length, ready.length); made.choices.push(chosen); made.counts.push(ready.length) }
      const task = ready[chosen]!.shift()!
      made.taken.push(task.what)
      task.run()
    }
    await check()
  } catch (error) { made.error = error } finally {
    for (const cleanup of [...sleepCleanups]) cleanup()
    if (--activeRuns === 0) hold!.unref?.()
  }
  return made
}

export interface Explored {
  /** How many orderings were run. */
  readonly orderings: number
  /** Whether that was every one. False when a failure stopped it, or the limit did. */
  readonly complete: boolean
  readonly failure?: { readonly choices: readonly number[]; readonly taken: readonly string[]; readonly error: unknown }
}

/**
 * Runs a scenario under every ordering its lanes allow, stopping at the first that fails. The scenario builds what it
 * checks from the schedule it is handed, and returns what must hold once everything has come to rest.
 */
export async function explore(scenario: Scenario, options: { limit?: number } = {}): Promise<Explored> {
  const limit = options.limit ?? 50_000
  if (!(limit === Number.POSITIVE_INFINITY || (Number.isSafeInteger(limit) && limit >= 1))) {
    throw new RangeError(`explore expects limit to be a positive safe integer or Infinity, and was given ${String(limit)}`)
  }
  let prefix: number[] = []
  for (let orderings = 1; ; orderings++) {
    const made = await once(scenario, (depth) => prefix[depth] ?? 0)
    if ('error' in made) return { orderings, complete: false, failure: { choices: made.choices, taken: made.taken, error: made.error } }
    // The next ordering: the last choice that had another way to go, taken that way, and everything after it afresh.
    let last = made.choices.length - 1
    // Stryker disable next-line ConditionalExpression: at last === -1, undefined + 1 is NaN and NaN >= undefined is false.
    while (last >= 0 && made.choices[last]! + 1 >= made.counts[last]!) last--
    if (last < 0) return { orderings, complete: true }
    if (orderings >= limit) return { orderings, complete: false }
    prefix = [...made.choices.slice(0, last), made.choices[last]! + 1]
  }
}

/** Runs a scenario under orderings chosen at random from a seed, for one with too many to run them all. */
export async function sample(scenario: Scenario, options: { seed: number; runs: number }): Promise<Explored> {
  const { seed, runs } = options
  if (!Number.isFinite(seed)) throw new RangeError(`sample expects a finite seed, and was given ${String(seed)}`)
  if (!Number.isSafeInteger(runs) || runs < 1) throw new RangeError(`sample expects runs to be a positive safe integer, and was given ${String(runs)}`)
  let state = seed >>> 0
  const random = (): number => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  for (let orderings = 1; orderings <= runs; orderings++) {
    const made = await once(scenario, (_, among) => Math.floor(random() * among))
    if ('error' in made) return { orderings, complete: false, failure: { choices: made.choices, taken: made.taken, error: made.error } }
  }
  return { orderings: runs, complete: false }
}

/** Runs a scenario under one ordering: the choices a failure came back with. Returns what it threw, if it did. */
export async function replay(scenario: Scenario, choices: readonly number[]): Promise<{ taken: readonly string[]; error?: unknown }> {
  for (let index = 0; index < choices.length; index++) {
    const choice = choices[index]!
    if (!Number.isSafeInteger(choice) || choice < 0) {
      throw new RangeError(`replay expects non-negative safe integer choices, and got ${String(choice)} at index ${index}`)
    }
  }
  let choiceError: RangeError | undefined
  const made = await once(scenario, (depth, among) => {
    const choice = choices[depth] ?? 0
    if (choice >= among) {
      choiceError = new RangeError(`replay choice ${choice} at depth ${depth} is out of range for ${among} ready lanes`)
      throw choiceError
    }
    return choice
  })
  if (choiceError) throw choiceError
  return 'error' in made ? { taken: made.taken, error: made.error } : { taken: made.taken }
}

/**
 * Runs a scenario under every ordering and throws for the first that fails, naming the order that led to it and the
 * choices to `replay` it with. Returns how many orderings there were. Past `limit` it throws too: a scenario too
 * wide to run whole is one to `sample`, said where it is written.
 */
export async function everyOrder(scenario: Scenario, options: { limit?: number } = {}): Promise<number> {
  const explored = await explore(scenario, options)
  if (explored.failure) {
    const { choices, taken, error } = explored.failure
    throw new Error(`Failed in ordering ${explored.orderings} (replay with [${choices.join(', ')}]):\n  ${taken.join('\n  ')}\n${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!explored.complete) throw new Error(`More than ${explored.orderings} orderings: too many to run them all`)
  return explored.orderings
}
