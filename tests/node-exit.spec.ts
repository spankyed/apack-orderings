import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const entryUrl = new URL('../src/index.ts', import.meta.url).href

const runNode = (code: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly signal: NodeJS.Signals | null } => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    signal: result.signal,
  }
}

describe('Node process exit lifecycle', () => {
  it('exits cleanly when imported without running a scenario', () => {
    const result = runNode(`
      await import(${JSON.stringify(entryUrl)})
      console.log('imported')
    `)
    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('imported')
  })

  it('exits cleanly once a scenario finishes instead of hanging on MessageChannel', () => {
    const result = runNode(`
      import { everyOrder } from ${JSON.stringify(entryUrl)}
      const count = await everyOrder((schedule) => {
        schedule.does('a', ['1', () => {}])
        schedule.does('b', ['1', () => {}])
        return () => {}
      })
      console.log('ran:' + count)
    `)
    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('ran:2')
  })

  it('completes a second sequential run after becoming idle and then exits cleanly', () => {
    const result = runNode(`
      import { everyOrder } from ${JSON.stringify(entryUrl)}
      const first = await everyOrder((schedule) => {
        schedule.does('a', ['1', () => {}])
        return () => {}
      })
      const second = await everyOrder((schedule) => {
        schedule.does('x', ['1', () => {}], ['2', () => {}])
        schedule.does('y', ['1', () => {}], ['2', () => {}])
        return () => {}
      })
      console.log(first + ',' + second)
    `)
    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('1,6')
  })

  it('keeps the process alive until all concurrent runs finish and then exits cleanly', () => {
    const result = runNode(`
      import { everyOrder } from ${JSON.stringify(entryUrl)}
      const shortRun = everyOrder((schedule) => {
        schedule.does('short', ['1', () => {}])
        return () => {}
      })
      const longRun = everyOrder((schedule) => {
        schedule.does('a', ['1', () => {}], ['2', () => {}], ['3', () => {}])
        schedule.does('b', ['1', () => {}], ['2', () => {}], ['3', () => {}])
        return () => {}
      })
      const [a, b] = await Promise.all([shortRun, longRun])
      console.log(a + ',' + b)
    `)
    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('1,20')
  })
})
