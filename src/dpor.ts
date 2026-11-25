// Optimal Dynamic Partial-Order Reduction (Abdulla et al., JACM 2017, Algorithm 2: Wakeup Trees).
//
// Operates on trace steps produced by `once()` without any state checkpointing. Each step records its canonical
// lane identity, which earlier step created it (`pushedBy`), whether it cancelled or preempted a previously-pending
// timer, and the opaque resource tokens it read or wrote (`StepAccess`). Untracked tasks set `global = true` and
// conflict with everything, keeping reduction sound by default.

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
const stepSubsumes = (
  head: StepRef,
  rem: readonly StepRef[],
): { readonly next: readonly StepRef[]; readonly target: StepAccess } | undefined => {
  const index = rem.findIndex((other) => other.laneId === head.laneId)
  if (index < 0) return undefined
  const target = rem[index]!.access
  for (let k = 0; k < index; k++) {
    if (conflicts(head.access, rem[k]!.access) || conflicts(target, rem[k]!.access)) return undefined
  }
  return { next: [...rem.slice(0, index), ...rem.slice(index + 1)], target }
}

/**
 * Whether any branch in `node` weakly covers `rem`: either `rem` is fully matched, or a leaf is a weak prefix of
 * `rem` that already wakes every sleeper / left-sibling in `mustWake` that `rem` itself would wake.
 */
const hasCoveringLeaf = (
  node: WutNode,
  rem: readonly StepRef[],
  mustWake: readonly StepAccess[],
): boolean => {
  if (!rem.length) return true
  if (!node.children.length) return mustWake.every((acc) => !rem.some((step) => conflicts(acc, step.access)))
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    const hit = stepSubsumes(child, rem)
    if (!hit) continue
    const wakes = (acc: StepAccess): boolean => conflicts(acc, child.access) && conflicts(acc, hit.target)
    const nextMustWake = mustWake.filter((acc) => !wakes(acc))
    for (let left = 0; left < i; left++) {
      const leftAcc = node.children[left]!.access
      if (!wakes(leftAcc)) nextMustWake.push(leftAcc)
    }
    if (hasCoveringLeaf(child.node, hit.next, nextMustWake)) return true
  }
  return false
}

/**
 * Inserts wakeup sequence `seq` into wakeup tree `root` unless already covered by `sleep` or by an existing leaf
 * of `root` (Abdulla et al. 2017, Algorithm 2 `insert`).
 */
export const insertWut = (root: WutNode, sleep: ReadonlyMap<string, StepAccess>, seq: readonly StepRef[]): void => {
  for (const [laneId, access] of sleep) {
    if (stepSubsumes({ laneId, access }, seq)) return
  }
  if (hasCoveringLeaf(root, seq, [...sleep.values()])) return
  let node = root
  let rem: readonly StepRef[] = seq
  for (;;) {
    let matched = false
    for (const child of node.children) {
      const hit = stepSubsumes(child, rem)
      if (hit) {
        node = child.node
        rem = hit.next
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

/** A wakeup sequence to insert into the wakeup tree at `depth`. */
export interface Wakeup {
  readonly depth: number
  readonly seq: readonly StepRef[]
}

/**
 * Computes all reversible immediate races (and clock cancellation/preemption points) along `steps` in a single
 * reverse-topological bitset sweep, returning `Wakeup` entries to insert into each depth's wakeup tree.
 */
export const findWakeups = (steps: readonly TraceStep[]): Wakeup[] => {
  const n = steps.length
  const words = (n + 31) >>> 5
  const hb: Uint32Array[] = Array.from({ length: n }, () => new Uint32Array(words))
  const found: Wakeup[] = []

  // Reverse topological sweep: when processing `i`, every `hb[j]` for `j > i` is already transitively closed.
  // Before visiting `j`, bit `j` is set in `hb[i]` iff some intermediate `k` (`i < k < j`) satisfies `i hb k hb j`.
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
    // Disabling / preemption: timer operations are globally conflicting, so `clock` can never persist in `sleep`
    // across a step; emitting a single `['clock']` wakeup suffices when `i` cancels or preempts a pending timer.
    if (stepI.preemptedClock) {
      found.push({ depth: i, seq: [{ laneId: 'clock', access: GLOBAL_ACCESS }] })
    }
  }

  return found
}
