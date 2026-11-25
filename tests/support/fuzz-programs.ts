// Shared differential fuzz generator for Optimal DPOR vs unreduced exploration.
// Generates randomized concurrent programs covering register reads/writes/multi-writes, clock reads, dynamic lanes,
// shared dynamic lanes, timers scheduled inside steps (preemption), timer cancellation, clock.sleep + AbortSignal,
// work()/breaks() microtask attribution, tracked/untracked mixes, and tracked schedule.does().
import type { Explored, ExploreOptions, Scenario } from '../../src/index.ts'

type Op =
  | { kind: 'read'; reg: number }
  | { kind: 'write'; reg: number; val: number }
  | { kind: 'write2'; reg1: number; reg2: number; val: number }
  | { kind: 'inc'; reg: number }
  | { kind: 'readClock' }
  | { kind: 'spawn'; reg: number; val: number }
  | { kind: 'sharedPush'; reg: number; val: number }
  | { kind: 'after'; delay: number; reg: number; val: number }
  | { kind: 'work'; reg: number; val: number }
  | { kind: 'breaks'; reg: number; val: number }
  | { kind: 'cancelTimer' }
  | { kind: 'abortSleep' }

export interface FuzzSummary {
  readonly programs: number
  readonly totalUnreduced: number
  readonly totalReduced: number
}

export async function runDifferentialFuzz(
  exploreFn: (scenario: Scenario, options?: ExploreOptions) => Promise<Explored>,
  options: { readonly seed: number; readonly programs: number; readonly maxFull?: number },
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

  let totalUnreduced = 0
  let totalReduced = 0
  let completed = 0

  for (let attempt = 0; completed < options.programs; attempt++) {
    const numLanes = 2 + int(2)
    const numRegs = 2 + int(2)
    const hasSetupTimer = int(2) === 0
    const setupTimerDelay = int(3) * 10
    const setupTimerReg = int(numRegs)
    const hasSetupSleep = int(3) === 0
    const setupSleepDelay = (1 + int(2)) * 10
    const useDoesForLast = int(3) === 0

    const laneOps: Op[][] = []
    const laneTracked: boolean[] = []
    let usedCancel = false
    let usedAbort = false

    for (let l = 0; l < numLanes; l++) {
      const steps = 1 + int(2)
      const ops: Op[] = []
      for (let s = 0; s < steps; s++) {
        const r = int(20)
        if (r < 3) ops.push({ kind: 'read', reg: int(numRegs) })
        else if (r < 6) ops.push({ kind: 'write', reg: int(numRegs), val: 1 + int(5) })
        else if (r < 8) ops.push({ kind: 'write2', reg1: int(numRegs), reg2: int(numRegs), val: 1 + int(5) })
        else if (r < 10) ops.push({ kind: 'inc', reg: int(numRegs) })
        else if (r === 10) ops.push({ kind: 'readClock' })
        else if (r === 11) ops.push({ kind: 'spawn', reg: int(numRegs), val: 10 + int(5) })
        else if (r === 12) ops.push({ kind: 'sharedPush', reg: int(numRegs), val: 20 + int(5) })
        else if (r === 13) ops.push({ kind: 'after', delay: int(3) * 10, reg: int(numRegs), val: 30 + int(5) })
        else if (r === 14) ops.push({ kind: 'work', reg: int(numRegs), val: 40 + int(5) })
        else if (r === 15) ops.push({ kind: 'breaks', reg: int(numRegs), val: 50 + int(5) })
        else if (r < 18 && hasSetupTimer && !usedCancel) { usedCancel = true; ops.push({ kind: 'cancelTimer' }) }
        else if (hasSetupSleep && !usedAbort) { usedAbort = true; ops.push({ kind: 'abortSleep' }) }
        else ops.push({ kind: 'write', reg: int(numRegs), val: 1 + int(5) })
      }
      laneOps.push(ops)
      laneTracked.push(int(5) > 0)
    }

    const makeScenario = (states: Set<string>): Scenario => (schedule) => {
      const regTokens = Array.from({ length: numRegs }, (_, i) => schedule.resource(`r${i}`))
      const regs = Array<number>(numRegs).fill(0)
      const reads: string[] = []
      const sharedLog: number[] = []
      const sharedLogTok = schedule.resource('sharedLog')
      const sharedLane = { label: 'shared-dyn' }
      let timerFired = 0
      let sleepOutcome = 'none'
      let cancelSetupTimer: (() => void) | undefined
      const sleepAc = new AbortController()

      if (hasSetupTimer) {
        cancelSetupTimer = schedule.clock.after(setupTimerDelay, () => {
          schedule.write(regTokens[setupTimerReg]!)
          regs[setupTimerReg] = 99
          timerFired = 1
        }, { tracked: true })
      }
      if (hasSetupSleep) {
        void schedule.clock.sleep(setupSleepDelay, { signal: sleepAc.signal, tracked: true }).then(
          () => { sleepOutcome = 'ok' },
          () => { sleepOutcome = 'aborted' },
        )
      }

      const runOp = (op: Op, tracked: boolean, site: string): void => {
        switch (op.kind) {
          case 'read':
            schedule.read(regTokens[op.reg]!)
            reads.push(`${site}:${regs[op.reg]!}`)
            return
          case 'write':
            schedule.write(regTokens[op.reg]!)
            regs[op.reg] = op.val
            return
          case 'write2':
            schedule.write(regTokens[op.reg1]!)
            schedule.write(regTokens[op.reg2]!)
            regs[op.reg1] = op.val
            regs[op.reg2] = op.val + 10
            return
          case 'inc':
            schedule.read(regTokens[op.reg]!)
            schedule.write(regTokens[op.reg]!)
            regs[op.reg] = regs[op.reg]! + 1
            return
          case 'readClock':
            reads.push(`${site}:${schedule.clock.monotonic()}`)
            return
          case 'spawn':
            schedule.later({ label: `spawn-${op.reg}-${op.val}` }, () => {
              schedule.write(regTokens[op.reg]!)
              regs[op.reg] = op.val
            }, { tracked })
            return
          case 'sharedPush':
            schedule.later(sharedLane, () => {
              schedule.write(sharedLogTok)
              schedule.write(regTokens[op.reg]!)
              sharedLog.push(op.val)
              regs[op.reg] = op.val
            }, { tracked })
            return
          case 'after':
            schedule.clock.after(op.delay, () => {
              schedule.write(regTokens[op.reg]!)
              regs[op.reg] = op.val
              reads.push(`${site}:${schedule.clock.now()}`)
            }, { tracked })
            return
          case 'work':
            void schedule.work(`w-${op.reg}`, op.val, { tracked }).then((v) => {
              schedule.write(regTokens[op.reg]!)
              regs[op.reg] = v
            })
            return
          case 'breaks':
            void schedule.breaks(`b-${op.reg}`, new Error('fail'), { tracked }).catch(() => {
              schedule.write(regTokens[op.reg]!)
              regs[op.reg] = op.val
            })
            return
          case 'cancelTimer':
            cancelSetupTimer?.()
            return
          case 'abortSleep':
            sleepAc.abort(new Error('cancel-sleep'))
            return
        }
      }

      for (let l = 0; l < numLanes; l++) {
        const tracked = laneTracked[l]!
        const ops = laneOps[l]!
        if (useDoesForLast && l === numLanes - 1) {
          schedule.does(
            tracked ? { label: `does-${l}`, tracked: true } : `does-${l}`,
            ...ops.map((op, idx) => [`op-${idx}`, () => runOp(op, tracked, `${l}.${idx}`)] as const),
          )
        } else {
          const lane = { label: `lane-${l}` }
          for (let idx = 0; idx < ops.length; idx++) {
            const op = ops[idx]!
            schedule.later(lane, () => runOp(op, tracked, `${l}.${idx}`), { tracked })
          }
        }
      }

      return () => {
        const state = `${regs.join(',')}|${[...reads].sort().join(',')}|${sharedLog.join(',')}|${timerFired}|${sleepOutcome}`
        states.add(state)
      }
    }

    const fullStates = new Set<string>()
    const full = await exploreFn(makeScenario(fullStates), { reduce: false, limit: maxFull })
    if (!full.complete) continue

    const dporStates = new Set<string>()
    const dpor = await exploreFn(makeScenario(dporStates), { reduce: true, limit: maxFull })
    if (!dpor.complete) {
      throw new Error(`Fuzz program #${completed} (seed=${options.seed}, attempt=${attempt}) did not complete under DPOR (full=${full.orderings})`)
    }
    if (dpor.orderings > full.orderings) {
      throw new Error(`Fuzz program #${completed} (seed=${options.seed}, attempt=${attempt}) ran MORE orderings under DPOR (${dpor.orderings}) than unreduced (${full.orderings})`)
    }
    const fullSorted = [...fullStates].sort()
    const dporSorted = [...dporStates].sort()
    if (fullSorted.length !== dporSorted.length || fullSorted.some((s, i) => s !== dporSorted[i])) {
      throw new Error(
        `Fuzz program #${completed} (seed=${options.seed}, attempt=${attempt}) state mismatch!\n`
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
