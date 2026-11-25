// Optimal Dynamic Partial-Order Reduction (Abdulla et al., JACM 2017, Algorithm 2: Wakeup Trees).
//
// Operates on trace steps produced by `once()` without any state checkpointing. Each step records its canonical
// lane identity, which earlier step created it (`pushedBy`), whether it cancelled a previously-pending timer, and
// the opaque resource tokens it read or wrote (`StepAccess`). Untracked tasks set `global = true` and conflict with
// everything, keeping reduction sound by default.

/** Resource accesses observed while a step (and its settled microtasks) ran, keyed by canonical run-invariant IDs. */
export interface StepAccess {
  global: boolean
  readonly reads: Set<string>
  readonly writes: Set<string>
}

/** An executed step in a trace, with everything Optimal DPOR needs for race detection and wakeup trees. */
export interface TraceStep {
  readonly laneId: string
  readonly what: string
  readonly pushedBy: number
  readonly preemptedClock: boolean
  readonly access: StepAccess
  readonly readyLaneIds: readonly string[]
}

/** Lightweight reference to a step used inside wakeup sequences and sleep sets. */
export interface StepRef {
  readonly laneId: string
  readonly access: StepAccess
}

/** An ordered wakeup tree node: each edge carries a lane ID and its observed access set. */
export interface WutNode {
  readonly children: Array<{ readonly laneId: string; readonly access: StepAccess; readonly node: WutNode }>
}

export const GLOBAL_ACCESS: StepAccess = Object.freeze({
  global: true,
  reads: new Set<string>(),
  writes: new Set<string>(),
})

export const makeAccess = (tracked: boolean): StepAccess => ({
  global: !tracked,
  reads: new Set<string>(),
  writes: new Set<string>(),
})

/** Whether two steps' resource accesses conflict (`global`, `W/W`, or `R/W`). Symmetric. */
export const conflicts = (a: StepAccess, b: StepAccess): boolean => {
  if (a.global || b.global) return true
  for (const resource of a.writes) if (b.writes.has(resource) || b.reads.has(resource)) return true
  for (const resource of b.writes) if (a.reads.has(resource)) return true
  return false
}

export const makeWutNode = (): WutNode => ({ children: [] })

/**
 * Checks whether a single step `head` occurs in `rem` and commutes past every step before it. Returns the remaining
 * sequence with `head` removed if subsumed, or `undefined` otherwise.
 */
const stepSubsumes = (head: StepRef, rem: readonly StepRef[]): readonly StepRef[] | undefined => {
  const index = rem.findIndex((other) => other.laneId === head.laneId)
  if (index < 0) return undefined
  for (let k = 0; k < index; k++) if (conflicts(head.access, rem[k]!.access)) return undefined
  return [...rem.slice(0, index), ...rem.slice(index + 1)]
}

/** Whether any branch in `node` weakly covers `rem` (either a leaf is a weak prefix of `rem`, or `rem` is fully matched). */
const hasCoveringLeaf = (node: WutNode, rem: readonly StepRef[]): boolean => {
  if (!node.children.length || !rem.length) return true
  for (const child of node.children) {
    const next = stepSubsumes(child, rem)
    if (next !== undefined && hasCoveringLeaf(child.node, next)) return true
  }
  return false
}

/**
 * Inserts wakeup sequence `seq` into wakeup tree `root` unless already covered by `sleep` or by an existing leaf
 * of `root` (Abdulla et al. 2017, Algorithm 2 `insert`).
 */
export const insertWut = (root: WutNode, sleep: ReadonlyMap<string, StepAccess>, seq: readonly StepRef[]): void => {
  for (const [laneId, access] of sleep) {
    if (stepSubsumes({ laneId, access }, seq) !== undefined) return
  }
  if (hasCoveringLeaf(root, seq)) return
  let node = root
  let rem: readonly StepRef[] = seq
  for (;;) {
    let matched = false
    for (const child of node.children) {
      const next = stepSubsumes(child, rem)
      if (next !== undefined) {
        node = child.node
        rem = next
        matched = true
        break
      }
    }
    if (!matched) break
  }
  for (const step of rem) {
    const nextNode = makeWutNode()
    node.children.push({ laneId: step.laneId, access: step.access, node: nextNode })
    node = nextNode
  }
}

/**
 * Computes all reversible immediate races (and clock preemption/cancellation points) along `steps` in a single
 * reverse-topological bitset sweep, returning `{ depth, seq }` entries to insert into each depth's wakeup tree.
 */
export const findWakeups = (steps: readonly TraceStep[]): Array<{ readonly depth: number; readonly seq: readonly StepRef[] }> => {
  const n = steps.length
  const words = (n + 31) >>> 5
  const hb: Uint32Array[] = Array.from({ length: n }, () => new Uint32Array(words))
  const found: Array<{ readonly depth: number; readonly seq: readonly StepRef[] }> = []

  // Disabling / preemption: if step `i` cancelled or preempted a previously-pending timer, allow `clock` to run first.
  for (let i = 0; i < n; i++) {
    if (steps[i]!.preemptedClock) {
      found.push({ depth: i, seq: [{ laneId: 'clock', access: GLOBAL_ACCESS }] })
    }
  }

  // Reverse topological sweep: when processing `i`, every `hb[j]` for `j > i` is already transitively closed.
  // Before visiting `j`, bit `j` is set in `hb[i]` iff some intermediate `k` (`i < k < j`) satisfies `i hb k hb j`.
  // Stryker disable next-line ArithmeticOperator: for i >= n - 1, inner loop j = i + 1 < n runs 0 times.
  for (let i = n - 1; i >= 0; i--) {
    const stepI = steps[i]!
    const rowI = hb[i]!
    for (let j = i + 1; j < n; j++) {
      const stepJ = steps[j]!
      const sameLane = stepI.laneId === stepJ.laneId
      const created = stepJ.pushedBy === i
      if (!sameLane && !created && !conflicts(stepI.access, stepJ.access)) continue
      if ((rowI[j >>> 5]! & (1 << (j & 31))) !== 0) continue
      if (!sameLane && !created) {
        const seq: StepRef[] = []
        for (let k = i + 1; k < j; k++) {
          if ((rowI[k >>> 5]! & (1 << (k & 31))) === 0) {
            seq.push({ laneId: steps[k]!.laneId, access: steps[k]!.access })
          }
        }
        seq.push({ laneId: stepJ.laneId, access: stepJ.access })
        found.push({ depth: i, seq })
      }
      rowI[j >>> 5]! |= 1 << (j & 31)
      const rowJ = hb[j]!
      // Stryker disable next-line EqualityOperator: at w === words, rowJ[words] is undefined and Uint32Array ignores out-of-bounds writes.
      for (let w = 0; w < words; w++) rowI[w]! |= rowJ[w]!
    }
  }

  return found
}
