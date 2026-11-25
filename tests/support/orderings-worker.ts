// Runs inside a real browser DedicatedWorkerGlobalScope (no window, no document, no setImmediate).
import { everyOrder, replay, sample } from '../../src/index.ts'

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
      sampledOrderings: sampled.orderings,
      replayedTaken: replayed.taken,
    })
  } catch (error) {
    workerScope.postMessage({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) })
  }
}

void run()
