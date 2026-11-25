import { describe, expect, it } from 'vitest'
import { auditIndependence, everyOrder, explore, replay, sample, type Resource, type Scenario } from '../src/index.ts'
import { conflicts, findWakeups, insertWut, makeAccess, makeWutNode, type StepRef, type TraceStep } from '../src/dpor.ts'
import { runDifferentialFuzz } from './support/fuzz-programs.ts'

describe('Optimal DPOR and resource tracking', () => {
  it('collapses independent tracked lanes to one equivalence class while reduce: false runs every interleaving', async () => {
    const makeScenario = (): Scenario => (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      const c = schedule.resource('c')
      expect(Object.isFrozen(a)).toBe(true)
      expect(a.label).toBe('a')
      const laneA = { label: 'a' }
      const laneB = { label: 'b' }
      const laneC = { label: 'c' }
      let va = 0
      let vb = 0
      let vc = 0
      schedule.later(laneA, () => { schedule.write(a); va = 1 }, { tracked: true })
      schedule.later(laneA, () => { schedule.write(a); va = 2 }, { tracked: true })
      schedule.later(laneB, () => { schedule.write(b); vb = 1 }, { tracked: true })
      schedule.later(laneB, () => { schedule.write(b); vb = 2 }, { tracked: true })
      schedule.later(laneC, () => { schedule.write(c); vc = 1 }, { tracked: true })
      schedule.later(laneC, () => { schedule.write(c); vc = 2 }, { tracked: true })
      return () => {
        expect([va, vb, vc]).toEqual([2, 2, 2])
      }
    }

    const unreduced = await explore(makeScenario(), { reduce: false })
    expect(unreduced).toEqual({ orderings: 90, complete: true })

    const reduced = await explore(makeScenario())
    expect(reduced).toEqual({ orderings: 1, complete: true, reduced: true })
  })

  it('commutes concurrent reads while exploring every read/write race exactly once', async () => {
    const observed = new Set<string>()
    const scenario: Scenario = (schedule) => {
      const reg = schedule.resource()
      expect('label' in reg).toBe(false)
      const r1 = { label: 'r1' }
      const r2 = { label: 'r2' }
      const w = { label: 'w' }
      let value = 0
      let seen1 = -1
      let seen2 = -1
      schedule.later(r1, () => { schedule.read(reg); seen1 = value }, { tracked: true })
      schedule.later(r2, () => { schedule.read(reg); seen2 = value }, { tracked: true })
      schedule.later(w, () => { schedule.write(reg); value = 1 }, { tracked: true })
      return () => { observed.add(`${seen1},${seen2}`) }
    }

    const unreduced = await explore(scenario, { reduce: false })
    expect(unreduced).toEqual({ orderings: 6, complete: true })

    observed.clear()
    const reduced = await explore(scenario)
    // Exact 4 Mazurkiewicz equivalence classes: (0,0), (0,1), (1,0), (1,1).
    expect(reduced).toEqual({ orderings: 4, complete: true, reduced: true })
    expect([...observed].sort()).toEqual(['0,0', '0,1', '1,0', '1,1'])

    // Pure concurrent reads collapse to 1 ordering.
    const readersOnly = await explore((schedule) => {
      const reg = schedule.resource('reg')
      schedule.later({ label: 'a' }, () => { schedule.read(reg) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.read(reg) }, { tracked: true })
      schedule.later({ label: 'c' }, () => { schedule.read(reg) }, { tracked: true })
      return () => {}
    })
    expect(readersOnly).toEqual({ orderings: 1, complete: true, reduced: true })
  })

  it('rejects a foreign or stale Resource passed to read() or write()', async () => {
    let leaked!: Resource
    await explore((schedule) => {
      leaked = schedule.resource('leaked')
      return () => {}
    })
    const badRead = await explore((schedule) => {
      schedule.later({ label: 'a' }, () => { schedule.read(leaked) }, { tracked: true })
      return () => {}
    })
    expect(String(badRead.failure?.error)).toMatch(/does not belong to this schedule run/)

    const badWrite = await explore((schedule) => {
      schedule.later({ label: 'a' }, () => { schedule.write(leaked) }, { tracked: true })
      return () => {}
    })
    expect(String(badWrite.failure?.error)).toMatch(/does not belong to this schedule run/)
  })

  it('keeps untracked tasks globally conflicting by default, including when mixed with tracked tasks', async () => {
    const seen = new Set<string>()
    const explored = await explore((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      const order: string[] = []
      schedule.later({ label: 'tracked-a' }, () => { schedule.write(a); order.push('a') }, { tracked: true })
      schedule.later({ label: 'tracked-b' }, () => { schedule.write(b); order.push('b') }, { tracked: true })
      // Untracked task conflicts with both tracked-a and tracked-b.
      schedule.does('user', ['click', () => { order.push('u') }])
      return () => { seen.add(order.join('')) }
    })
    // `a` and `b` commute on the same side of `u`, so 4 equivalence classes instead of 6:
    // {ab}u, u{ab}, aub, bua.
    expect(explored).toEqual({ orderings: 4, complete: true, reduced: true })
    expect(seen.has('aub')).toBe(true)
    expect(seen.has('bua')).toBe(true)
    expect(seen.has('abu') || seen.has('bau')).toBe(true)
    expect(seen.has('uab') || seen.has('uba')).toBe(true)
  })

  it('preserves push-order races when independent tracked tasks push to the same shared lane', async () => {
    const seen = new Set<string>()
    const explored = await explore((schedule) => {
      const shared = { label: 'shared' }
      const order: string[] = []
      schedule.later({ label: 'a' }, () => {
        schedule.later(shared, () => { order.push('fromA') }, { tracked: true })
      }, { tracked: true })
      schedule.later({ label: 'b' }, () => {
        schedule.later(shared, () => { order.push('fromB') }, { tracked: true })
      }, { tracked: true })
      return () => { seen.add(order.join(',')) }
    })
    expect(explored.complete).toBe(true)
    expect([...seen].sort()).toEqual(['fromA,fromB', 'fromB,fromA'])
  })

  it('attributes read/write calls in microtasks of tracked work() and breaks() to the resolving step', async () => {
    const seen = new Set<string>()
    const explored = await explore((schedule) => {
      const reg = schedule.resource('reg')
      let value = 0
      let seenWork = -1
      let seenBreak = -1
      void schedule.work('w', 1, { tracked: true }).then((v) => {
        schedule.write(reg)
        value = v
        seenWork = value
      })
      void schedule.breaks('b', new Error('fail'), { tracked: true }).catch(() => {
        schedule.read(reg)
        seenBreak = value
      })
      return () => { seen.add(`${seenWork},${seenBreak}`) }
    })
    expect(explored).toEqual({ orderings: 2, complete: true })
    expect([...seen].sort()).toEqual(['1,0', '1,1'])
  })

  it('handles transitive causal chains and dynamically allocated resources inside steps', async () => {
    const seen = new Set<string>()
    const scenario: Scenario = (schedule) => {
      const x = schedule.resource('x')
      const y = schedule.resource('y')
      const z = schedule.resource('z')
      let yVal = 0
      schedule.later({ label: 'a' }, () => {
        schedule.read(x)
        const dyn = schedule.resource('dyn')
        schedule.later({ label: 'b' }, () => { schedule.write(dyn); schedule.write(y); yVal = 1 }, { tracked: true })
      }, { tracked: true })
      schedule.later({ label: 'c' }, () => { schedule.read(z); schedule.write(y); yVal = 2 }, { tracked: true })
      return () => { seen.add(String(yVal)) }
    }
    const unreduced = await explore(scenario, { reduce: false })
    expect(unreduced).toEqual({ orderings: 3, complete: true })

    seen.clear()
    const reduced = await explore(scenario)
    expect(reduced).toEqual({ orderings: 2, complete: true, reduced: true })
    expect([...seen].sort()).toEqual(['1', '2'])
  })

  it('keeps timer scheduling, cancellation, and firing globally conflicting while reducing independent non-timer lanes', async () => {
    // 1. Timer operations conflict globally with tracked lanes (both clock readers and non-readers), while
    //    independent non-timer lanes still commute around them.
    const timerAndTwoLanes = await explore((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      schedule.clock.after(10, () => {}, { tracked: true })
      schedule.later({ label: 'a' }, () => { schedule.write(a) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b) }, { tracked: true })
      return () => {}
    })
    // Full search has 6 orderings; `a` and `b` commute on the same side of the timer -> 4 equivalence classes.
    expect(timerAndTwoLanes).toEqual({ orderings: 4, complete: true, reduced: true })

    const timesSeen = new Set<number>()
    const withClockRead = await explore((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      schedule.clock.after(10, () => { schedule.write(a) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b); timesSeen.add(schedule.clock.now()) }, { tracked: true })
      return () => {}
    })
    expect(withClockRead).toEqual({ orderings: 2, complete: true })
    expect([...timesSeen].sort((x, y) => x - y)).toEqual([0, 10])

    // 2. Two tracked lanes that only read clock.now()/monotonic() (no timer firing between them) commute.
    const twoClockReaders = await explore((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      schedule.later({ label: 'a' }, () => { schedule.write(a); void schedule.clock.now() }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b); void schedule.clock.monotonic() }, { tracked: true })
      return () => {}
    })
    expect(twoClockReaders).toEqual({ orderings: 1, complete: true, reduced: true })

    // 3. Concurrent timer scheduling explores all clock-advance interleavings (including b -> t50 -> a -> t60) and FIFO ties.
    const diffDueTimes = new Set<string>()
    const diffDue = await explore((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      let ta = -1
      let tb = -1
      schedule.later({ label: 'a' }, () => { schedule.clock.after(10, () => { schedule.write(a); ta = schedule.clock.now() }, { tracked: true }) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.clock.after(50, () => { schedule.write(b); tb = schedule.clock.now() }, { tracked: true }) }, { tracked: true })
      return () => { diffDueTimes.add(`${ta},${tb}`) }
    })
    expect(diffDue.complete).toBe(true)
    expect([...diffDueTimes].sort()).toEqual(['10,50', '10,60', '60,50'])

    const tieOrders = new Set<string>()
    const sameDue = await explore((schedule) => {
      const log: string[] = []
      const logTok = schedule.resource('log')
      schedule.later({ label: 'a' }, () => { schedule.clock.after(10, () => { schedule.write(logTok); log.push('a') }, { tracked: true }) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.clock.after(10, () => { schedule.write(logTok); log.push('b') }, { tracked: true }) }, { tracked: true })
      return () => { tieOrders.add(log.join(',')) }
    })
    expect(sameDue.complete).toBe(true)
    expect([...tieOrders].sort()).toEqual(['a,b', 'b,a'])

    // 4. Cancelling a pending timer (including one behind an earlier timer) explores both fire and cancel orders.
    const cancelOutcomes = new Set<string>()
    const cancelled = await explore((schedule) => {
      const ac = new AbortController()
      let t1 = false
      let t2 = false
      let aborted = false
      schedule.clock.after(10, () => { t1 = true }, { tracked: true })
      void schedule.clock.sleep(20, { signal: ac.signal, tracked: true }).then(() => { t2 = true }, () => { aborted = true })
      schedule.later({ label: 'canceller' }, () => { ac.abort(new Error('stop')) }, { tracked: true })
      return () => { cancelOutcomes.add(`${t1},${t2},${aborted}`) }
    })
    expect(cancelled.complete).toBe(true)
    expect([...cancelOutcomes].sort()).toEqual(['true,false,true', 'true,true,false'])

    // 5. Creating and immediately cancelling a timer inside the same step does not create a spurious `['clock']` wakeup.
    const selfCancel = await explore((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      schedule.later({ label: 'a' }, () => {
        schedule.write(a)
        const cancel = schedule.clock.after(10, () => {}, { tracked: true })
        cancel()
      }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b) }, { tracked: true })
      return () => {}
    })
    expect(selfCancel).toEqual({ orderings: 2, complete: true })

    // 6. Nested timer regressions (independent fuzzer Scenarios A, B, and C): exact reachable-state match with zero throws.
    const checkMatchesFull = async (make: (states: Set<string>) => Scenario): Promise<{ full: number; dpor: number }> => {
      const fullStates = new Set<string>()
      const dporStates = new Set<string>()
      const full = await explore(make(fullStates), { reduce: false })
      const dpor = await explore(make(dporStates), { reduce: true })
      expect(full.complete).toBe(true)
      expect(dpor.complete).toBe(true)
      expect([...dporStates].sort()).toEqual([...fullStates].sort())
      return { full: full.orderings, dpor: dpor.orderings }
    }

    // Scenario A: abortable sleep(20) + after(10) + clock.now() across two tracked lanes.
    const resA = await checkMatchesFull((states) => (schedule) => {
      const ac = new AbortController()
      const acTok = schedule.resource('ac')
      const reg = schedule.resource('reg')
      let value = 0
      let seenNow = -1
      let seenValue = -1
      let slept = 'pending'
      const laneA = { label: 'A' }
      const laneB = { label: 'B' }
      schedule.later(laneA, () => { seenNow = schedule.clock.now() }, { tracked: true })
      schedule.later(laneA, () => { schedule.write(acTok); ac.abort(new Error('stop')) }, { tracked: true })
      schedule.later(laneB, () => {
        schedule.read(acTok)
        void schedule.clock.sleep(20, { signal: ac.signal, tracked: true }).then(
          () => { slept = 'ok'; schedule.write(reg); value = 1 },
          () => { slept = 'aborted' },
        )
        schedule.clock.after(10, () => {}, { tracked: true })
      }, { tracked: true })
      schedule.later(laneB, () => { schedule.read(reg); seenValue = value }, { tracked: true })
      return () => { states.add(`now=${seenNow} read=${seenValue} sleep=${slept}`) }
    })
    expect(resA.dpor).toBeLessThan(resA.full)

    // Scenario B: nested timer spawned inside sleep(0) callback + concurrent after(0) + clock.now() (no aborts/cancels).
    await checkMatchesFull((states) => (schedule) => {
      let first = -1
      let second = -1
      const laneA = { label: 'A' }
      const laneB = { label: 'B' }
      schedule.later(laneA, () => { schedule.clock.after(0, () => { first = schedule.clock.now() }, { tracked: true }) }, { tracked: true })
      schedule.later(laneB, () => {
        void schedule.clock.sleep(0, { tracked: true }).then(() => { schedule.clock.after(10, () => {}, { tracked: true }) })
      }, { tracked: true })
      schedule.later(laneB, () => { second = schedule.clock.now() }, { tracked: true })
      return () => { states.add(`timerSaw=${first} laneBSaw=${second}`) }
    })

    // Scenario C: two timers where one spawns breaks() and another is cancelled (must not throw `clock.0:0` replay error).
    const resC = await checkMatchesFull((states) => (schedule) => {
      const slot = schedule.resource('slot')
      const reg = schedule.resource('reg')
      let cancel: (() => void) | undefined
      let value = 0
      let seen = -1
      const laneA = { label: 'A' }
      const laneB = { label: 'B' }
      schedule.later(laneA, () => {
        const stop = schedule.clock.after(10, () => {
          void schedule.breaks('b', new Error('x'), { tracked: true }).catch(() => { schedule.write(reg); value = 2 })
        }, { tracked: true })
        schedule.write(slot)
        cancel = stop
      }, { tracked: true })
      schedule.later(laneB, () => {
        const stop = schedule.clock.after(0, () => { schedule.read(reg); seen = value }, { tracked: true })
        schedule.write(slot)
        cancel = stop
      }, { tracked: true })
      schedule.later(laneB, () => {
        schedule.does({ label: 'd', tracked: true }, ['nothing', () => {}], ['cancel', () => { schedule.read(slot); cancel?.() }])
      }, { tracked: true })
      return () => { states.add(`value=${value} seen=${seen}`) }
    })
    expect(resC.dpor).toBeLessThan(resC.full)
  })

  it('works cleanly with outside() under Optimal DPOR', async () => {
    const seen = new Set<string>()
    const explored = await explore((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      const done = schedule.outside()
      let val = ''
      setTimeout(() => {
        schedule.later({ label: 'from-outside' }, () => { schedule.write(a); val += 'o' }, { tracked: true })
        done()
      }, 5)
      schedule.later({ label: 'local' }, () => { schedule.write(b); val += 'l' }, { tracked: true })
      return () => { seen.add(val) }
    })
    expect(explored).toEqual({ orderings: 1, complete: true })
    expect([...seen]).toEqual(['lo'])
  })

  it('reproduces failures found under Optimal DPOR with replay() and respects limit', async () => {
    const scenario: Scenario = (schedule) => {
      const reg = schedule.resource('reg')
      const ind = schedule.resource('ind')
      let count = 0
      let r1 = 0
      let r2 = 0
      const a = { label: 'a' }
      const b = { label: 'b' }
      schedule.later(a, () => { schedule.read(reg); r1 = count }, { tracked: true })
      schedule.later(a, () => { schedule.write(reg); count = r1 + 1 }, { tracked: true })
      schedule.later(b, () => { schedule.read(reg); r2 = count }, { tracked: true })
      schedule.later(b, () => { schedule.write(reg); count = r2 + 1 }, { tracked: true })
      // Unrelated independent lane that would multiply unreduced orderings.
      schedule.later({ label: 'other' }, () => { schedule.write(ind) }, { tracked: true })
      return () => { if (count !== 2) throw new Error(`lost update: ${count}`) }
    }

    const found = await explore(scenario)
    expect(found.complete).toBe(false)
    expect(found.failure).toBeDefined()
    expect(String(found.failure?.error)).toMatch(/lost update: 1/)

    const replayed = await replay(scenario, found.failure!.choices)
    expect(replayed.taken).toEqual(found.failure!.taken)
    expect(String(replayed.error)).toMatch(/lost update: 1/)

    // Respects limit under DPOR.
    const limited = await explore((schedule) => {
      const reg = schedule.resource('reg')
      schedule.later({ label: 'a' }, () => { schedule.write(reg) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(reg) }, { tracked: true })
      schedule.later({ label: 'c' }, () => { schedule.write(reg) }, { tracked: true })
      return () => {}
    }, { limit: 2 })
    expect(limited).toEqual({ orderings: 2, complete: false })
  })

  it('reports an actionable error when an unsound tracked task breaks wakeup replay', async () => {
    const unsound: Scenario = (schedule) => {
      const shared = schedule.resource('shared')
      let flag = false
      schedule.later({ label: 'a' }, () => {
        flag = true
        schedule.write(shared)
      }, { tracked: true })
      schedule.later({ label: 'b' }, () => {
        if (flag) {
          schedule.later({ label: 'c' }, () => { schedule.write(shared) }, { tracked: true })
        }
      }, { tracked: true })
      return () => {}
    }

    await expect(explore(unsound)).rejects.toThrow(/Unsound tracked task/)
  })

  it('differential fuzz: wakeup-tree DPOR matches unreduced explore() across 30 nested programs (mixed, all, timers)', async () => {
    const mixed = await runDifferentialFuzz(explore, { seed: 42, programs: 10, maxFull: 1_000, profile: 'mixed' })
    const all = await runDifferentialFuzz(explore, { seed: 100_045, programs: 10, maxFull: 1_000, profile: 'all' })
    const timers = await runDifferentialFuzz(explore, { seed: 200_048, programs: 10, maxFull: 1_000, profile: 'timers' })
    expect(mixed.programs + all.programs + timers.programs).toBe(30)
    expect(mixed.totalReduced + all.totalReduced + timers.totalReduced).toBeLessThan(
      mixed.totalUnreduced + all.totalUnreduced + timers.totalUnreduced,
    )
  })

  it('falls back to plain unreduced search when nothing opts into tracked and handles tracked ordering-1 failure', async () => {
    // Purely untracked scenario never sets `reduced` and matches unreduced ordering count exactly.
    const untracked: Scenario = (schedule) => {
      schedule.does('a', ['1', () => {}], ['2', () => {}])
      schedule.does('b', ['1', () => {}], ['2', () => {}])
      return () => {}
    }
    const def = await explore(untracked)
    const explicit = await explore(untracked, { reduce: false })
    expect(def).toEqual({ orderings: 6, complete: true })
    expect(def).toEqual(explicit)

    // Ordering 1 executes only untracked tasks, so `explore()` stays in plain unreduced search even when
    // another branch spawns independent tracked tasks (verifies plain-search fallback is actually taken).
    const trackedOnlyOnBranch2: Scenario = (schedule) => {
      let aRan = false
      schedule.later({ label: 'a' }, () => { aRan = true })
      schedule.later({ label: 'b' }, () => {
        if (!aRan) {
          const rx = schedule.resource('rx')
          const ry = schedule.resource('ry')
          schedule.later({ label: 'x' }, () => { schedule.write(rx) }, { tracked: true })
          schedule.later({ label: 'y' }, () => { schedule.write(ry) }, { tracked: true })
        }
      })
      return () => {}
    }
    expect(await explore(trackedOnlyOnBranch2)).toEqual({ orderings: 7, complete: true })

    // Tracked scenario failing on ordering 1 reports exact failure without entering DPOR backtracking.
    const trackedFailFirst: Scenario = (schedule) => {
      const r = schedule.resource('r')
      schedule.later({ label: 'a' }, () => { schedule.write(r); throw new Error('boom-first') }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(r) }, { tracked: true })
      return () => {}
    }
    const fail1 = await explore(trackedFailFirst)
    expect(fail1.orderings).toBe(1)
    expect(fail1.complete).toBe(false)
    expect(fail1.reduced).toBeUndefined()
    expect(fail1.failure?.choices).toEqual([0])
    expect(fail1.failure?.taken).toEqual(['a'])
    expect(String(fail1.failure?.error)).toMatch(/boom-first/)
  })
})

describe('auditIndependence', () => {
  it('passes when tracked tasks genuinely commute and respects swaps cap', async () => {
    const sound: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      const c = schedule.resource('c')
      let va = 0
      let vb = 0
      let vc = 0
      schedule.later({ label: 'a' }, () => { schedule.write(a); va = 1 }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b); vb = 1 }, { tracked: true })
      schedule.later({ label: 'c' }, () => { schedule.write(c); vc = 1 }, { tracked: true })
      return () => { expect(va + vb + vc).toBe(3) }
    }

    const res = await auditIndependence(sound, { seed: 7, runs: 10, swaps: 5 })
    expect(res.violation).toBeUndefined()
    expect(res.checked).toBe(5)
    expect(res.runs).toBeLessThanOrEqual(10)

    const defaultRes = await auditIndependence(sound)
    expect(defaultRes.violation).toBeUndefined()
    expect(defaultRes.checked).toBeGreaterThan(0)
  })

  it('catches hidden shared-state outcome violations', async () => {
    const hiddenOrder: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      const order: string[] = []
      schedule.later({ label: 'a' }, () => { schedule.write(a); order.push('a') }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b); order.push('b') }, { tracked: true })
      return () => { if (order[0] !== 'a') throw new Error('expected a first') }
    }

    const audited = await auditIndependence(hiddenOrder, { seed: 1, runs: 5, swaps: 10 })
    expect(audited.violation).toBeDefined()
    expect(audited.violation?.reason).toMatch(/outcome differed after swapping/)
    expect(audited.violation?.first).toBeTruthy()
    expect(audited.violation?.second).toBeTruthy()
  })

  it('catches ready-lane divergence caused by hidden shared state', async () => {
    const hiddenBranch: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      let flag = false
      schedule.later({ label: 'a' }, () => { schedule.write(a); flag = true }, { tracked: true })
      schedule.later({ label: 'b' }, () => {
        schedule.write(b)
        if (flag) schedule.later({ label: 'extra' }, () => {}, { tracked: true })
      }, { tracked: true })
      return () => {}
    }

    const audited = await auditIndependence(hiddenBranch, { seed: 1, runs: 5, swaps: 10 })
    expect(audited.violation).toBeDefined()
    expect(audited.violation?.reason).toMatch(/ready lanes diverged/)
  })

  it('catches disabling violations where swapping prevents the other step from remaining enabled', async () => {
    const hiddenDisable: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      let spawned = false
      schedule.later({ label: 'setup-like' }, () => {
        schedule.write(a)
        spawned = true
        schedule.later({ label: 'child' }, () => { schedule.write(a) }, { tracked: true })
      }, { tracked: true })
      schedule.later({ label: 'other' }, () => {
        schedule.write(b)
        if (spawned) schedule.later({ label: 'other-child' }, () => { schedule.write(b) }, { tracked: true })
      }, { tracked: true })
      return () => {}
    }

    const audited = await auditIndependence(hiddenDisable, { seed: 1, runs: 10, swaps: 20 })
    expect(audited.violation).toBeDefined()
  })

  it('validates seed, runs, and swaps with RangeError', async () => {
    const noop: Scenario = () => () => {}
    for (const badSeed of [-1, 1.5, 0x1_0000_0000, Number.NaN]) {
      await expect(auditIndependence(noop, { seed: badSeed })).rejects.toThrow(RangeError)
    }
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(auditIndependence(noop, { runs: bad })).rejects.toThrow(RangeError)
      await expect(auditIndependence(noop, { swaps: bad })).rejects.toThrow(RangeError)
    }
  })
})

describe('everyOrder with reduce option', () => {
  it('supports { reduce: false } and { reduce: true }', async () => {
    const sc: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      schedule.later({ label: 'a' }, () => { schedule.write(a) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b) }, { tracked: true })
      return () => {}
    }
    expect(await everyOrder(sc)).toBe(1)
    expect(await everyOrder(sc, { reduce: false })).toBe(2)
  })
})

describe('Optimal DPOR core helpers and edge cases', () => {
  it('handles stepSubsumes, hasCoveringLeaf, and insertWut across conflicting, non-conflicting, and shared prefixes', () => {
    const r = (id: string) => { const a = makeAccess(true); a.reads.add(id); return a }
    const w = (id: string) => { const a = makeAccess(true); a.writes.add(id); return a }

    // conflicts symmetry: global, W/W, W/R, R/W, R/R
    expect(conflicts(makeAccess(false), makeAccess(true))).toBe(true)
    expect(conflicts(makeAccess(true), makeAccess(false))).toBe(true)
    expect(conflicts(w('x'), w('x'))).toBe(true)
    expect(conflicts(w('x'), r('x'))).toBe(true)
    expect(conflicts(r('x'), w('x'))).toBe(true)
    expect(conflicts(r('x'), r('x'))).toBe(false)

    const seededRoot = (laneId: string, access: ReturnType<typeof makeAccess>) => {
      const root = makeWutNode()
      root.children.push({ laneId, access, node: makeWutNode() })
      return root
    }

    // insertWut: sleep subsumption when lane is in seq (must commute with earlier steps in seq)
    const root1 = seededRoot('init', w('x'))
    const sleepConflict = new Map([['p', w('x')]])
    // `p` conflicts with earlier step `a` (w('x')), so sleep does NOT subsume [a, p, b].
    const seq1: StepRef[] = [
      { laneId: 'a', access: w('x') },
      { laneId: 'p', access: w('x') },
      { laneId: 'b', access: w('y') },
    ]
    insertWut(root1, sleepConflict, seq1)
    expect(root1.children.map((c) => c.laneId)).toEqual(['init', 'a'])
    expect(root1.children[1]!.node.children.map((c) => c.laneId)).toEqual(['p'])
    expect(root1.children[1]!.node.children[0]!.node.children.map((c) => c.laneId)).toEqual(['b'])

    // Sleep lane `p` commutes past earlier `a` (w('z')) when `p` is at index 1 of [a, p, b] -> subsumed!
    const root2 = seededRoot('init', w('x'))
    insertWut(root2, new Map([['p', w('x')]]), [
      { laneId: 'a', access: w('z') },
      { laneId: 'p', access: w('x') },
      { laneId: 'b', access: w('y') },
    ])
    expect(root2.children.map((c) => c.laneId)).toEqual(['init'])

    // Sleep lane `q` absent from seq never subsumes seq (even if disjoint from seq), so seq IS inserted.
    const root3 = seededRoot('init', w('y'))
    insertWut(root3, new Map([['q', w('other')]]), [
      { laneId: 'a', access: w('z') },
      { laneId: 'b', access: w('y') },
    ])
    expect(root3.children.map((c) => c.laneId)).toEqual(['init', 'a'])

    // Longer existing branch `a -> b` covers shorter prefix `[a]` (`!rem.length` base case in hasCoveringLeaf).
    const root4 = makeWutNode()
    const aBranch = makeWutNode()
    aBranch.children.push({ laneId: 'b', access: w('y'), node: makeWutNode() })
    root4.children.push({ laneId: 'a', access: w('x'), node: aBranch })
    insertWut(root4, new Map(), [{ laneId: 'a', access: w('x') }])
    expect(root4.children).toHaveLength(1)
    expect(aBranch.children.map((c) => c.laneId)).toEqual(['b'])

    // insertWut descending into an existing depth-2 prefix (`matched = true`) and skipping when covered by a leaf.
    const root5 = makeWutNode()
    const bNode = makeWutNode()
    const cNode = makeWutNode()
    bNode.children.push({ laneId: 'c', access: w('x'), node: cNode })
    const aNode = makeWutNode()
    aNode.children.push({ laneId: 'b', access: w('x'), node: bNode })
    root5.children.push({ laneId: 'a', access: w('x'), node: aNode })

    // Insert `[p(y), a(x), b(x), d(x)]`: descends BOTH `a` and `b` (`matched = true` twice) and adds `p -> d` under `b`.
    insertWut(root5, new Map(), [
      { laneId: 'p', access: w('y') },
      { laneId: 'a', access: w('x') },
      { laneId: 'b', access: w('x') },
      { laneId: 'd', access: w('x') },
    ])
    expect(root5.children).toHaveLength(1)
    expect(aNode.children).toHaveLength(1)
    expect(bNode.children.map((c) => c.laneId)).toEqual(['c', 'p'])
    expect(bNode.children[1]!.node.children.map((c) => c.laneId)).toEqual(['d'])

    // Inserting `[p(y), a(x), b(x), c(x)]` is ALREADY covered by leaf `a -> b -> c` -> `cNode` must stay a leaf!
    insertWut(root5, new Map(), [
      { laneId: 'p', access: w('y') },
      { laneId: 'a', access: w('x') },
      { laneId: 'b', access: w('x') },
      { laneId: 'c', access: w('x') },
    ])
    expect(cNode.children).toHaveLength(0)
    expect(bNode.children.map((c) => c.laneId)).toEqual(['c', 'p'])

    // findWakeups: transitive hb (0 -> 1 -> 2 -> 3 with disjoint direct links (0,2) and (1,3)) suppresses non-immediate race (0, 3).
    const pair = (k1: string, k2: string) => { const s = w(k1); s.writes.add(k2); return s }
    const steps: TraceStep[] = [
      { laneId: 'a', what: 'a', pushedBy: -1, preemptedClock: false, access: pair('x', 'end'), readyLaneIds: ['a', 'b', 'c', 'd'] },
      { laneId: 'b', what: 'b', pushedBy: -1, preemptedClock: false, access: pair('x', 'y'), readyLaneIds: ['b', 'c', 'd'] },
      { laneId: 'c', what: 'c', pushedBy: -1, preemptedClock: false, access: pair('y', 'z'), readyLaneIds: ['c', 'd'] },
      { laneId: 'd', what: 'd', pushedBy: -1, preemptedClock: false, access: pair('z', 'end'), readyLaneIds: ['d'] },
    ]
    const wakeups = findWakeups(steps)
    expect(wakeups.map((wk) => ({ depth: wk.depth, lanes: wk.seq.map((s) => s.laneId) }))).toEqual([
      { depth: 2, lanes: ['d'] },
      { depth: 1, lanes: ['c'] },
      { depth: 0, lanes: ['b'] },
    ])

    // Same-lane conflicting steps never produce a wakeup.
    const sameLane: TraceStep[] = [
      { laneId: 'a', what: 'a1', pushedBy: -1, preemptedClock: false, access: w('x'), readyLaneIds: ['a'] },
      { laneId: 'a', what: 'a2', pushedBy: -1, preemptedClock: false, access: w('x'), readyLaneIds: ['a'] },
    ]
    expect(findWakeups(sameLane)).toEqual([])

    // Transitive hb does NOT add spurious edges when rowK[j] is 0 (0 hb 1, !(1 hb 2), 0 hb 3 -> step 2 stays in notdep(0)).
    const nonTransitive: TraceStep[] = [
      { laneId: 'a', what: 'a', pushedBy: -1, preemptedClock: false, access: pair('x', 'z'), readyLaneIds: ['a', 'b', 'c', 'd'] },
      { laneId: 'b', what: 'b', pushedBy: -1, preemptedClock: false, access: w('x'), readyLaneIds: ['b', 'c', 'd'] },
      { laneId: 'c', what: 'c', pushedBy: -1, preemptedClock: false, access: w('y'), readyLaneIds: ['c', 'd'] },
      { laneId: 'd', what: 'd', pushedBy: -1, preemptedClock: false, access: w('z'), readyLaneIds: ['d'] },
    ]
    const ntWakeups = findWakeups(nonTransitive)
    expect(ntWakeups.find((wk) => wk.depth === 0 && wk.seq.at(-1)?.laneId === 'd')?.seq.map((s) => s.laneId)).toEqual(['c', 'd'])

    // Multi-word bitset (n = 35 crossing the 32-bit word boundary at bit 31 and word 1):
    // 0 -> 31 -> 33 suppresses (0, 33), while independent step 32 stays in notdep(0) for immediate race (0, 34).
    const longSteps: TraceStep[] = Array.from({ length: 35 }, (_, idx) => ({
      laneId: `L${idx}`,
      what: `s${idx}`,
      pushedBy: -1,
      preemptedClock: false,
      access: idx === 0
        ? (() => { const s = pair('k0', 'k33'); s.writes.add('k34'); return s })()
        : idx === 31
          ? pair('k0', 'k31')
          : idx === 33
            ? pair('k31', 'k33')
            : idx === 34
              ? w('k34')
              : w(`u${idx}`),
      readyLaneIds: [`L${idx}`],
    }))
    const longWakeups = findWakeups(longSteps)
    // (0, 33) must be suppressed via 0 -> 31 -> 33 across the 32-bit word boundary.
    expect(longWakeups.some((wk) => wk.depth === 0 && wk.seq.at(-1)?.laneId === 'L33')).toBe(false)
    // (0, 34) is immediate, and its seq includes L32 (word 1, bit 0) while excluding L31 (word 0, bit 31) and L33 (word 1, bit 1).
    const w034 = longWakeups.find((wk) => wk.depth === 0 && wk.seq.at(-1)?.laneId === 'L34')
    expect(w034).toBeDefined()
    const w034Lanes = w034!.seq.map((s) => s.laneId)
    expect(w034Lanes).toContain('L32')
    expect(w034Lanes).not.toContain('L31')
    expect(w034Lanes).not.toContain('L33')

    // Disabling wakeup for timer cancellation/preemption uses GLOBAL_ACCESS on a single `['clock']` step.
    const cancelTrace: TraceStep[] = [
      { laneId: 'c', what: 'cancel', pushedBy: -1, preemptedClock: true, access: w('t'), readyLaneIds: ['c', 'clock', 'o'] },
      { laneId: 'o', what: 'ind', pushedBy: -1, preemptedClock: false, access: w('r'), readyLaneIds: ['o', 'clock'] },
    ]
    const cancelWakeups = findWakeups(cancelTrace)
    expect(cancelWakeups).toHaveLength(1)
    expect(cancelWakeups[0]!.depth).toBe(0)
    expect(cancelWakeups[0]!.seq.map((s) => s.laneId)).toEqual(['clock'])
    const cancelWut = seededRoot('c', w('t'))
    insertWut(cancelWut, new Map(), cancelWakeups[0]!.seq)
    insertWut(cancelWut, new Map(), [
      { laneId: 'o', access: w('r') },
      { laneId: 'clock', access: w('t') },
    ])
    expect(cancelWut.children.map((ch) => ch.laneId)).toEqual(['c', 'clock', 'o'])
  })

  it('covers exploreUnreduced failure, exact limit boundary, and limit cutoff', async () => {
    const failing: Scenario = (schedule) => {
      const a = schedule.resource('a')
      let ranB = false
      schedule.later({ label: 'a' }, () => { schedule.write(a); if (ranB) throw new Error('b ran first') }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(a); ranB = true }, { tracked: true })
      return () => {}
    }
    const failRes = await explore(failing, { reduce: false })
    expect(failRes.orderings).toBe(2)
    expect(failRes.complete).toBe(false)
    expect(failRes.failure?.choices).toEqual([1])
    expect(failRes.failure?.taken).toEqual(['b', 'a'])
    expect(String(failRes.failure?.error)).toMatch(/b ran first/)

    const three: Scenario = (schedule) => {
      schedule.later({ label: 'a' }, () => {})
      schedule.later({ label: 'b' }, () => {})
      schedule.later({ label: 'c' }, () => {})
      return () => {}
    }
    expect(await explore(three, { reduce: false, limit: 2 })).toEqual({ orderings: 2, complete: false })
    expect(await explore(three, { reduce: false, limit: 6 })).toEqual({ orderings: 6, complete: true })
  })

  it('covers default untracked behavior across later, work, breaks, clock.after, and clock.sleep', async () => {
    // Untracked later, work, breaks, clock.after, and clock.sleep all default to global conflict (2 orderings).
    expect((await explore((s) => { s.later({ label: 'a' }, () => {}); s.later({ label: 'b' }, () => {}); return () => {} })).orderings).toBe(2)
    expect((await explore((s) => { void s.work('w1', 1); void s.work('w2', 2); return () => {} })).orderings).toBe(2)
    expect((await explore((s) => {
      void s.breaks('b1', new Error('1')).catch(() => {})
      void s.breaks('b2', new Error('2')).catch(() => {})
      return () => {}
    })).orderings).toBe(2)
    expect((await explore((s) => { s.clock.after(10, () => {}); s.later({ label: 'b' }, () => {}, { tracked: true }); return () => {} })).orderings).toBe(2)
    expect((await explore((s) => { void s.clock.sleep(10); s.later({ label: 'b' }, () => {}, { tracked: true }); return () => {} })).orderings).toBe(2)

    // Tracked work and breaks spawned inside tracked steps with identical labels commute (private lanes, shared = false).
    expect(await explore((s) => {
      s.later({ label: 'a' }, () => { void s.work('same', 1, { tracked: true }) }, { tracked: true })
      s.later({ label: 'b' }, () => { void s.work('same', 2, { tracked: true }) }, { tracked: true })
      return () => {}
    })).toEqual({ orderings: 1, complete: true, reduced: true })
    expect(await explore((s) => {
      s.later({ label: 'a' }, () => { void s.breaks('same', new Error('e'), { tracked: true }).catch(() => {}) }, { tracked: true })
      s.later({ label: 'b' }, () => { void s.breaks('same', new Error('e'), { tracked: true }).catch(() => {}) }, { tracked: true })
      return () => {}
    })).toEqual({ orderings: 1, complete: true, reduced: true })

    // clock.sleep(..., { tracked: true }) is accepted but remains globally conflicting for soundness.
    expect(await explore((s) => {
      void s.clock.sleep(10, { tracked: true })
      s.later({ label: 'b' }, () => {}, { tracked: true })
      return () => {}
    })).toEqual({ orderings: 2, complete: true })

    // Distinct dynamic lane labels pushed inside tracked steps commute (`push:dyn:${what}` distinguishes them).
    expect(await explore((s) => {
      s.later({ label: 'a' }, () => { s.later({ label: 'dyn1' }, () => {}, { tracked: true }) }, { tracked: true })
      s.later({ label: 'b' }, () => { s.later({ label: 'dyn2' }, () => {}, { tracked: true }) }, { tracked: true })
      return () => {}
    })).toEqual({ orderings: 1, complete: true, reduced: true })

    // schedule.does() defaults to untracked (string or `{ label }` without `tracked: true`) and commutes when `{ tracked: true }`.
    expect(await explore((s) => {
      const a = s.resource('a')
      const b = s.resource('b')
      s.does({ label: 'u1', tracked: true }, ['act', () => { s.write(a) }])
      s.does({ label: 'u2', tracked: true }, ['act', () => { s.write(b) }])
      return () => {}
    })).toEqual({ orderings: 1, complete: true, reduced: true })

    expect((await explore((s) => {
      const a = s.resource('a')
      const b = s.resource('b')
      s.does({ label: 'u1' }, ['act', () => { s.write(a) }])
      s.does({ label: 'u2', tracked: true }, ['act', () => { s.write(b) }])
      return () => {}
    })).orderings).toBe(2)

    // Verify tracked does() formats step labels as `${label}: ${what}` in failure trace.
    const doesFail = await explore((s) => {
      s.does({ label: 'win1', tracked: true }, ['click', () => { throw new Error('boom') }])
      return () => {}
    })
    expect(doesFail.failure?.taken).toEqual(['win1: click'])
  })

  it('tracks setup shared lanes distinctly by identity and distinguishes multi-step spawns, resources, and timers', async () => {
    // Two distinct setup lanes with the same label do not falsely conflict when tracked tasks push to them.
    const distinctSetupLanes = await explore((schedule) => {
      const s1 = { label: 'dup' }
      const s2 = { label: 'dup' }
      schedule.later(s1, () => {}, { tracked: true })
      schedule.later(s2, () => {}, { tracked: true })
      schedule.later({ label: 'a' }, () => { schedule.later(s1, () => {}, { tracked: true }) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.later(s2, () => {}, { tracked: true }) }, { tracked: true })
      return () => {}
    })
    expect(distinctSetupLanes).toEqual({ orderings: 1, complete: true, reduced: true })

    // Setup shared lane pushed to by two tracked tasks preserves push-order race.
    const pushOrder = new Set<string>()
    const sameSetupLane = await explore((schedule) => {
      const shared = { label: 'shared' }
      const log: string[] = []
      schedule.later(shared, () => { log.push('init') }, { tracked: true })
      schedule.later({ label: 'a' }, () => { schedule.later(shared, () => { log.push('a') }, { tracked: true }) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.later(shared, () => { log.push('b') }, { tracked: true }) }, { tracked: true })
      return () => { pushOrder.add(log.join(',')) }
    })
    expect(sameSetupLane.complete).toBe(true)
    expect([...pushOrder].sort()).toEqual(['init,a,b', 'init,b,a'])

    // Multi-step lane allocating resources on steps 0, 1, and 2 produces distinct canonical IDs via `laneSeq`.
    const laneSeqDistinct = await explore((schedule) => {
      const lane = { label: 'multi' }
      let r1!: Resource
      let r2!: Resource
      schedule.later(lane, () => { void schedule.resource('r0') }, { tracked: true })
      schedule.later(lane, () => { r1 = schedule.resource('r1') }, { tracked: true })
      schedule.later(lane, () => {
        r2 = schedule.resource('r2')
        schedule.later({ label: 'use1' }, () => { schedule.write(r1) }, { tracked: true })
        schedule.later({ label: 'use2' }, () => { schedule.write(r2) }, { tracked: true })
      }, { tracked: true })
      return () => {}
    })
    expect(laneSeqDistinct).toEqual({ orderings: 1, complete: true, reduced: true })

    // Dynamic access expansion on a wakeup branch: `observedParent` updates parentFrame.wut.children[0].access.
    const dynamicObserved = new Set<string>()
    const dynamicExpand = await explore((schedule) => {
      const x = schedule.resource('x')
      const y = schedule.resource('y')
      let xSet = false
      let yVal = 0
      schedule.later({ label: 'a' }, () => { schedule.write(x); xSet = true }, { tracked: true })
      schedule.later({ label: 'b' }, () => {
        schedule.write(x)
        if (!xSet) { schedule.write(y); yVal = 1 }
      }, { tracked: true })
      schedule.later({ label: 'c' }, () => { schedule.write(y); yVal = 2 }, { tracked: true })
      return () => { dynamicObserved.add(`${xSet},${yVal}`) }
    })
    expect(dynamicExpand).toEqual({ orderings: 3, complete: true, reduced: true })
    expect([...dynamicObserved].sort()).toEqual(['true,1', 'true,2'])

    // Classic 3-lane transitive bridge `a(x), b(x,y), c(y)` explores all 4 Mazurkiewicz equivalence classes (including c,b,a).
    const bridgeObserved = new Set<string>()
    const bridge = await explore((schedule) => {
      const x = schedule.resource('x')
      const y = schedule.resource('y')
      let vx = ''
      let vy = ''
      schedule.later({ label: 'a' }, () => { schedule.write(x); vx = 'a' }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(x); schedule.write(y); vx = 'b'; vy = 'b' }, { tracked: true })
      schedule.later({ label: 'c' }, () => { schedule.write(y); vy = 'c' }, { tracked: true })
      return () => { bridgeObserved.add(`${vx},${vy}`) }
    })
    expect(bridge).toEqual({ orderings: 4, complete: true, reduced: true })
    expect([...bridgeObserved].sort()).toEqual(['a,b', 'a,c', 'b,b', 'b,c'])

    // Sleep-set-blocked abort via `SLEEP_BLOCKED`: dynamic access shrinking leaves `b` in `sleep` when `c -> a` runs,
    // making `SLEEP_BLOCKED` the sole reason `reduced: true` is set (4 completed orderings out of 6, exact state match).
    const ssbObserved = new Set<string>()
    const ssbScenario: Scenario = (schedule) => {
      const r1 = schedule.resource('r1')
      const r2 = schedule.resource('r2')
      const r3 = schedule.resource('r3')
      // read()/write() outside a task are documented safe no-ops.
      schedule.read(r1)
      schedule.write(r1)
      let v1 = 0
      let cSet = false
      let saw = -1
      schedule.later({ label: 'a' }, () => {
        schedule.read(r2)
        if (!cSet) { schedule.write(r1); v1 = 1 }
      }, { tracked: true })
      schedule.later({ label: 'b' }, () => {
        schedule.read(r1)
        schedule.write(r1)
        saw = v1
        if (v1 === 1) schedule.write(r3)
      }, { tracked: true })
      schedule.later({ label: 'c' }, () => {
        schedule.write(r2)
        schedule.write(r3)
        cSet = true
      }, { tracked: true })
      return () => { ssbObserved.add(`${v1},${saw},${cSet}`) }
    }
    const ssb = await explore(ssbScenario)
    expect(ssb).toEqual({ orderings: 4, complete: true, reduced: true })
    const ssbDporStates = [...ssbObserved].sort()
    ssbObserved.clear()
    const ssbFull = await explore(ssbScenario, { reduce: false })
    expect(ssbFull).toEqual({ orderings: 6, complete: true })
    expect(ssbDporStates).toEqual([...ssbObserved].sort())

    // Timer cancellation with concurrent reads and sleep (fuzzer #1797 regression) matches unreduced states exactly.
    const sleepCancelStates = new Set<string>()
    const sleepCancelScenario: Scenario = (schedule) => {
      const r0 = schedule.resource('r0')
      const r2 = schedule.resource('r2')
      let v0 = 0
      const reads: number[] = []
      let sleepOutcome = 'none'
      const ac = new AbortController()
      schedule.clock.after(20, () => { schedule.write(r0); v0 = 99 }, { tracked: true })
      void schedule.clock.sleep(10, { signal: ac.signal, tracked: true }).then(
        () => { sleepOutcome = 'ok' },
        () => { sleepOutcome = 'aborted' },
      )
      const l0 = { label: 'l0' }
      schedule.later(l0, () => { schedule.read(r0); reads.push(v0) }, { tracked: true })
      schedule.later(l0, () => { reads.push(schedule.clock.monotonic()) }, { tracked: true })
      const l1 = { label: 'l1' }
      schedule.later(l1, () => { schedule.write(r2) }, { tracked: true })
      schedule.later(l1, () => { ac.abort(new Error('stop')) }, { tracked: true })
      return () => { sleepCancelStates.add(`${reads.join(',')}|${sleepOutcome}`) }
    }
    const sleepCancelDpor = await explore(sleepCancelScenario)
    expect(sleepCancelDpor.complete).toBe(true)
    expect(sleepCancelStates.has('0,0|ok')).toBe(true)
    const dporSnapshot = [...sleepCancelStates].sort()
    sleepCancelStates.clear()
    await explore(sleepCancelScenario, { reduce: false })
    expect(dporSnapshot).toEqual([...sleepCancelStates].sort())
  })

  it('tracks clock.monotonic(), clock.after() reading clock, canceller-first timer cancellation, sleep abort cleanup, and outside() conflicts', async () => {
    // 1. clock.monotonic() races with a timer that advances time.
    const monoTimes = new Set<number>()
    const mono = await explore((schedule) => {
      schedule.clock.after(10, () => {}, { tracked: true })
      schedule.later({ label: 'reader' }, () => { monoTimes.add(schedule.clock.monotonic()) }, { tracked: true })
      return () => {}
    })
    expect(mono).toEqual({ orderings: 2, complete: true })
    expect([...monoTimes].sort((a, b) => a - b)).toEqual([0, 10])

    // 2. clock.after() reads current clock when computing due time, so it races with an advancing timer.
    const firedAt = new Set<number>()
    const afterReadsClock = await explore((schedule) => {
      schedule.clock.after(10, () => {}, { tracked: true })
      schedule.later({ label: 'setter' }, () => {
        schedule.clock.after(5, () => { firedAt.add(schedule.clock.now()) }, { tracked: true })
      }, { tracked: true })
      return () => {}
    })
    expect(afterReadsClock.complete).toBe(true)
    expect([...firedAt].sort((a, b) => a - b)).toEqual([5, 15])

    // 2b. Priority-queue preemption: setter registered BEFORE T_late@50 preempts T_late@50 (both 10 ms and 60 ms observed).
    const preemptDirect = new Set<number>()
    const preemptRes = await explore((schedule) => {
      schedule.later({ label: 'setter' }, () => {
        schedule.clock.after(10, () => { preemptDirect.add(schedule.clock.now()) }, { tracked: true })
      }, { tracked: true })
      schedule.clock.after(50, () => {}, { tracked: true })
      return () => {}
    })
    expect(preemptRes).toEqual({ orderings: 2, complete: true })
    expect([...preemptDirect].sort((a, b) => a - b)).toEqual([10, 60])

    // 2c. Priority-queue preemption behind a 0 ms timer: setter splices at index 1 between T0@0 and T_late@50.
    const preemptMiddle = new Set<number>()
    const preemptMidRes = await explore((schedule) => {
      schedule.later({ label: 'setter' }, () => {
        schedule.clock.after(10, () => { preemptMiddle.add(schedule.clock.now()) }, { tracked: true })
      }, { tracked: true })
      schedule.clock.after(0, () => {}, { tracked: true })
      schedule.clock.after(50, () => {}, { tracked: true })
      return () => {}
    })
    expect(preemptMidRes.complete).toBe(true)
    expect([...preemptMiddle].sort((a, b) => a - b)).toEqual([10, 60])

    // 2d. Scheduling a later timer then an earlier timer inside the SAME step is not an external preemption.
    const selfPreempt = await explore((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      schedule.later({ label: 'a' }, () => {
        schedule.write(a)
        schedule.clock.after(50, () => { schedule.write(a) }, { tracked: true })
        schedule.clock.after(10, () => { schedule.write(a) }, { tracked: true })
      }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b) }, { tracked: true })
      return () => {}
    })
    expect(selfPreempt).toEqual({ orderings: 4, complete: true })

    // 2e. Scheduling a LATER timer behind a pending 0 ms timer does not preempt it (`timers.slice(at)` is empty).
    const noPreemptLater = await explore((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      schedule.later({ label: 'setter' }, () => {
        schedule.clock.after(50, () => { schedule.write(a) }, { tracked: true })
      }, { tracked: true })
      schedule.clock.after(0, () => { schedule.write(b) }, { tracked: true })
      return () => {}
    })
    expect(noPreemptLater).toEqual({ orderings: 2, complete: true })

    // 3. Canceller registered BEFORE the timer so canceller runs FIRST at depth 0 (exercises disabling wakeup!).
    const cancelFirstOutcomes = new Set<string>()
    const cancelFirst = await explore((schedule) => {
      let fired = false
      let cancel!: () => void
      schedule.later({ label: 'canceller' }, () => { cancel() }, { tracked: true })
      cancel = schedule.clock.after(10, () => { fired = true }, { tracked: true })
      return () => { cancelFirstOutcomes.add(String(fired)) }
    })
    expect(cancelFirst).toEqual({ orderings: 2, complete: true })
    expect([...cancelFirstOutcomes].sort()).toEqual(['false', 'true'])

    // 4. Cancelling a timer during setup removes it cleanly with no activeStep.
    const setupCancel = await explore((schedule) => {
      let fired = false
      const cancel = schedule.clock.after(10, () => { fired = true }, { tracked: true })
      cancel()
      return () => { expect(fired).toBe(false) }
    })
    expect(setupCancel).toEqual({ orderings: 1, complete: true })

    // 5. clock.sleep removes its abort listener with event name `'abort'` on both resolution and abort.
    const activeListeners = new Map<unknown, string>()
    let everAdded = 0
    const trackedSignal = (): { signal: AbortSignal; abort: () => void } => {
      const ac = new AbortController()
      const origAdd = ac.signal.addEventListener.bind(ac.signal)
      const origRemove = ac.signal.removeEventListener.bind(ac.signal)
      ac.signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
        everAdded++
        activeListeners.set(args[1], args[0])
        return origAdd(...args)
      }) as AbortSignal['addEventListener']
      ac.signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
        if (activeListeners.get(args[1]) === args[0]) activeListeners.delete(args[1])
        return origRemove(...args)
      }) as AbortSignal['removeEventListener']
      return { signal: ac.signal, abort: () => ac.abort(new Error('stop')) }
    }
    await explore((schedule) => {
      const { signal } = trackedSignal()
      void schedule.clock.sleep(10, { signal, tracked: true })
      return () => {}
    })
    await explore((schedule) => {
      const { signal, abort } = trackedSignal()
      void schedule.clock.sleep(10, { signal, tracked: true }).catch(() => {})
      schedule.later({ label: 'ab' }, () => { abort() }, { tracked: true })
      return () => {}
    })
    expect(everAdded).toBeGreaterThan(2)
    expect(activeListeners.size).toBe(0)

    // 6. Tracked tasks calling outside() and done() in separate steps conflict on 'sys:outside'.
    const outsideOrders = new Set<string>()
    const withOutside = await explore((schedule) => {
      const log: string[] = []
      const done1 = schedule.outside()
      schedule.later({ label: 'finisher' }, () => { log.push('done'); done1() }, { tracked: true })
      schedule.later({ label: 'starter' }, () => {
        log.push('start')
        const done2 = schedule.outside()
        setTimeout(() => { done2() }, 1)
      }, { tracked: true })
      return () => { outsideOrders.add(log.join(',')) }
    })
    expect(withOutside).toEqual({ orderings: 2, complete: true })
    expect([...outsideOrders].sort()).toEqual(['done,start', 'start,done'])
  })

  it('reports reduced: true on failure and on limit cutoff after skipping redundant branches, and respects exact limit', async () => {
    // Failure after skipping an independent branch sets reduced: true.
    const failAfterReduce = await explore((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      const x = schedule.resource('x')
      let seen = 0
      schedule.later({ label: 'w1' }, () => { schedule.write(x); seen = 1 }, { tracked: true })
      schedule.later({ label: 'w2' }, () => { schedule.write(x); if (seen === 0) throw new Error('w2 first') }, { tracked: true })
      schedule.later({ label: 'a' }, () => { schedule.write(a) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b) }, { tracked: true })
      return () => {}
    })
    expect(failAfterReduce.complete).toBe(false)
    expect(failAfterReduce.reduced).toBe(true)
    expect(String(failAfterReduce.failure?.error)).toMatch(/w2 first/)

    // Limit cutoff after reducing sets reduced: true, and nested recursion unwinds cleanly.
    const limitAfterReduce = await explore((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      const x = schedule.resource('x')
      schedule.later({ label: 'w1' }, () => { schedule.write(x) }, { tracked: true })
      schedule.later({ label: 'w2' }, () => { schedule.write(x) }, { tracked: true })
      schedule.later({ label: 'w3' }, () => { schedule.write(x) }, { tracked: true })
      schedule.later({ label: 'a' }, () => { schedule.write(a) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b) }, { tracked: true })
      return () => {}
    }, { limit: 3 })
    expect(limitAfterReduce).toEqual({ orderings: 3, complete: false, reduced: true })

    // Nested failure inside a recursive branch immediately unwinds without exploring remaining siblings.
    const nestedFail = await explore((schedule) => {
      const x = schedule.resource('x')
      const log: string[] = []
      schedule.later({ label: 'w1' }, () => { schedule.write(x); log.push('1') }, { tracked: true })
      schedule.later({ label: 'w2' }, () => { schedule.write(x); log.push('2') }, { tracked: true })
      schedule.later({ label: 'w3' }, () => { schedule.write(x); log.push('3') }, { tracked: true })
      return () => { if (log.join('') === '132') throw new Error('nested fail') }
    })
    expect(nestedFail.orderings).toBe(2)
    expect(nestedFail.complete).toBe(false)
    expect(nestedFail.reduced).toBeUndefined()

    // Nested hitLimit inside a recursive branch unwinds without marking `wasReduced = true`.
    const nestedLimit = await explore((schedule) => {
      const x = schedule.resource('x')
      const y = schedule.resource('y')
      schedule.later({ label: 'w1' }, () => { schedule.write(x) }, { tracked: true })
      schedule.later({ label: 'w2' }, () => {
        schedule.write(x)
        schedule.later({ label: 'u1' }, () => { schedule.write(y) }, { tracked: true })
        schedule.later({ label: 'u2' }, () => { schedule.write(y) }, { tracked: true })
      }, { tracked: true })
      return () => {}
    }, { limit: 2 })
    expect(nestedLimit).toEqual({ orderings: 2, complete: false })

    // Exact limit boundary returns complete: true.
    const exact = await explore((schedule) => {
      const x = schedule.resource('x')
      schedule.later({ label: 'w1' }, () => { schedule.write(x) }, { tracked: true })
      schedule.later({ label: 'w2' }, () => { schedule.write(x) }, { tracked: true })
      return () => {}
    }, { limit: 2 })
    expect(exact).toEqual({ orderings: 2, complete: true })
  })

  it('covers auditIndependence edge cases: zero pairs, prefix slicing, sameLaneSet shapes, both outcome directions, and exact error messages', async () => {
    // 1. Scenario with no independent adjacent pairs (same-lane disjoint steps) checks 0 swaps.
    const noPairs: Scenario = (schedule) => {
      const x = schedule.resource('x')
      const y = schedule.resource('y')
      const lane = { label: 'single' }
      schedule.later(lane, () => { schedule.write(x) }, { tracked: true })
      schedule.later(lane, () => { schedule.write(y) }, { tracked: true })
      return () => {}
    }
    expect(await auditIndependence(noPairs, { seed: 1, runs: 3, swaps: 10 })).toEqual({ runs: 3, checked: 0 })

    // runs: 1 executes the 1st run (kills `run < runs` boundary).
    const oneRun = await auditIndependence((schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      schedule.later({ label: 'a' }, () => { schedule.write(a) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b) }, { tracked: true })
      return () => {}
    }, { seed: 1, runs: 1, swaps: 10 })
    expect(oneRun).toEqual({ runs: 1, checked: 1 })

    // 2. Violation at depth i = 3 after [single, multi, single] reports exact 1-element `prefix`.
    const withPrefix: Scenario = (schedule) => {
      const init = schedule.resource('init')
      const x = schedule.resource('x')
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      let done = 0
      let hidden = false
      const spawnInd = (): void => {
        if (++done < 2) return
        schedule.later({ label: 'indA' }, () => { schedule.write(a); hidden = true }, { tracked: true })
        schedule.later({ label: 'indB' }, () => {
          schedule.write(b)
          if (hidden) throw new Error('saw hidden')
        }, { tracked: true })
      }
      schedule.later({ label: 'solo' }, () => {
        schedule.write(init)
        schedule.later({ label: 'c1' }, () => { schedule.write(x); spawnInd() }, { tracked: true })
        schedule.later({ label: 'c2' }, () => { schedule.write(x); spawnInd() }, { tracked: true })
      }, { tracked: true })
      return () => {}
    }
    const prefRes = await auditIndependence(withPrefix, { seed: 1, runs: 10, swaps: 20 })
    expect(prefRes.violation).toBeDefined()
    expect(prefRes.violation!.prefix).toHaveLength(1)
    expect(prefRes.violation!.reason).toMatch(/outcome differed after swapping/)
    // violation.choices is directly replayable with replay().
    const replayedAudit = await replay(withPrefix, prefRes.violation!.choices)
    expect(replayedAudit.taken.length).toBeGreaterThanOrEqual(4)

    // 2b. Downstream divergence at step i + 3 (orig has [a, b, c, extra], swapped ends cleanly at [b, a, c]).
    const downstreamDiverge: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      const c = schedule.resource('c')
      let hidden = false
      schedule.later({ label: 'a' }, () => { schedule.write(a); hidden = true }, { tracked: true })
      schedule.later({ label: 'b' }, () => {
        schedule.write(b)
        const saw = hidden
        schedule.later({ label: 'c' }, () => {
          schedule.write(c)
          if (!saw) schedule.later({ label: 'extra' }, () => {}, { tracked: true })
        }, { tracked: true })
      }, { tracked: true })
      return () => {}
    }
    const dDownstream = await auditIndependence(downstreamDiverge, { seed: 1, runs: 10, swaps: 20 })
    expect(dDownstream.violation?.reason).toMatch(/ready lanes diverged after swapping/)

    // 2c. Resource access divergence: hidden state changes what resources `a` or `b` reads/writes when swapped.
    const readAccessDiverge: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      const r1 = schedule.resource('r1')
      const r2 = schedule.resource('r2')
      let hidden = false
      schedule.later({ label: 'a' }, () => { schedule.write(a); hidden = true }, { tracked: true })
      schedule.later({ label: 'b' }, () => {
        schedule.write(b)
        schedule.read(hidden ? r1 : r2)
      }, { tracked: true })
      return () => {}
    }
    const dReadAcc = await auditIndependence(readAccessDiverge, { seed: 1, runs: 10, swaps: 20 })
    expect(dReadAcc.violation?.reason).toMatch(/resource accesses diverged after swapping/)

    const writeSizeDiverge: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      const extra = schedule.resource('extra')
      let hidden = false
      schedule.later({ label: 'a' }, () => {
        schedule.write(a)
        if (!hidden) schedule.write(extra)
      }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b); hidden = true }, { tracked: true })
      return () => {}
    }
    const dWriteAcc1 = await auditIndependence(writeSizeDiverge, { seed: 1, runs: 1, swaps: 10 })
    expect(dWriteAcc1.violation?.reason).toMatch(/resource accesses diverged after swapping/)
    const dWriteAcc2 = await auditIndependence(writeSizeDiverge, { seed: 7, runs: 1, swaps: 10 })
    expect(dWriteAcc2.violation?.reason).toMatch(/resource accesses diverged after swapping/)

    // 2d. Both orig and swapped throw, but swapped throws inside step `i` (`swapped.steps[i + 1]` is undefined).
    const bothThrowEarly: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      let aRan = false
      schedule.later({ label: 'a' }, () => { schedule.write(a); aRan = true }, { tracked: true })
      schedule.later({ label: 'b' }, () => {
        schedule.write(b)
        if (!aRan) throw new Error('b threw early')
      }, { tracked: true })
      return () => { throw new Error('check always fails') }
    }
    const dEarlyThrow = await auditIndependence(bothThrowEarly, { seed: 2, runs: 10, swaps: 20 })
    expect(dEarlyThrow.violation?.reason).toMatch(/resource accesses diverged after swapping/)

    // 3. Ready-lane divergence where orig ends right after (i, i+1) while swapped spawns an extra lane, and vice versa.
    const origEndsSwapContinues: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      let aRan = false
      schedule.later({ label: 'a' }, () => { schedule.write(a); aRan = true }, { tracked: true })
      schedule.later({ label: 'b' }, () => {
        schedule.write(b)
        if (!aRan) schedule.later({ label: 'extra' }, () => {}, { tracked: true })
      }, { tracked: true })
      return () => {}
    }
    const d1 = await auditIndependence(origEndsSwapContinues, { seed: 1, runs: 10, swaps: 10 })
    expect(d1.violation?.reason).toMatch(/ready lanes diverged after swapping/)

    // 4a. sameLaneSet subset length mismatch: orig has [stopper] at i+2 while swapped has [stopper, extra] (both throw at stopper!).
    const subsetMismatch: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      let aRan = false
      const stopper = { label: 'stopper' }
      const extra = { label: 'extra' }
      schedule.later({ label: 'a' }, () => { schedule.write(a); aRan = true }, { tracked: true })
      schedule.later({ label: 'b' }, () => {
        schedule.write(b)
        schedule.later(stopper, () => { throw new Error('halt') }, { tracked: true })
        if (aRan) schedule.later(extra, () => {}, { tracked: true })
      }, { tracked: true })
      return () => {}
    }
    const dSubset = await auditIndependence(subsetMismatch, { seed: 1, runs: 20, swaps: 50 })
    expect(dSubset.violation?.reason).toMatch(/ready lanes diverged after swapping/)

    // 4b. sameLaneSet same-length element mismatch: orig has [stopper, l1] and swapped has [stopper, l2] (both throw at stopper!).
    const diffElemSameCount: Scenario = (schedule) => {
      const ra = schedule.resource('ra')
      const rb = schedule.resource('rb')
      const z = schedule.resource('z')
      let aRan = false
      const l1 = { label: 'l1' }
      const l2 = { label: 'l2' }
      const stopper = { label: 'stopper' }
      schedule.later(l1, () => {
        schedule.later(l2, () => {
          schedule.later({ label: 'a' }, () => { schedule.write(ra); aRan = true }, { tracked: true })
          schedule.later({ label: 'b' }, () => {
            schedule.write(rb)
            schedule.later(stopper, () => { schedule.write(ra); schedule.write(z); throw new Error('halt') }, { tracked: true })
            schedule.later(aRan ? l1 : l2, () => { schedule.write(ra); schedule.write(z) }, { tracked: true })
          }, { tracked: true })
        }, { tracked: true })
      }, { tracked: true })
      return () => {}
    }
    const dDiffElem = await auditIndependence(diffElemSameCount, { seed: 1, runs: 20, swaps: 50 })
    expect(dDiffElem.violation?.reason).toMatch(/ready lanes diverged after swapping/)

    // 4c. Single-ready lane mismatch at i+3 (kills `chooseSingle = false` in auditIndependence).
    const singleReadyMismatch: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      let aRan = false
      const l1 = { label: 'l1' }
      const l2 = { label: 'l2' }
      // Register l1 and l2 during setup so their lane IDs are fixed and distinct.
      schedule.later(l1, () => {}, { tracked: true })
      schedule.later(l2, () => {}, { tracked: true })
      schedule.later({ label: 'a' }, () => { schedule.write(a); aRan = true }, { tracked: true })
      schedule.later({ label: 'b' }, () => {
        schedule.write(b)
        schedule.later({ label: 'bridge' }, () => {
          schedule.later(aRan ? l1 : l2, () => {}, { tracked: true })
        }, { tracked: true })
      }, { tracked: true })
      return () => {}
    }
    const dSingle = await auditIndependence(singleReadyMismatch, { seed: 1, runs: 20, swaps: 50 })
    expect(dSingle.violation?.reason).toMatch(/ready lanes diverged at step/)

    // 5. Outcome divergence when orig FAILS and swapped PASSES.
    const origFailsSwapPasses: Scenario = (schedule) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      const order: string[] = []
      schedule.later({ label: 'a' }, () => { schedule.write(a); order.push('a') }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b); order.push('b') }, { tracked: true })
      return () => { if (order[0] === 'b') throw new Error('b first fails') }
    }
    const d3 = await auditIndependence(origFailsSwapPasses, { seed: 1, runs: 10, swaps: 10 })
    expect(d3.violation?.reason).toMatch(/outcome differed after swapping/)

    // 6. Exact RangeError messages on sample() and auditIndependence().
    const noop: Scenario = () => () => {}
    await expect(auditIndependence(noop, { seed: -1 })).rejects.toThrow('auditIndependence expects seed to be a 32-bit unsigned integer, and was given -1')
    await expect(auditIndependence(noop, { runs: 0 })).rejects.toThrow('auditIndependence expects runs to be a positive safe integer, and was given 0')
    await expect(auditIndependence(noop, { swaps: 0 })).rejects.toThrow('auditIndependence expects swaps to be a positive safe integer, and was given 0')
    await expect(sample(noop, { seed: -1, runs: 1 })).rejects.toThrow('sample expects seed to be a 32-bit unsigned integer, and was given -1')
    await expect(sample(noop, { seed: 1, runs: 0 })).rejects.toThrow('sample expects runs to be a positive safe integer, and was given 0')
  })
})
