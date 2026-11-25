// Runs inside a real browser DedicatedWorkerGlobalScope (no window, no document, no setImmediate).
import { auditIndependence, everyOrder, explore, replay, sample } from '../../src/index.ts'

const workerScope = globalThis as unknown as {
  readonly window?: unknown
  postMessage(message: unknown): void
}

const run = async (): Promise<void> => {
  try {
    const seen: string[] = []
    const orderings = await everyOrder((schedule) => {
      const ran: string[] = []
      schedule.does('a', ['1', () => { ran.push('a1') }], ['2', () => { ran.push('a2') }])
      schedule.does('b', ['1', () => { ran.push('b1') }])
      void schedule.clock.sleep(10).then(() => { ran.push(`t=${schedule.clock.monotonic()}`) })
      return () => { seen.push(ran.join(',')) }
    })

    const dporScenario = (schedule: Parameters<Parameters<typeof explore>[0]>[0]) => {
      const a = schedule.resource('a')
      const b = schedule.resource('b')
      schedule.later({ label: 'a' }, () => { schedule.write(a) }, { tracked: true })
      schedule.later({ label: 'b' }, () => { schedule.write(b) }, { tracked: true })
      return () => {}
    }
    const reduced = await explore(dporScenario)
    const audited = await auditIndependence(dporScenario, { seed: 1, runs: 5, swaps: 10 })

    const sampled = await sample((schedule) => {
      schedule.does('x', ['1', () => {}])
      schedule.does('y', ['1', () => {}])
      return () => {}
    }, { seed: 42, runs: 5 })

    const replayed = await replay((schedule) => {
      schedule.does('x', ['1', () => {}])
      schedule.does('y', ['1', () => {}])
      return () => {}
    }, [1])

    workerScope.postMessage({
      ok: true,
      hasWindow: typeof workerScope.window !== 'undefined',
      orderings,
      uniqueSeen: new Set(seen).size,
      dporOrderings: reduced.orderings,
      dporReduced: reduced.reduced === true,
      auditViolation: audited.violation !== undefined,
      sampledOrderings: sampled.orderings,
      replayedTaken: replayed.taken,
    })
  } catch (error) {
    workerScope.postMessage({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) })
  }
}

void run()
