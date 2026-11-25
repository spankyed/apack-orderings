import { describe, expect, it } from 'vitest'
import { everyOrder, explore, replay, sample, type Scenario, type Clock } from '../src/index.ts'

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
    const explored = await explore(twoByTwo(seen))
    expect(explored).toEqual({ orderings: 6, complete: true })
    expect(new Set(seen).size).toBe(6)
    for (const order of seen) {
      expect(order.indexOf('x1')).toBeLessThan(order.indexOf('x2'))
      expect(order.indexOf('y1')).toBeLessThan(order.indexOf('y2'))
    }
  })

  it('stops at the first order that fails, and runs exactly that one again from its choices', async () => {
    const explored = await explore(twoByTwo([], 'y1 x1 y2 x2'))
    expect(explored.complete).toBe(false)
    expect(explored.failure?.taken).toEqual(['y: 1', 'x: 1', 'y: 2', 'x: 2'])
    const seen: string[] = []
    const again = await replay(twoByTwo(seen, 'y1 x1 y2 x2'), explored.failure!.choices)
    expect(seen).toEqual(['y1 x1 y2 x2'])
    expect(again.error).toBeInstanceOf(Error)
    await expect(everyOrder(twoByTwo([], 'y1 x1 y2 x2'))).rejects.toThrow(/y: 1\n {2}x: 1\n {2}y: 2\n {2}x: 2/)
  })

  it('runs what one thing puts off after it, and lets promises settle between', async () => {
    const orderings = await everyOrder((schedule) => {
      const ran: string[] = []
      const lane = { label: 'put off' }
      void schedule.work('outside', 'done').then((value) => { ran.push(value); schedule.later(lane, () => { ran.push('after') }) })
      void schedule.breaks('broken', new Error('no')).catch(() => { ran.push('failed') })
      return () => {
        expect(ran).toContain('failed')
        expect(ran.indexOf('done')).toBeLessThan(ran.indexOf('after'))
      }
    })
    expect(orderings).toBe(3)
  })

  it('samples the same orders from the same seed', async () => {
    const first: string[] = []
    const second: string[] = []
    await sample(twoByTwo(first), { seed: 7, runs: 20 })
    await sample(twoByTwo(second), { seed: 7, runs: 20 })
    expect(first).toEqual(second)
    expect(new Set(first).size).toBeGreaterThan(1)
  })

  it('says so when a scenario never comes to rest, or has more orders than it was let run', async () => {
    const explored = await explore((schedule) => {
      const lane = { label: 'forever' }
      const again = (): void => { schedule.later(lane, again) }
      again()
      return () => {}
    })
    expect(String(explored.failure?.error)).toMatch(/never comes to rest/)
    await expect(everyOrder(twoByTwo([]), { limit: 3 })).rejects.toThrow(/too many/)
  })

  it('runs concurrent explorations without interfering with one another', async () => {
    const first: string[] = []
    const second: string[] = []
    const results = await Promise.all([everyOrder(twoByTwo(first)), everyOrder(twoByTwo(second))])
    expect(results).toEqual([6, 6])
    expect(new Set(first).size).toBe(6)
    expect(new Set(second).size).toBe(6)
  })

  it('moves its clock in due order, supports cancellation and sleep, and interleaves timers with other lanes', async () => {
    const orderings = await everyOrder((schedule) => {
      const clock: Clock = schedule.clock
      const ran: string[] = []
      const startMono = clock.monotonic()
      expect(startMono).toBe(0)
      const cancel = clock.after(50, () => { ran.push('cancelled') })
      clock.after(100, () => { ran.push(`t=${clock.now()}:${clock.monotonic() - startMono}`) })
      void clock.sleep(25).then(() => { ran.push(`sleep=${clock.now()}:${clock.monotonic() - startMono}`); cancel() })
      schedule.does('work', ['step', () => { ran.push('work') }])
      return () => {
        expect(ran).not.toContain('cancelled')
        expect(ran.indexOf('sleep=25:25')).toBeLessThan(ran.indexOf('t=100:100'))
        expect(ran).toContain('work')
      }
    })
    expect(orderings).toBe(3)
  })

  it('rejects non-finite waits and supports AbortSignal cancellation on clock.sleep()', async () => {
    await everyOrder((schedule) => {
      const { clock } = schedule
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(() => clock.after(bad, () => {})).toThrow(RangeError)
      }

      const errors: unknown[] = []
      void clock.sleep(Number.NaN).catch((error) => { errors.push(error) })

      const already = new AbortController()
      const alreadyReason = new Error('already')
      already.abort(alreadyReason)
      void clock.sleep(Number.NaN, { signal: already.signal }).catch((error) => { errors.push(error) })
      let alreadyCaught: unknown
      void clock.sleep(50, { signal: already.signal }).catch((error) => { alreadyCaught = error })

      const mid = new AbortController()
      const midReason = new Error('cancelled mid-sleep')
      let midCaught: unknown
      let woke = false
      void clock.sleep(100, { signal: mid.signal }).then(() => { woke = true }, (error) => { midCaught = error })
      schedule.does('canceller', ['abort', () => { mid.abort(midReason) }])

      return () => {
        expect(errors).toHaveLength(2)
        for (const error of errors) expect(error).toBeInstanceOf(RangeError)
        expect(alreadyCaught).toBe(alreadyReason)
        // Depending on ordering, either the abort ran before t=100 (cancelled) or t=100 ran before abort (woke).
        expect(woke || midCaught === midReason).toBe(true)
        expect(woke && midCaught === midReason).toBe(false)
      }
    })
  })
})
