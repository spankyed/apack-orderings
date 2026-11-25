import { describe, expect, it } from 'vitest'

interface BrowserWorker {
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onerror: ((event: { readonly message?: string }) => void) | null
  terminate(): void
}
interface WorkerConstructor {
  new (url: URL, options?: { readonly type?: 'classic' | 'module' }): BrowserWorker
}

const GlobalWorker = (globalThis as unknown as { readonly Worker?: WorkerConstructor }).Worker

describe('in a dedicated Web Worker', () => {
  it.skipIf(typeof GlobalWorker !== 'function')('runs cleanly with no window and no document', async () => {
    const WorkerCtor = GlobalWorker!
    const worker = new WorkerCtor(new URL('./support/orderings-worker.ts', import.meta.url), { type: 'module' })
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.onmessage = (event) => { resolve(event.data as Record<string, unknown>) }
        worker.onerror = (event) => { reject(new Error(event.message ?? 'worker error')) }
      })
      expect(result).toEqual({
        ok: true,
        hasWindow: false,
        orderings: 12,
        uniqueSeen: 12,
        dporOrderings: 1,
        dporReduced: true,
        auditViolation: false,
        sampledOrderings: 5,
        replayedTaken: ['y: 1', 'x: 1'],
      })
    } finally {
      worker.terminate()
    }
  })
})
