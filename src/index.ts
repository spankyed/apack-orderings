// A schedule a spec gives what it checks in place of the event loop, so that the order things happen in is chosen
// and not left to timing. Everything put off goes into a lane: what crosses a connection one way is one, and so is
// what one system does in turn. A spec adds lanes of its own: what a user does, and outside work that finishes when
// the schedule gets to it.
//
// What is in one lane keeps its order. Between lanes the schedule chooses, and `explore` runs a scenario once for
// every way of choosing (or once per equivalence class via Optimal DPOR when tasks opt into `{ tracked: true }` and
// report resource accesses with `read`/`write`). A failure comes back with the choices that led to it, and `replay`
// runs exactly those again.
//
// Time is the schedule's too. A scenario's clock moves only when the schedule runs one of its timers, which wait in a
// lane of their own in the order they are due: a timer falls in every place among everything else, and what is due
// sooner fires first.
import {
  conflicts,
  findWakeups,
  insertWut,
  makeAccess,
  makeWutNode,
  type StepAccess,
  type TraceStep,
  type WutNode,
} from './dpor.ts'

/**
 * Things that happen one after another: what crosses a connection in one direction. What is in one lane keeps its
 * order, as messages on one socket do. What is in two lanes can come in either order, and that is the whole of what a
 * schedule may choose.
 */
export interface Lane { readonly label: string }

/** An opaque resource token created by `schedule.resource()` for dynamic `read()`/`write()` conflict tracking. */
export interface Resource {
  readonly label?: string
  readonly [RESOURCE_BRAND]?: true
}
declare const RESOURCE_BRAND: unique symbol

/** Options for scheduling a task under optional dynamic partial-order reduction. */
export interface TaskOptions {
  /**
   * Marks this task as tracked: instead of conflicting globally with every other task, its conflicts are determined
   * solely by its lane order, enabling causality, and the `read()`/`write()` resource accesses recorded while it runs
   * (and while its settled microtasks run). Only set by adapters that instrument all shared state touched by the task.
   * Defaults to `false` (global conflict, sound by default).
   */
  readonly tracked?: boolean
}

type Task = {
  readonly what: string
  readonly tracked: boolean
  readonly pushedBy: number
  run(): void
}

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
  after(ms: number, run: () => void, options?: TaskOptions): () => void
  /**
   * Resolves `ms` from now, when the schedule gets to it. Rejects with `RangeError` for a non-finite `ms` or
   * overflowing deadline, or with `options.signal.reason` if aborted. Aborts after `sleep()` is called are tracked
   * automatically; if a tracked task can abort the `AbortController` before `sleep()` is even called, guard that
   * controller with a `Resource`.
   */
  sleep(ms: number, options?: { readonly signal?: AbortSignal; readonly tracked?: boolean }): Promise<void>
}

export interface Schedule {
  /**
   * Runs something after whatever is ahead of it in its lane. What a system or a link is given as `later`.
   * Dynamically created lanes (first pushed inside a step rather than setup) fall back to label-based push conflict
   * tracking, so distinct dynamic lanes should use distinct labels for best reduction.
   */
  later(lane: Lane, run: () => void, options?: TaskOptions): void
  /**
   * A lane of the spec's own: things done one after another, such as what a user clicks. Pass a string label for
   * globally conflicting steps (default), or `{ label, tracked: true }` when every action goes through tracked state.
   */
  does(label: string | (Lane & TaskOptions), ...steps: ReadonlyArray<readonly [what: string, run: () => void]>): void
  /** Outside work, in a lane of its own: it is done, with this value, when the schedule gets to it. */
  work<T>(label: string, value: T, options?: TaskOptions): Promise<T>
  /** The same, for work that fails. */
  breaks(label: string, error: Error, options?: TaskOptions): Promise<never>
  /**
   * Something outside the schedule is under way, such as a message on a real socket: the run does not come to rest
   * until what is returned is called. What it does when it lands, it puts into a lane, and the schedule chooses as
   * ever. Nothing outside is chosen: it lands when it lands. If the returned callback is never called, the run waits
   * indefinitely (the runaway guard counts tasks, not wall time).
   */
  outside(): () => void
  /**
   * Allocates a run-scoped opaque resource token for `read()`/`write()` conflict tracking. Allocate once per shared
   * state boundary (e.g. per system, store, or ref) inside the scenario.
   */
  resource(label?: string): Resource
  /**
   * Records that the currently running task read `resource`. Concurrent reads of the same resource commute; a read
   * conflicts with any write to the same resource. Safe no-op outside a task.
   */
  read(resource: Resource): void
  /**
   * Records that the currently running task wrote `resource`. A write conflicts with any read or write to the same
   * resource. Safe no-op outside a task.
   */
  write(resource: Resource): void
  /** The scenario's clock, which the schedule moves. */
  readonly clock: Clock
}

/** What a scenario is: it builds what it checks from the schedule, and returns what must hold once all is at rest. */
export type Scenario = (schedule: Schedule) => () => void | Promise<void>

/** Options for `explore()` and `everyOrder()`. */
export interface ExploreOptions {
  /** Maximum orderings to run before stopping incomplete. Positive safe integer or `Infinity` (default `50_000`). */
  readonly limit?: number
  /**
   * When `true` (default), uses Optimal DPOR to explore one representative ordering per equivalence class whenever
   * tasks opt into `{ tracked: true }`. Set `false` to explore every linear interleaving regardless of tracking.
   */
  readonly reduce?: boolean
}

/** Options for `auditIndependence()`. */
export interface AuditOptions {
  /** 32-bit unsigned integer seed for sampling traces to audit (default `1`). */
  readonly seed?: number
  /** Number of random traces to sample and inspect (default `20`). */
  readonly runs?: number
  /** Maximum adjacent supposedly-independent swaps to verify across all sampled traces (default `50`). */
  readonly swaps?: number
}

/** Result of `auditIndependence()`. */
export interface AuditResult {
  /** How many sampled traces were inspected. */
  readonly runs: number
  /** How many adjacent supposedly-independent pairs were swapped and verified to commute. */
  readonly checked: number
  /** First detected unsound independence violation, if any. */
  readonly violation?: {
    /** Full choices of the original trace, directly passable to `replay()`. */
    readonly choices: readonly number[]
    /** Choices leading up to the swapped pair. */
    readonly prefix: readonly number[]
    readonly first: string
    readonly second: string
    readonly reason: string
  }
}

/** How one run went: choices, ready counts, executed trace steps, whether any task was tracked, and any error thrown. */
interface Run {
  choices: number[]
  counts: number[]
  taken: string[]
  steps: TraceStep[]
  anyTracked: boolean
  error?: unknown
}

/** Internal control-flow sentinel thrown to abort a sleep-set-blocked branch cleanly inside `exploreOptimal`. */
const SLEEP_BLOCKED = Symbol('sleepBlocked')

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

const assertUint32 = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} expects seed to be a 32-bit unsigned integer, and was given ${String(value)}`)
  }
}

const assertPositiveInt = (fn: string, field: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${fn} expects ${field} to be a positive safe integer, and was given ${String(value)}`)
  }
}

const makePrng = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const makeCounter = (): (() => number) => {
  let n = 0
  // Stryker disable next-line UpdateOperator: counting up vs down yields an isomorphic bijection of opaque unique IDs.
  return () => n++
}

type ReadyLane = { readonly laneId: string; readonly queue: Task[] }
type StepChooser = (stepDepth: number, choiceDepth: number, ready: readonly ReadyLane[], prevStep?: TraceStep) => number

async function once(scenario: Scenario, choose: StepChooser, chooseSingle = false): Promise<Run> {
  const lanes = new Map<string, Task[]>()
  const laneIds = new Map<object, string>()
  const laneSeqs = new Map<string, number>()
  const resourceIds = new Map<Resource, string>()

  const nextSetupSpawn = makeCounter()
  const nextSetupResource = makeCounter()
  const nextSetupTimer = makeCounter()
  let away = 0
  let landed: (() => void) | undefined
  let activeStep: {
    readonly index: number
    readonly laneId: string
    readonly laneSeq: number
    readonly access: StepAccess
    readonly nextSpawn: () => number
    readonly nextResource: () => number
    readonly nextTimer: () => number
    preemptedClock: boolean
  } | undefined

  const recordReadId = (id: string): void => { activeStep?.access.reads.add(id) }
  const recordWriteId = (id: string): void => { activeStep?.access.writes.add(id) }
  const resolveResource = (resource: Resource): string => {
    const id = resourceIds.get(resource)
    if (!id) throw new Error('Resource does not belong to this schedule run; allocate it with schedule.resource() inside the scenario')
    return id
  }
  const wake = (): void => {
    const pending = landed
    landed = undefined
    pending?.()
  }
  const idFor = (lane: object): string => {
    let id = laneIds.get(lane)
    if (!id) {
      id = activeStep ? `${activeStep.laneId}.${activeStep.laneSeq}:${activeStep.nextSpawn()}` : `0:${nextSetupSpawn()}`
      laneIds.set(lane, id)
    }
    return id
  }

  let completedSteps = 0
  const pushedByNow = (): number => (activeStep ? activeStep.index : completedSteps - 1)

  const into = (lane: object, what: string, tracked: boolean, run: () => void, shared = false): void => {
    const id = idFor(lane)
    if (shared) recordWriteId(id.includes('.') ? `push:dyn:${what}` : `push:${id}`)
    ;(lanes.get(id) ?? lanes.set(id, []).get(id)!).push({ what, tracked, pushedBy: pushedByNow(), run })
    wake()
  }

  // The clock's timers: a lane kept in the order they are due, and of two due at once, the one set first.
  let time = 0
  const timers: Array<Task & { readonly due: number }> = []
  const sleepCleanups = new Set<() => void>()
  const scheduleTimer = (ms: number, run: () => void, options?: TaskOptions): { readonly cancel: () => void; readonly timerId: string } => {
    assertFiniteWait(ms)
    recordReadId('sys:clock')
    const due = time + Math.max(0, ms)
    if (!Number.isFinite(due)) throw new RangeError(`A clock wait of ${String(ms)} ms overflows the scenario clock`)
    // Stryker disable next-line StringLiteral: opaque internal conflict key; only scheduleTimer writes it and no other key is empty.
    recordWriteId('push:clock')
    const timerId = activeStep
      ? `timer:${activeStep.laneId}.${activeStep.laneSeq}:${activeStep.nextTimer()}`
      : `timer:0:${nextSetupTimer()}`
    const creator = pushedByNow()
    const timer: Task & { readonly due: number } = {
      what: `the clock: ${due} ms`,
      tracked: options?.tracked === true,
      pushedBy: creator,
      due,
      run: () => {
        recordWriteId(timerId)
        if (due > time) { time = due; recordWriteId('sys:clock') }
        run()
      },
    }
    let at = timers.length
    while (at > 0 && timers[at - 1]!.due > due) at--
    const step = activeStep
    if (step && timers.slice(at).some((existing) => existing.pushedBy !== step.index)) {
      step.preemptedClock = true
    }
    timers.splice(at, 0, timer)
    lanes.set('clock', timers)
    wake()
    return {
      timerId,
      cancel: () => {
        recordWriteId(timerId)
        const index = timers.indexOf(timer)
        if (index >= 0) {
          if (activeStep && creator !== activeStep.index) activeStep.preemptedClock = true
          timers.splice(index, 1)
        }
      },
    }
  }
  const clock: Clock = Object.freeze<Clock>({
    now: () => { recordReadId('sys:clock'); return time },
    monotonic: () => { recordReadId('sys:clock'); return time },
    after: (ms, run, options) => scheduleTimer(ms, run, options).cancel,
    sleep: (ms, options) => new Promise((resolve, reject) => {
      assertFiniteWait(ms)
      const signal = options?.signal
      if (signal?.aborted) { reject(signal.reason); return }
      let cancel!: () => void
      let timerId!: string
      const cleanup = (): void => {
        sleepCleanups.delete(cleanup)
        signal!.removeEventListener('abort', onAbort)
        signal!.removeEventListener('abort', onLateAbort)
      }
      const onLateAbort = (): void => {
        cleanup()
        recordWriteId(timerId)
      }
      const onAbort = (): void => {
        cleanup()
        cancel()
        reject(signal!.reason)
      }
      const scheduled = scheduleTimer(ms, () => {
        if (signal) {
          signal.removeEventListener('abort', onAbort)
          // Keep a passive listener for the rest of this run so a later abort records the race against firing.
          signal.addEventListener('abort', onLateAbort)
        }
        resolve()
      }, options?.tracked ? { tracked: true } : undefined)
      cancel = scheduled.cancel
      timerId = scheduled.timerId
      if (signal) {
        sleepCleanups.add(cleanup)
        signal.addEventListener('abort', onAbort)
      }
    }),
  })
  const schedule: Schedule = Object.freeze<Schedule>({
    clock,
    resource: (label) => {
      const id = activeStep
        ? `res:${activeStep.laneId}.${activeStep.laneSeq}:${activeStep.nextResource()}`
        : `res:0:${nextSetupResource()}`
      const token: Resource = Object.freeze(label === undefined ? {} : { label })
      resourceIds.set(token, id)
      return token
    },
    read: (resource) => { recordReadId(resolveResource(resource)) },
    write: (resource) => { recordWriteId(resolveResource(resource)) },
    later: (lane, run, options) => into(lane, lane.label, options?.tracked === true, run, true),
    does: (head, ...steps) => {
      const [label, tracked] = typeof head === 'string' ? [head, false] : [head.label, head.tracked === true]
      const lane = {}
      for (const [what, run] of steps) into(lane, `${label}: ${what}`, tracked, run)
    },
    work: (label, value, options) => new Promise((resolve) => { into({}, label, options?.tracked === true, () => resolve(value)) }),
    breaks: (label, error, options) => new Promise((_, reject) => { into({}, label, options?.tracked === true, () => reject(error)) }),
    outside: () => {
      recordWriteId('sys:outside')
      away++
      let done = false
      return () => {
        if (done) return
        done = true
        recordWriteId('sys:outside')
        away--
        wake()
      }
    },
  })

  const made: Run = { choices: [], counts: [], taken: [], steps: [], anyTracked: false }
  if (++activeRuns === 1) { ensureTurn(); hold!.ref?.() }
  try {
    const check = scenario(schedule)
    await settled()
    for (;;) {
      const ready: ReadyLane[] = []
      for (const [laneId, queue] of lanes) if (queue.length) ready.push({ laneId, queue })
      if (!ready.length && away) {
        await new Promise<void>((resolve) => { landed = resolve })
        await settled()
        continue
      }
      if (!ready.length) break
      if (made.taken.length >= RUNAWAY) throw new Error(`Still going after ${RUNAWAY} things: something never comes to rest`)
      const stepDepth = made.steps.length
      const prevStep = made.steps[stepDepth - 1]
      let chosen = 0
      if (ready.length > 1) {
        chosen = choose(stepDepth, made.choices.length, ready, prevStep)
        made.choices.push(chosen)
        made.counts.push(ready.length)
      } else if (chooseSingle) {
        chosen = choose(stepDepth, made.choices.length, ready, prevStep)
      }
      const picked = ready[chosen]!
      const task = picked.queue.shift()!
      const laneSeq = laneSeqs.get(picked.laneId) ?? 0
      // Stryker disable next-line ArithmeticOperator: counting up vs down yields an isomorphic bijection of per-lane sequence numbers.
      laneSeqs.set(picked.laneId, laneSeq + 1)
      const access = makeAccess(task.tracked)
      if (task.tracked) made.anyTracked = true
      const readyLaneIds = ready.map((entry) => entry.laneId)
      activeStep = {
        index: stepDepth,
        laneId: picked.laneId,
        laneSeq,
        access,
        nextSpawn: makeCounter(),
        nextResource: makeCounter(),
        nextTimer: makeCounter(),
        preemptedClock: false,
      }
      made.taken.push(task.what)
      try {
        task.run()
        await settled()
      } finally {
        const finished = activeStep
        activeStep = undefined
        made.steps.push({
          laneId: finished.laneId,
          what: task.what,
          pushedBy: task.pushedBy,
          preemptedClock: finished.preemptedClock,
          access: finished.access,
          readyLaneIds,
        })
        completedSteps = made.steps.length
      }
    }
    await check()
  } catch (error) { made.error = error } finally {
    activeStep = undefined
    for (const cleanup of [...sleepCleanups]) cleanup()
    if (--activeRuns === 0) hold!.unref?.()
  }
  return made
}

export interface Explored {
  /** How many orderings were run. */
  readonly orderings: number
  /** Whether that was every one (or every equivalence class when `reduced` is `true`). False when a failure or limit stopped it. */
  readonly complete: boolean
  /** Present and `true` when Optimal DPOR skipped at least one redundant interleaving. */
  readonly reduced?: true
  readonly failure?: { readonly choices: readonly number[]; readonly taken: readonly string[]; readonly error: unknown }
}

/** Unreduced exhaustive prefix search (used when `reduce: false` or when no task opted into `{ tracked: true }`). */
async function exploreUnreduced(scenario: Scenario, limit: number, first: Run): Promise<Explored> {
  let made = first
  for (let orderings = 1; ; orderings++) {
    if ('error' in made) return { orderings, complete: false, failure: { choices: made.choices, taken: made.taken, error: made.error } }
    let last = made.choices.length - 1
    // Stryker disable next-line ConditionalExpression: at last === -1, undefined + 1 is NaN and NaN >= undefined is false.
    while (last >= 0 && made.choices[last]! + 1 >= made.counts[last]!) last--
    if (last < 0) return { orderings, complete: true }
    if (orderings >= limit) return { orderings, complete: false }
    const prefix = [...made.choices.slice(0, last), made.choices[last]! + 1]
    made = await once(scenario, (_, depth) => prefix[depth] ?? 0)
  }
}

/** Optimal DPOR exploration with wakeup trees (Abdulla et al., JACM 2017, Algorithm 2). */
async function exploreOptimal(scenario: Scenario, limit: number, first: Run): Promise<Explored> {
  interface Frame {
    readonly sleep: Map<string, StepAccess>
    readonly wut: WutNode
    readonly readyCount: number
    exploredCount: number
  }

  let orderings = 1
  let wasReduced = false
  let failure: Explored['failure']
  let hitLimit = false
  const stack: Frame[] = []

  const finishBranch = async (
    steps: readonly TraceStep[],
    baseDepth: number,
    observedParent: StepAccess | undefined,
  ): Promise<StepAccess | undefined> => {
    // Detect reversible races along the full trace and insert wakeup sequences into each frame's wakeup tree.
    for (const { depth, seq, whenClockSleeping } of findWakeups(steps)) {
      const frame = stack[depth]!
      if (whenClockSleeping && !frame.sleep.has('clock')) continue
      insertWut(frame.wut, frame.sleep, seq)
    }

    // Backtrack through frames added by this branch in reverse depth order.
    for (let d = stack.length - 1; d >= baseDepth; d--) {
      const frame = stack[d]!
      const firstChild = frame.wut.children.shift()!
      frame.sleep.set(firstChild.laneId, steps[d]!.access)
      while (frame.wut.children.length > 0) {
        if (orderings >= limit) { hitLimit = true; stack.length = baseDepth; return observedParent }
        const next = frame.wut.children[0]!
        frame.exploredCount++
        const nextPrefix = steps.slice(0, d).map((s) => s.laneId)
        nextPrefix.push(next.laneId)
        const observed = await runBranch(nextPrefix, next.node, frame.sleep)
        if (failure || hitLimit) { stack.length = baseDepth; return observedParent }
        // `next` was fully explored: pop it and move its observed access into `frame.sleep`.
        frame.wut.children.shift()
        frame.sleep.set(next.laneId, observed!)
      }
      if (frame.readyCount > frame.exploredCount) wasReduced = true
      stack.pop()
    }
    return observedParent
  }

  const runBranch = async (
    prefixLanes: readonly string[],
    branchWut: WutNode,
    parentSleep: ReadonlyMap<string, StepAccess>,
  ): Promise<StepAccess | undefined> => {
    const sleepByDepth = new Map<number, Map<string, StepAccess>>()
    const wutByDepth = new Map<number, WutNode>()
    let cursor: WutNode = branchWut
    let replayError: Error | undefined

    const pickLane = (ready: readonly ReadyLane[], want: string, stepDepth: number): number => {
      const index = ready.findIndex((entry) => entry.laneId === want)
      if (index < 0) {
        replayError = new Error(`Unsound tracked task: expected lane "${want}" to be enabled at depth ${stepDepth}`)
        throw replayError
      }
      return index
    }

    const made = await once(scenario, (stepDepth, _choiceDepth, ready, prevStep) => {
      if (stepDepth < prefixLanes.length) return pickLane(ready, prefixLanes[stepDepth]!, stepDepth)
      // Compute sleep set for `stepDepth` from the previous step's actual observed access.
      const prevSleep = stepDepth === prefixLanes.length ? parentSleep : sleepByDepth.get(stepDepth - 1)!
      const filtered = new Map<string, StepAccess>()
      for (const [laneId, access] of prevSleep) {
        // Stryker disable next-line ConditionalExpression: prevStep is always defined when prevSleep is non-empty, and Optimal DPOR never picks a sleeping lane.
        if (laneId !== prevStep!.laneId && !conflicts(access, prevStep!.access)) filtered.set(laneId, access)
      }
      sleepByDepth.set(stepDepth, filtered)

      wutByDepth.set(stepDepth, cursor)
      if (cursor.children.length > 0) {
        const firstChild = cursor.children[0]!
        const index = pickLane(ready, firstChild.laneId, stepDepth)
        cursor = firstChild.node
        return index
      }
      const sleep = sleepByDepth.get(stepDepth)!
      const index = ready.findIndex((entry) => !sleep.has(entry.laneId))
      if (index < 0) throw SLEEP_BLOCKED
      cursor = makeWutNode()
      return index
    }, true)

    if (replayError) throw replayError
    if (made.error === SLEEP_BLOCKED) {
      wasReduced = true
      return made.steps[prefixLanes.length - 1]!.access
    }
    orderings++
    if ('error' in made) {
      failure = { choices: made.choices, taken: made.taken, error: made.error }
      return undefined
    }

    const steps = made.steps
    const baseDepth = prefixLanes.length
    const observedParent = steps[baseDepth - 1]!.access

    // Push stack frames for every step from `baseDepth` onwards (including single-ready steps so depth indices align).
    for (let d = baseDepth; d < steps.length; d++) {
      const step = steps[d]!
      const sleep = sleepByDepth.get(d)!
      const wut = wutByDepth.get(d)!
      wut.children[0] = { laneId: step.laneId, access: step.access, node: makeWutNode() }
      stack.push({ sleep, wut, readyCount: step.readyLaneIds.length, exploredCount: 1 })
    }

    return finishBranch(steps, baseDepth, observedParent)
  }

  // Seed initial stack directly from Ordering 1 without re-running it.
  let rootCursor = makeWutNode()
  for (const step of first.steps) {
    const nextNode = makeWutNode()
    rootCursor.children.push({ laneId: step.laneId, access: step.access, node: nextNode })
    stack.push({ sleep: new Map(), wut: rootCursor, readyCount: step.readyLaneIds.length, exploredCount: 1 })
    rootCursor = nextNode
  }

  await finishBranch(first.steps, 0, undefined)
  if (failure) return { orderings, complete: false, ...(wasReduced ? { reduced: true as const } : {}), failure }
  return { orderings, complete: !hitLimit, ...(wasReduced ? { reduced: true as const } : {}) }
}

/**
 * Runs a scenario under every ordering its lanes allow, stopping at the first that fails. Untracked scenarios run
 * plain unreduced search by construction; when tasks opt into `{ tracked: true }` and `reduce` is not `false`,
 * Optimal DPOR explores one representative ordering per equivalence class.
 */
export async function explore(scenario: Scenario, options: ExploreOptions = {}): Promise<Explored> {
  const limit = options.limit ?? 50_000
  if (!(limit === Number.POSITIVE_INFINITY || (Number.isSafeInteger(limit) && limit >= 1))) {
    throw new RangeError(`explore expects limit to be a positive safe integer or Infinity, and was given ${String(limit)}`)
  }
  const first = await once(scenario, () => 0)
  if (options.reduce === false || !first.anyTracked) return exploreUnreduced(scenario, limit, first)
  if ('error' in first) return { orderings: 1, complete: false, failure: { choices: first.choices, taken: first.taken, error: first.error } }
  return exploreOptimal(scenario, limit, first)
}

/**
 * Runs a scenario under orderings chosen at random from a 32-bit unsigned integer `seed`, for one with too many to
 * run them all.
 */
export async function sample(scenario: Scenario, options: { seed: number; runs: number }): Promise<Explored> {
  const { seed, runs } = options
  assertUint32('sample', seed)
  assertPositiveInt('sample', 'runs', runs)
  const random = makePrng(seed)
  for (let orderings = 1; orderings <= runs; orderings++) {
    const made = await once(scenario, (_stepDepth, _choiceDepth, ready) => Math.floor(random() * ready.length))
    if ('error' in made) return { orderings, complete: false, failure: { choices: made.choices, taken: made.taken, error: made.error } }
  }
  return { orderings: runs, complete: false }
}

/**
 * Runs a scenario under one ordering: the choices a failure came back with. Returns what it threw, if it did.
 * Throws `RangeError` if any choice is invalid or out of range, or if the recording does not match the scenario
 * (ran out of choices or left unused trailing choices).
 */
export async function replay(scenario: Scenario, choices: readonly number[]): Promise<{ taken: readonly string[]; error?: unknown }> {
  for (let index = 0; index < choices.length; index++) {
    const choice = choices[index]!
    if (!Number.isSafeInteger(choice) || choice < 0) {
      throw new RangeError(`replay expects non-negative safe integer choices, and got ${String(choice)} at index ${index}`)
    }
  }
  let choiceError: RangeError | undefined
  const made = await once(scenario, (_stepDepth, depth, ready) => {
    if (depth >= choices.length) {
      choiceError = new RangeError(`replay ran out of choices at depth ${depth} (given ${choices.length})`)
      throw choiceError
    }
    const choice = choices[depth]!
    if (choice >= ready.length) {
      choiceError = new RangeError(`replay choice ${choice} at depth ${depth} is out of range for ${ready.length} ready lanes`)
      throw choiceError
    }
    return choice
  })
  if (choiceError) throw choiceError
  if (made.choices.length < choices.length) {
    throw new RangeError(
      `replay was given ${choices.length} choices, but the scenario only made ${made.choices.length}`,
      'error' in made ? { cause: made.error } : undefined,
    )
  }
  return 'error' in made ? { taken: made.taken, error: made.error } : { taken: made.taken }
}

const sameLaneSet = (a: readonly string[], b: readonly string[] | undefined): boolean =>
  b !== undefined && a.length === b.length && a.every((id) => b.includes(id))

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((item) => b.has(item))

const sameAccess = (a: StepAccess, b: StepAccess | undefined): boolean =>
  b !== undefined && sameSet(a.reads, b.reads) && sameSet(a.writes, b.writes)

/**
 * Audits that tasks marked `{ tracked: true }` truly commute whenever their recorded `read()`/`write()` accesses are
 * disjoint. Samples traces, swaps adjacent supposedly-independent steps, and checks that enabling, downstream ready
 * lane sets, recorded resource accesses, and pass/fail outcomes remain identical.
 */
export async function auditIndependence(scenario: Scenario, options: AuditOptions = {}): Promise<AuditResult> {
  const seed = options.seed ?? 1
  const runs = options.runs ?? 20
  const swaps = options.swaps ?? 50
  assertUint32('auditIndependence', seed)
  assertPositiveInt('auditIndependence', 'runs', runs)
  assertPositiveInt('auditIndependence', 'swaps', swaps)
  const random = makePrng(seed)

  let checked = 0
  for (let run = 1; run <= runs; run++) {
    const orig = await once(scenario, (_stepDepth, _choiceDepth, ready) => Math.floor(random() * ready.length))
    const steps = orig.steps
    for (let i = 0; i < steps.length - 1; i++) {
      const a = steps[i]!
      const b = steps[i + 1]!
      if (a.laneId === b.laneId || !a.readyLaneIds.includes(b.laneId) || conflicts(a.access, b.access)) continue
      checked++
      // Build exact lane plan with steps `i` and `i + 1` swapped.
      const plan = steps.map((s) => s.laneId)
      plan[i] = b.laneId
      plan[i + 1] = a.laneId
      let swapProblem: string | undefined
      const swapped = await once(scenario, (stepDepth, _choiceDepth, ready) => {
        const index = ready.findIndex((entry) => entry.laneId === plan[stepDepth])
        if (index < 0) {
          swapProblem = `ready lanes diverged at step ${stepDepth} after swapping "${a.what}" and "${b.what}"`
          throw new Error(swapProblem)
        }
        return index
      }, true)
      const prefixChoices = orig.choices.slice(0, steps.slice(0, i).filter((s) => s.readyLaneIds.length > 1).length)
      const fail = (reason: string): AuditResult => ({
        runs: run,
        checked,
        violation: { choices: orig.choices, prefix: prefixChoices, first: a.what, second: b.what, reason },
      })
      if (swapProblem) return fail(swapProblem)
      if (('error' in orig) !== ('error' in swapped)) {
        return fail(`scenario outcome differed after swapping "${a.what}" and "${b.what}"`)
      }
      for (let k = i + 2; k < steps.length; k++) {
        if (!sameLaneSet(steps[k]!.readyLaneIds, swapped.steps[k]?.readyLaneIds)) {
          return fail(`ready lanes diverged after swapping "${a.what}" and "${b.what}"`)
        }
      }
      if (!sameAccess(a.access, swapped.steps[i + 1]?.access) || !sameAccess(b.access, swapped.steps[i]!.access)) {
        return fail(`resource accesses diverged after swapping "${a.what}" and "${b.what}"`)
      }
      if (checked >= swaps) return { runs: run, checked }
    }
  }
  return { runs, checked }
}

/**
 * Runs a scenario under every ordering and throws for the first that fails, naming the order that led to it and the
 * choices to `replay` it with. Returns how many orderings there were. Past `limit` it throws too: a scenario too
 * wide to run whole is one to `sample`, said where it is written.
 */
export async function everyOrder(scenario: Scenario, options: ExploreOptions = {}): Promise<number> {
  const explored = await explore(scenario, options)
  if (explored.failure) {
    const { choices, taken, error } = explored.failure
    throw new Error(`Failed in ordering ${explored.orderings} (replay with [${choices.join(', ')}]):\n  ${taken.join('\n  ')}\n${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!explored.complete) throw new Error(`More than ${explored.orderings} orderings: too many to run them all`)
  return explored.orderings
}
