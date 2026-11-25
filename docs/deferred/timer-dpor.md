# Deferred Plan: Per-Timer Reduction under Wakeup-Tree DPOR

**Status:** Deferred (do not start unless measured consumer need justifies the complexity).

## Current behavior

In `src/index.ts` and `src/dpor.ts`, timer scheduling (`clock.after`, `clock.sleep`), cancellation (`cancel()`, `AbortSignal` abort), and timer firing (`'clock'` lane) are marked globally conflicting (`global = true`), with a single O(1) `preemptedClock` wakeup (`['clock']`) when a step cancels or preempts a previously pending timer.

All non-timer tracked lanes (`later`, `does`, `work`, `breaks`, dynamic/shared lanes, `resource`/`read`/`write`, and pure `clock.now()`/`monotonic()` reads between timers) receive full wakeup-tree DPOR reduction.

## Trigger: when to revisit

Only pick up this plan if real measurements on **`apack-link`** or **`apack-state`** show a check that:

1. Still hits `explore`'s `limit` (or remains `sample()`-only) after wiring tracked non-timer lanes, **and**
2. Does so specifically because of concurrent timer interleavings (verified by comparing ordering counts with timers mocked/removed vs active).

If `apack-link` and `apack-state` checks already run exhaustively and fast with globally conflicting timers, **keep this deferred permanently**. `apack-orderings` is the shared test oracle across multiple repositories; a smaller, simpler, provably sound engine beats extra reduction we do not need.

## Why patching the shared `'clock'` lane does not converge

PR #5 and early PR #6 attempted to reduce timer interleavings while keeping all timers in one due-sorted `'clock'` lane. Independent nested differential fuzzing exposed three distinct failures from two root causes:

1. **Unstable lane head & disabling transitions (Scenarios A & B in `tests/dpor.spec.ts`):**
   - Textbook wakeup-tree DPOR (Abdulla et al., JACM 2017) assumes each lane's next step is fixed by that lane alone and no lane can disable another.
   - Because all timers share `'clock'`, another lane can change `'clock'`'s next step (preempting with an earlier timer or reordering ties) or remove it entirely (`cancel()` / `abort()`).
   - Even with *no* cancels or aborts (Scenario B), reordering two `clock.after(0)`/`clock.sleep(0)` pushes changes which timer fires first on `'clock'`, invalidating sleep-set and `sameLane` happens-before assumptions.
   - Patching individual symptoms (such as emitting suffix prefixes when `'clock'` is in `sleep`) fails to converge and introduces quadratic/cubic wakeup overhead on cancel-heavy traces (such as `apack-state` cancelling sleeps on state exit).

2. **Firing-order-dependent canonical identity (Scenario C in `tests/dpor.spec.ts`):**
   - Tasks and resources spawned inside timer callbacks received IDs like `clock.${laneSeq}:0` ("spawned by the *k*-th timer to fire").
   - Cancelling or reordering an earlier timer shifts `laneSeq` and renames lanes spawned by later timers, causing false `Unsound tracked task: expected lane "clock.0:0" to be enabled` replay errors on soundly tracked scenarios.

## What a sound design requires

If real measurements trigger this work, do not patch `'clock'` again. Replace the timer model cleanly:

1. **Per-timer stable canonical identity:**
   - Assign each scheduled timer a creation-site ID invariant across commuting reorderings: `timer:${creatorLaneId}.${creatorLaneSeq}:${creatorTimerIdx}` (or `timer:0:${setupIdx}` during setup).
   - Use that timer's own ID as its lane identity and as the prefix for any lanes/resources/timers spawned inside its callback (`${timerId}:...`), eliminating firing-order renaming (`clock.0:0`).

2. **Explicit clock conflict relations:**
   - `clock.now()` / `clock.monotonic()` read `sys:clock`; firing a timer that advances `time` writes `sys:clock`.
   - `clock.after` / `clock.sleep` read `sys:clock` and conflict with any pending timer due at or after the new deadline (preemption and FIFO tie ordering).
   - `cancel()` / `AbortSignal` abort conflicts with firing its target timer (including passive tracking after `sleep()` resolves if an abort can still race against resolution).

3. **Sound handling of disabling and due-time priority gating (the hard part):**
   - Even with per-timer IDs, two non-textbook constraints remain:
     - **Cancellation** is a disabling transition (lane `c` removes enabled timer `T` from `ready`).
     - **Due-time priority** (*"timer `T2` is blocked while an earlier `T1` is pending"*) dynamically gates enablement of `T2` on `T1` firing or being cancelled.
   - Choose and prove one formal strategy before implementing:
     - **Option A — Hybrid (lowest risk):** Give timers per-timer identities so independent timers and non-timer lanes commute, while keeping *disabling/preempting* operations (`cancel()`, `abort()`, or `after()` inserting ahead of an existing timer) globally conflicting so no disabling transition ever enters `notdep` or `sleep`.
     - **Option B — Full disabling/priority-aware DPOR:** Model timer enablement guards explicitly in race detection and wakeup-tree insertion (e.g., treating a timer's enabling/disabling set as a first-class relation rather than a single `'clock'` lane) and prove completeness for the full fragment.

## Verification gates before shipping

Any future PR implementing timer-level DPOR must pass all of the following:

- **Differential fuzzing:** ≥50,000 randomized 2-level nested programs across `mixed`, `all`, `timers`, and a dedicated nested-cancel/preemption stress profile with zero state mismatches, zero false replay throws, and `dpor.orderings <= full.orderings`.
- **Small-scope exhaustive enumeration:** Enumerate every small program (all combinations up to bounded size) that sets, preempts, reads, and cancels timers and assert exact reachable-state equality against `explore(..., { reduce: false })`.
- **Consumer verification:** Measure real ordering counts and wall time on `apack-link` and `apack-state` (confirming meaningful reduction and no wakeup blowup on cancel-heavy traces) with `auditIndependence()` passing.
- **Repository gates:** 100.00% Stryker mutation score (`npm run mutants`), Node + Chromium/Firefox/WebKit + Web Worker parity, TS 5.7 floor (`typecheck:floor` + `package:smoke`), and `package:check` size ceilings.
