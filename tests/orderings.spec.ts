import { afterEach, describe, expect, it, vi } from 'vitest'
import { everyOrder, explore, replay, sample, type Clock, type Scenario } from '../src/index.ts'

/** Two lanes of two things each, and the order they ran in. `seen` collects every order run. */
const twoByTwo = (seen: string[], fails?: string): Scenario => (schedule) => {
  const ran: string[] = []
  schedule.does('x', ['1', () => { ran.push('x1') }], ['2', () => { ran.push('x2') }])
  schedule.does('y', ['1', () => { ran.push('y1') }], ['2', () => { ran.push('y2') }])
  return () => {
    seen.push(ran.join(' '))
    if (ran.join(' ') === fails) throw new Error('this order fails')
  }
}

describe('a schedule', () => {
  it('runs a scenario under every order its lanes allow, once each, a lane keeping its order', async () => {
    const seen: string[] = []
    const explored = await explore((schedule) => {
      expect(Object.isFrozen(schedule)).toBe(true)
      expect(Object.isFrozen(schedule.clock)).toBe(true)
      return twoByTwo(seen)(schedule)
    })
    expect(explored).toEqual({ orderings: 6, complete: true })
    expect(new Set(seen).size).toBe(6)
    for (const order of seen) {
      expect(order.indexOf('x1')).toBeLessThan(order.indexOf('x2'))
      expect(order.indexOf('y1')).toBeLessThan(order.indexOf('y2'))
    }

    // Asymmetric dynamic branching: branch 0 spawns extra work while branch 1 finishes immediately.
    const asymmetric: string[] = []
    const count = await everyOrder((schedule) => {
      const log: string[] = []
      schedule.does('a', ['go', () => {
        log.push('a')
        if (log.length === 1) schedule.does('extra', ['step', () => { log.push('extra') }])
      }])
      schedule.does('b', ['go', () => { log.push('b') }])
      return () => { asymmetric.push(log.join(',')) }
    })
    expect(count).toBe(3)
    expect(asymmetric.sort()).toEqual(['a,b,extra', 'a,extra,b', 'b,a'])
  })

  it('stops at the first order that fails, runs that one again with replay, and surfaces non-Error throws and causes', async () => {
    const explored = await explore(twoByTwo([], 'y1 x1 y2 x2'))
    expect(explored.complete).toBe(false)
    expect(explored.failure?.taken).toEqual(['y: 1', 'x: 1', 'y: 2', 'x: 2'])

    const seen: string[] = []
    const again = await replay(twoByTwo(seen, 'y1 x1 y2 x2'), explored.failure!.choices)
    expect(seen).toEqual(['y1 x1 y2 x2'])
    expect(again.error).toBeInstanceOf(Error)

    // Passing replay omits `error` and defaults omitted trailing choices to 0.
    const passing = await replay(twoByTwo([], 'y1 x1 y2 x2'), [])
    expect('error' in passing).toBe(false)
    expect(passing.taken).toEqual(['x: 1', 'x: 2', 'y: 1', 'y: 2'])

    await expect(everyOrder(twoByTwo([], 'y1 x1 y2 x2'))).rejects.toThrow(/Failed in ordering 5 \(replay with \[1, 0, 1\]\):\n {2}y: 1\n {2}x: 1\n {2}y: 2\n {2}x: 2\nthis order fails/)

    // Non-Error throw is formatted with String(error) and attached as `cause`.
    let caught: Error | undefined
    try {
      await everyOrder(() => () => { throw 'plain-failure' })
    } catch (error) {
      caught = error as Error
    }
    expect(caught?.message).toMatch(/plain-failure/)
    expect(caught?.cause).toBe('plain-failure')
  })

  it('runs what one thing puts off after it, reuses emptied lanes, and lets promises settle between', async () => {
    const orderings = await everyOrder((schedule) => {
      const ran: string[] = []
      const lane = { label: 'put off' }
      schedule.later(lane, () => { ran.push('first') })
      void schedule.work('outside', 'done').then(async (value) => {
        await Promise.resolve()
        ran.push(value)
        schedule.later(lane, () => { ran.push('after') })
      })
      void schedule.breaks('broken', new Error('no')).catch(() => { ran.push('failed') })
      return () => {
        expect(ran).toContain('first')
        expect(ran).toContain('failed')
        expect(ran.indexOf('done')).toBeLessThan(ran.indexOf('after'))
      }
    })
    expect(orderings).toBe(8)
  })

  it('awaits async post-condition check functions and surfaces their rejections', async () => {
    let passed = 0
    const count = await everyOrder((schedule) => {
      schedule.does('a', ['1', () => {}])
      return async () => {
        await Promise.resolve()
        passed++
      }
    })
    expect(count).toBe(1)
    expect(passed).toBe(1)

    await expect(everyOrder((schedule) => {
      schedule.does('a', ['1', () => {}])
      return async () => {
        await Promise.resolve()
        throw new Error('async check boom')
      }
    })).rejects.toThrow(/async check boom/)
  })

  it('waits for outside() work before coming to rest, supports multiple handles, and makes release idempotent', async () => {
    const seen: string[] = []
    const orderings = await everyOrder((schedule) => {
      const ran: string[] = []
      const lane = { label: 'socket' }
      const done1 = schedule.outside()
      const done2 = schedule.outside()
      setTimeout(() => {
        schedule.later(lane, () => { ran.push('msg1') })
        done1()
        // Calling release twice must not underflow `away` or skip waiting for done2.
        done1()
        setTimeout(() => {
          schedule.later(lane, () => { ran.push('msg2') })
          done2()
        }, 5)
      }, 5)
      schedule.does('local', ['step', () => { ran.push('local') }])
      return () => {
        seen.push(ran.join(','))
        expect(ran).toContain('local')
        expect(ran).toContain('msg1')
        expect(ran).toContain('msg2')
        expect(ran.indexOf('msg1')).toBeLessThan(ran.indexOf('msg2'))
      }
    })
    expect(orderings).toBe(1)
    expect(seen).toEqual(['local,msg1,msg2'])

    // Outside release called before lanes drain does not stall the scheduler.
    const immediate = await everyOrder((schedule) => {
      const done = schedule.outside()
      schedule.does('a', ['finish outside', () => { done() }])
      return () => {}
    })
    expect(immediate).toBe(1)

    // Streaming outside work: queueing into a lane or clock while still holding an outside handle wakes the loop immediately.
    const streamed: string[] = []
    const streamOrderings = await everyOrder((schedule) => {
      const lane = { label: 'stream' }
      const done = schedule.outside()
      setTimeout(() => {
        schedule.later(lane, () => {
          streamed.push('chunk1')
          schedule.clock.after(10, () => {
            streamed.push('tick')
            done()
          })
        })
      }, 5)
      return () => { expect(streamed).toEqual(['chunk1', 'tick']) }
    })
    expect(streamOrderings).toBe(1)

    // Scheduling directly on the clock while asleep on outside() also wakes the loop before release.
    const clockStreamed: string[] = []
    const clockStreamOrderings = await everyOrder((schedule) => {
      const done = schedule.outside()
      setTimeout(() => {
        schedule.clock.after(5, () => {
          clockStreamed.push('clock-wake')
          done()
        })
      }, 5)
      return () => { expect(clockStreamed).toEqual(['clock-wake']) }
    })
    expect(clockStreamOrderings).toBe(1)
  })

  it('samples the same orders from the same seed, reports failures, and validates seed and runs', async () => {
    const first: string[] = []
    const second: string[] = []
    const r1 = await sample(twoByTwo(first), { seed: 7, runs: 20 })
    const r2 = await sample(twoByTwo(second), { seed: 7, runs: 20 })
    expect(r1).toEqual({ orderings: 20, complete: false })
    expect(r2).toEqual({ orderings: 20, complete: false })
    expect(first).toHaveLength(20)
    expect(first).toEqual(second)
    expect(new Set(first).size).toBeGreaterThan(1)
    // Exact boundary: runs === 1 runs one ordering.
    const single: string[] = []
    expect(await sample(twoByTwo(single), { seed: 7, runs: 1 })).toEqual({ orderings: 1, complete: false })
    expect(single).toHaveLength(1)
    // Pin Mulberry32 output for seed 7 so seeded sampling remains stable across releases.
    const pinned: string[] = []
    await sample(twoByTwo(pinned), { seed: 7, runs: 6 })
    expect(pinned).toEqual(first.slice(0, 6))
    expect(pinned).toEqual(['x1 x2 y1 y2', 'y1 y2 x1 x2', 'y1 x1 x2 y2', 'x1 y1 y2 x2', 'x1 x2 y1 y2', 'y1 y2 x1 x2'])

    // sample() stops on the first failing run and returns failure details.
    const failed = await sample(twoByTwo([], 'y1 x1 y2 x2'), { seed: 7, runs: 50 })
    expect(failed.complete).toBe(false)
    expect(failed.orderings).toBeLessThanOrEqual(50)
    expect(failed.failure?.taken).toEqual(['y: 1', 'x: 1', 'y: 2', 'x: 2'])

    for (const badSeed of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(sample(twoByTwo([]), { seed: badSeed, runs: 5 })).rejects.toThrow(RangeError)
    }
    await expect(sample(twoByTwo([]), { seed: Number.NaN, runs: 5 })).rejects.toThrow(/finite seed.*NaN/)
    for (const badRuns of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(sample(twoByTwo([]), { seed: 1, runs: badRuns })).rejects.toThrow(RangeError)
    }
    await expect(sample(twoByTwo([]), { seed: 1, runs: 0 })).rejects.toThrow(/positive safe integer.*given 0/)
  })

  it('validates explore/everyOrder limit boundaries and replay choice bounds', async () => {
    // Exact boundary: 6 orderings completes cleanly at limit 6, stops incomplete at limit 5 and limit 1.
    expect(await explore(twoByTwo([]), { limit: 6 })).toEqual({ orderings: 6, complete: true })
    expect(await explore(twoByTwo([]), { limit: 5 })).toEqual({ orderings: 5, complete: false })
    expect(await explore(twoByTwo([]), { limit: 1 })).toEqual({ orderings: 1, complete: false })
    expect(await explore(twoByTwo([]), { limit: Number.POSITIVE_INFINITY })).toEqual({ orderings: 6, complete: true })
    await expect(everyOrder(twoByTwo([]), { limit: 3 })).rejects.toThrow(/More than 3 orderings/)

    for (const badLimit of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      await expect(explore(twoByTwo([]), { limit: badLimit })).rejects.toThrow(RangeError)
      await expect(everyOrder(twoByTwo([]), { limit: badLimit })).rejects.toThrow(RangeError)
    }
    await expect(explore(twoByTwo([]), { limit: 0 })).rejects.toThrow(/given 0/)

    // replay() rejects negative, non-integer, or out-of-range choices loudly instead of masking them as scenario bugs.
    for (const badChoices of [[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]]) {
      await expect(replay(twoByTwo([]), badChoices)).rejects.toThrow(RangeError)
    }
    await expect(replay(twoByTwo([]), [-1])).rejects.toThrow(/got -1 at index 0/)
    await expect(replay(twoByTwo([]), [2])).rejects.toThrow(/choice 2 at depth 0 is out of range for 2 ready lanes/)
  })

  it('says so when a scenario never comes to rest, and cleans up pending sleep listeners on runaway or error', async () => {
    const runawaySignal = new AbortController()
    const removeRunaway = vi.spyOn(runawaySignal.signal, 'removeEventListener')
    const explored = await explore((schedule) => {
      const lane = { label: 'forever' }
      const again = (): void => { schedule.later(lane, again) }
      again()
      void schedule.clock.sleep(100, { signal: runawaySignal.signal }).catch(() => {})
      return () => {}
    })
    expect(String(explored.failure?.error)).toMatch(/Still going after 10000 things/)
    expect(explored.failure?.taken).toHaveLength(10_000)
    expect(removeRunaway).toHaveBeenCalledWith('abort', expect.any(Function))

    // Throwing inside a scenario task before a sleep fires still detaches the sleep's abort listener.
    const throwSignal = new AbortController()
    const removeThrow = vi.spyOn(throwSignal.signal, 'removeEventListener')
    let sleepResolved = false
    const failed = await explore((schedule) => {
      schedule.does('boom', ['throw', () => { throw new Error('mid-run') }])
      void schedule.clock.sleep(100, { signal: throwSignal.signal }).then(() => { sleepResolved = true }, () => {})
      return () => {}
    })
    expect(String(failed.failure?.error)).toMatch(/mid-run/)
    expect(sleepResolved).toBe(false)
    expect(removeThrow).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('runs concurrent explorations without interfering with one another', async () => {
    const first: string[] = []
    const second: string[] = []
    const results = await Promise.all([everyOrder(twoByTwo(first)), everyOrder(twoByTwo(second))])
    expect(results).toEqual([6, 6])
    expect(new Set(first).size).toBe(6)
    expect(new Set(second).size).toBe(6)
  })

  it('moves its clock in due order, preserves FIFO ties, treats negative delays as 0, and supports cancellation and sleep', async () => {
    const orderings = await everyOrder((schedule) => {
      const clock: Clock = schedule.clock
      const ran: string[] = []
      const startMono = clock.monotonic()
      expect(startMono).toBe(0)
      const cancel = clock.after(50, () => { ran.push('cancelled') })
      const cancelAlreadyFired = clock.after(10, () => {
        ran.push(`first10@${clock.now()}`)
        // Cancelling an already-fired timer while later timers remain must not splice another timer out.
        cancelAlreadyFired()
      })
      clock.after(10, () => { ran.push(`second10@${clock.monotonic() - startMono}`) })
      clock.after(-5, () => { ran.push(`neg@${clock.now()}`) })
      clock.after(100, () => { ran.push(`t=${clock.now()}:${clock.monotonic() - startMono}`) })
      void clock.sleep(25).then(() => {
        ran.push(`sleep=${clock.now()}:${clock.monotonic() - startMono}`)
        // Double-cancelling while t=100 is still waiting must leave t=100 intact.
        cancel()
        cancel()
      })
      schedule.does('work', ['step', () => { ran.push('work') }])
      return () => {
        expect(ran).not.toContain('cancelled')
        expect(ran.indexOf('neg@0')).toBeLessThan(ran.indexOf('first10@10'))
        expect(ran.indexOf('first10@10')).toBeLessThan(ran.indexOf('second10@10'))
        expect(ran.indexOf('second10@10')).toBeLessThan(ran.indexOf('sleep=25:25'))
        expect(ran.indexOf('sleep=25:25')).toBeLessThan(ran.indexOf('t=100:100'))
        expect(ran).toContain('work')
      }
    })
    expect(orderings).toBe(6)

    // Clock entries record their due timestamp in `taken` for failure diagnostics.
    const traced = await replay((schedule) => {
      schedule.clock.after(25, () => {})
      return () => {}
    }, [])
    expect(traced.taken).toEqual(['the clock: 25 ms'])
  })

  it('rejects non-finite and overflowing waits on clock.after() and clock.sleep()', async () => {
    await everyOrder((schedule) => {
      const { clock } = schedule
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(() => clock.after(bad, () => {})).toThrow(RangeError)
      }
      expect(() => clock.after(Number.NaN, () => {})).toThrow(/given NaN/)

      // Overflowing `time + ms` throws RangeError on after() and rejects sleep().
      let overflowAfter = false
      let overflowSleep: unknown
      clock.after(Number.MAX_VALUE, () => {
        try { clock.after(Number.MAX_VALUE, () => {}) } catch (error) { overflowAfter = error instanceof RangeError && /overflows/.test(error.message) }
        void clock.sleep(Number.MAX_VALUE).catch((error) => { overflowSleep = error })
      })

      const errors: unknown[] = []
      void clock.sleep(Number.NaN).catch((error) => { errors.push(error) })
      const already = new AbortController()
      already.abort(new Error('already'))
      // Non-finite validation runs before the already-aborted check, matching @apackdev/clock.
      void clock.sleep(Number.NaN, { signal: already.signal }).catch((error) => { errors.push(error) })

      return () => {
        expect(overflowAfter).toBe(true)
        expect(overflowSleep).toBeInstanceOf(RangeError)
        expect(errors).toHaveLength(2)
        for (const error of errors) expect(error).toBeInstanceOf(RangeError)
      }
    })
  })

  it('supports AbortSignal cancellation with listener cleanup on clock.sleep()', async () => {
    let sawMidWoke = false
    let sawMidAborted = false
    await everyOrder((schedule) => {
      const { clock } = schedule

      const already = new AbortController()
      const alreadyReason = new Error('already')
      already.abort(alreadyReason)
      let alreadyCaught: unknown
      void clock.sleep(50, { signal: already.signal }).catch((error) => { alreadyCaught = error })

      const normal = new AbortController()
      const removeNormal = vi.spyOn(normal.signal, 'removeEventListener')
      let normalWoke = false
      void clock.sleep(10, { signal: normal.signal }).then(() => { normalWoke = true })

      const mid = new AbortController()
      const removeMid = vi.spyOn(mid.signal, 'removeEventListener')
      const midReason = new Error('cancelled mid-sleep')
      let midCaught: unknown
      let woke = false
      void clock.sleep(100, { signal: mid.signal }).then(() => { woke = true }, (error) => { midCaught = error })
      schedule.does('canceller', ['abort', () => { mid.abort(midReason) }])

      return () => {
        expect(alreadyCaught).toBe(alreadyReason)
        expect(normalWoke).toBe(true)
        expect(removeNormal).toHaveBeenCalledWith('abort', expect.any(Function))
        expect(removeMid).toHaveBeenCalledWith('abort', expect.any(Function))
        // Depending on ordering, either the abort ran before t=100 (cancelled) or t=100 ran before abort (woke).
        expect(woke || midCaught === midReason).toBe(true)
        expect(woke && midCaught === midReason).toBe(false)
        if (woke) sawMidWoke = true
        if (midCaught === midReason) sawMidAborted = true
      }
    })
    expect(sawMidWoke).toBe(true)
    expect(sawMidAborted).toBe(true)
  })

  it.skipIf(typeof (globalThis as { readonly window?: unknown }).window !== 'undefined')('lazily creates one MessageChannel and refs/unrefs it around active runs (and works without ref/unref)', async () => {
    const RealMessageChannel = MessageChannel
    let created = 0
    let refs = 0
    let unrefs = 0
    let includeRef = true
    vi.stubGlobal('MessageChannel', class {
      port1: { onmessage: (() => void) | null; ref?: () => void; unref?: () => void }
      port2: InstanceType<typeof RealMessageChannel>['port2']
      constructor() {
        created++
        const real = new RealMessageChannel()
        const realPort1 = real.port1 as unknown as { onmessage: (() => void) | null; ref?: () => void; unref?: () => void }
        const wrapped: { onmessage: (() => void) | null; ref?: () => void; unref?: () => void } = {
          get onmessage() { return realPort1.onmessage },
          set onmessage(fn) { realPort1.onmessage = fn },
        }
        if (includeRef) {
          wrapped.ref = () => { refs++; realPort1.ref?.() }
          wrapped.unref = () => { unrefs++; realPort1.unref?.() }
        }
        this.port1 = wrapped
        this.port2 = real.port2
      }
    })

    vi.resetModules()
    const fresh = await import('../src/index.ts')
    // Importing alone must not allocate a MessageChannel.
    expect(created).toBe(0)

    await Promise.all([fresh.everyOrder(twoByTwo([])), fresh.everyOrder(twoByTwo([]))])
    expect(created).toBe(1)
    expect(refs).toBeGreaterThanOrEqual(1)
    expect(unrefs).toBe(refs)

    // Browser MessagePort lacks ref()/unref(): runs cleanly without them.
    includeRef = false
    vi.resetModules()
    const browserLike = await import('../src/index.ts')
    expect(await browserLike.everyOrder(twoByTwo([]))).toBe(6)
    expect(created).toBe(2)
  })
})

afterEach(() => { vi.unstubAllGlobals() })
