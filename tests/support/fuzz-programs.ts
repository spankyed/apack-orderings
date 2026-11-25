// Shared differential fuzz generator for wakeup-tree DPOR vs unreduced exploration.
// Generates nested (up to depth 2) randomized concurrent programs covering register reads/writes/multi-writes,
// clock.now()/monotonic(), nested clock.after() + multi-slot cancellation, nested clock.sleep() + multi-controller
// AbortSignal aborts, dynamic lanes, shared lanes, work()/breaks() microtask attribution, tracked/untracked mixes,
// and schedule.does(). Every piece of shared mutable state is reported via schedule.resource().
import type { Explored, ExploreOptions, Scenario } from '../../src/index.ts'

type Op =
  | { readonly k: 'read'; readonly id: number; readonly r: number }
  | { readonly k: 'write'; readonly r: number; readonly v: number }
  | { readonly k: 'write2'; readonly r1: number; readonly r2: number; readonly v: number }
  | { readonly k: 'inc'; readonly r: number }
  | { readonly k: 'now'; readonly id: number }
  | { readonly k: 'monotonic'; readonly id: number }
  | { readonly k: 'after'; readonly ms: number; readonly slot: number; readonly tracked: boolean; readonly body: readonly Op[] }
  | { readonly k: 'cancel'; readonly slot: number }
  | { readonly k: 'sleep'; readonly id: number; readonly ms: number; readonly ac: number; readonly tracked: boolean; readonly ok: readonly Op[]; readonly bad: readonly Op[] }
  | { readonly k: 'abort'; readonly ac: number }
  | { readonly k: 'spawn'; readonly label: string; readonly tracked: boolean; readonly body: readonly Op[] }
  | { readonly k: 'shared'; readonly lane: number; readonly tracked: boolean; readonly body: readonly Op[] }
  | { readonly k: 'work'; readonly tracked: boolean; readonly body: readonly Op[] }
  | { readonly k: 'breaks'; readonly tracked: boolean; readonly body: readonly Op[] }
  | { readonly k: 'does'; readonly label: string; readonly tracked: boolean; readonly steps: ReadonlyArray<readonly Op[]> }

export type FuzzProfile = 'mixed' | 'all' | 'timers'

export interface FuzzSummary {
  readonly programs: number
  readonly totalUnreduced: number
  readonly totalReduced: number
}

interface Program {
  readonly regs: number
  readonly slots: number
  readonly acs: number
  readonly shared: number
  readonly setup: readonly Op[]
  readonly lanes: ReadonlyArray<{ readonly tracked: boolean; readonly steps: ReadonlyArray<readonly Op[]> }>
}

export async function runDifferentialFuzz(
  exploreFn: (scenario: Scenario, options?: ExploreOptions) => Promise<Explored>,
  options: { readonly seed: number; readonly programs: number; readonly maxFull?: number; readonly profile?: FuzzProfile },
): Promise<FuzzSummary> {
  let prng = options.seed >>> 0
  const next = (): number => {
    prng = (prng + 0x6d2b79f5) >>> 0
    let t = prng
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number): number => Math.floor(next() * n)
  const maxFull = options.maxFull ?? 2_500
  const profile: FuzzProfile = options.profile ?? 'mixed'
  const trackedBias = profile === 'all' ? 1 : 0.85

  const generateProgram = (): Program => {
    let ids = 0
    let labels = 0
    const regs = 1 + int(3)
    const slots = 1 + int(2)
    const acs = 1 + int(2)
    const shared = 1 + int(2)
    const tr = (): boolean => next() < trackedBias

    const makeOps = (depth: number, max: number): Op[] => Array.from({ length: 1 + int(max) }, () => makeOp(depth))
    const makeOp = (depth: number): Op => {
      const leaf = depth >= 2
      if (profile === 'timers') {
        const r = int(15)
        if (r < 2) return { k: 'write', r: int(regs), v: 1 + int(4) }
        if (r === 2) return { k: 'now', id: ids++ }
        if (r === 3) return { k: 'monotonic', id: ids++ }
        if (r < 7 && !leaf) return { k: 'after', ms: int(3) * 10, slot: int(slots), tracked: tr(), body: makeOps(depth + 1, 1) }
        if (r < 9) return { k: 'cancel', slot: int(slots) }
        if (r < 11 && !leaf) return { k: 'sleep', id: ids++, ms: int(3) * 10, ac: int(acs + 1) - 1, tracked: tr(), ok: makeOps(depth + 1, 1), bad: makeOps(depth + 1, 1) }
        if (r < 13) return { k: 'abort', ac: int(acs) }
        return { k: 'read', id: ids++, r: int(regs) }
      }
      const r = int(24)
      if (r < 3) return { k: 'read', id: ids++, r: int(regs) }
      if (r < 6) return { k: 'write', r: int(regs), v: 1 + int(4) }
      if (r === 6) return { k: 'write2', r1: int(regs), r2: int(regs), v: 1 + int(4) }
      if (r < 9) return { k: 'inc', r: int(regs) }
      if (r === 9) return { k: 'now', id: ids++ }
      if (r === 10) return { k: 'monotonic', id: ids++ }
      if (r < 13) return { k: 'cancel', slot: int(slots) }
      if (r === 13) return { k: 'abort', ac: int(acs) }
      if (leaf) return { k: 'write', r: int(regs), v: 1 + int(4) }
      if (r < 16) return { k: 'after', ms: int(3) * 10, slot: int(slots), tracked: tr(), body: makeOps(depth + 1, 2) }
      if (r < 18) return { k: 'sleep', id: ids++, ms: int(3) * 10, ac: int(acs + 1) - 1, tracked: tr(), ok: makeOps(depth + 1, 1), bad: makeOps(depth + 1, 1) }
      if (r === 18) return { k: 'spawn', label: `sp${labels++}`, tracked: tr(), body: makeOps(depth + 1, 2) }
      if (r < 21) return { k: 'shared', lane: int(shared), tracked: tr(), body: makeOps(depth + 1, 2) }
      if (r === 21) return { k: 'work', tracked: tr(), body: makeOps(depth + 1, 1) }
      if (r === 22) return { k: 'breaks', tracked: tr(), body: makeOps(depth + 1, 1) }
      return { k: 'does', label: `d${labels++}`, tracked: tr(), steps: [makeOps(depth + 1, 1), makeOps(depth + 1, 1)] }
    }

    const setup = int(2) === 0
      ? makeOps(1, 2).filter((op) => op.k === 'after' || op.k === 'sleep' || op.k === 'shared')
      : []
    const numLanes = 2 + int(2)
    const lanes = Array.from({ length: numLanes }, () => ({
      tracked: tr(),
      steps: Array.from({ length: 1 + int(2) }, () => makeOps(0, 2)),
    }))
    return { regs, slots, acs, shared, setup, lanes }
  }

  const makeScenario = (program: Program, states: Set<string>): Scenario => (schedule) => {
    const regTok = Array.from({ length: program.regs }, (_, i) => schedule.resource(`r${i}`))
    const regs = Array<number>(program.regs).fill(0)
    const slotTok = Array.from({ length: program.slots }, (_, i) => schedule.resource(`slot${i}`))
    const slots: Array<(() => void) | undefined> = Array(program.slots).fill(undefined)
    const acTok = Array.from({ length: program.acs }, (_, i) => schedule.resource(`ac${i}`))
    const acs = Array.from({ length: program.acs }, () => new AbortController())
    const sharedLanes = Array.from({ length: program.shared }, (_, i) => ({ label: `shared${i}` }))
    const obs = new Map<string, string>()

    const runAll = (body: readonly Op[]): void => { for (const op of body) runOp(op) }
    const runOp = (op: Op): void => {
      switch (op.k) {
        case 'read':
          schedule.read(regTok[op.r]!)
          obs.set(`r${op.id}`, String(regs[op.r]))
          return
        case 'write':
          schedule.write(regTok[op.r]!)
          regs[op.r] = op.v
          return
        case 'write2':
          schedule.write(regTok[op.r1]!)
          schedule.write(regTok[op.r2]!)
          regs[op.r1] = op.v
          regs[op.r2] = op.v + 10
          return
        case 'inc':
          schedule.read(regTok[op.r]!)
          schedule.write(regTok[op.r]!)
          regs[op.r] = regs[op.r]! + 1
          return
        case 'now':
          obs.set(`now${op.id}`, String(schedule.clock.now()))
          return
        case 'monotonic':
          obs.set(`mono${op.id}`, String(schedule.clock.monotonic()))
          return
        case 'after': {
          const cancel = schedule.clock.after(op.ms, () => runAll(op.body), { tracked: op.tracked })
          schedule.write(slotTok[op.slot]!)
          slots[op.slot] = cancel
          return
        }
        case 'cancel':
          schedule.read(slotTok[op.slot]!)
          slots[op.slot]?.()
          return
        case 'sleep': {
          const signal = op.ac < 0 ? undefined : acs[op.ac]!.signal
          if (op.ac >= 0) schedule.read(acTok[op.ac]!)
          void schedule.clock.sleep(op.ms, { ...(signal ? { signal } : {}), tracked: op.tracked }).then(
            () => { obs.set(`sl${op.id}`, 'ok'); runAll(op.ok) },
            () => { obs.set(`sl${op.id}`, 'aborted'); runAll(op.bad) },
          )
          return
        }
        case 'abort':
          schedule.write(acTok[op.ac]!)
          acs[op.ac]!.abort(new Error('abort'))
          return
        case 'spawn':
          schedule.later({ label: op.label }, () => runAll(op.body), { tracked: op.tracked })
          return
        case 'shared':
          schedule.later(sharedLanes[op.lane]!, () => runAll(op.body), { tracked: op.tracked })
          return
        case 'work':
          void schedule.work('w', 1, { tracked: op.tracked }).then(() => runAll(op.body))
          return
        case 'breaks':
          void schedule.breaks('b', new Error('fail'), { tracked: op.tracked }).catch(() => runAll(op.body))
          return
        case 'does':
          schedule.does(
            op.tracked ? { label: op.label, tracked: true } : op.label,
            ...op.steps.map((step, i) => [`s${i}`, () => runAll(step)] as const),
          )
          return
      }
    }

    runAll(program.setup)
    program.lanes.forEach((lane, l) => {
      const laneObj = { label: `lane${l}` }
      for (const step of lane.steps) {
        schedule.later(laneObj, () => runAll(step), { tracked: lane.tracked })
      }
    })

    return () => {
      const observed = [...obs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(',')
      states.add(`${regs.join(',')}|${observed}`)
    }
  }

  let totalUnreduced = 0
  let totalReduced = 0
  let completed = 0

  for (let attempt = 0; completed < options.programs; attempt++) {
    const program = generateProgram()

    const fullStates = new Set<string>()
    const full = await exploreFn(makeScenario(program, fullStates), { reduce: false, limit: maxFull })
    if (!full.complete) continue

    const dporStates = new Set<string>()
    const dpor = await exploreFn(makeScenario(program, dporStates), { reduce: true, limit: maxFull })
    if (dpor.failure || !dpor.complete) {
      throw new Error(
        `Fuzz program #${completed} (profile=${profile}, seed=${options.seed}, attempt=${attempt}) failed/incomplete under DPOR (full=${full.orderings}, failure=${String(dpor.failure?.error)})`,
      )
    }
    if (dpor.orderings > full.orderings) {
      throw new Error(
        `Fuzz program #${completed} (profile=${profile}, seed=${options.seed}, attempt=${attempt}) ran MORE orderings under DPOR (${dpor.orderings}) than unreduced (${full.orderings})`,
      )
    }
    const fullSorted = [...fullStates].sort()
    const dporSorted = [...dporStates].sort()
    if (fullSorted.length !== dporSorted.length || fullSorted.some((s, i) => s !== dporSorted[i])) {
      throw new Error(
        `Fuzz program #${completed} (profile=${profile}, seed=${options.seed}, attempt=${attempt}) state mismatch!\n`
        + `full (${full.orderings} orderings): ${JSON.stringify(fullSorted)}\n`
        + `dpor (${dpor.orderings} orderings): ${JSON.stringify(dporSorted)}`,
      )
    }

    totalUnreduced += full.orderings
    totalReduced += dpor.orderings
    completed++
  }

  return { programs: completed, totalUnreduced, totalReduced }
}
