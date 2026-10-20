// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cache-efficiency baseline and non-regression gate.
 *
 * `run-eval --track cache-efficiency` writes ratios and prompt sizes; this
 * module turns them into `bench-results/cache-baseline.json` and compares a
 * later run against it. Kept free of I/O so both the CLI
 * (`scripts/cache-baseline.ts`) and the `cache-regression-gate` eval can use
 * the same thresholds, and so the gate itself is unit-tested (including the
 * negative case: a baseline hand-edited downward must fail).
 */
import type { EvalResult } from './types'
import { cacheHitRatio, prefixTokens, totalInputTokens } from './eval-helpers'

/** Fail when the weighted cache-hit ratio drops more than this many points. */
export const CACHE_GATE_RATIO_DROP_POINTS = 5
/** Fail when turn 1's prompt grows more than this fraction over the baseline. */
export const CACHE_GATE_TURN_TOKEN_GROWTH = 0.10

/**
 * Phase-A floors per ratio test. Also the gate's own floor: a baseline whose
 * ratio sits BELOW the floor for that test cannot be a genuine measurement of a
 * working cache, so it is treated as an edited baseline rather than as a target
 * to aim at. Without this, lowering the numbers in the JSON would be the easiest
 * way to make the gate green.
 */
export const CACHE_RATIO_FLOORS: Record<string, number> = {
  'cache-warm-repeat': 0.5,
  'cache-multiturn-history': 0.6,
  'cache-tool-loop': 0.5,
  'cache-compaction-recovery': 0.5,
  'cache-subagent-fork': 0.4,
}

export interface CacheBaselineEntry {
  /** Cache-hit ratio of the run, 0..1. */
  ratio: number
  /** Prompt tokens (uncached + cache-read + cache-write) of turn 1. */
  turnTokens: number
  /** Estimated prompt tokens of the run (stable + dynamic + tool schema). */
  prefixTokens: number
  /** Turns the ratio was measured over. */
  turns: number
}

export interface CacheBaseline {
  model: string
  /** ISO date the baseline was recorded. */
  date: string
  perTest: Record<string, CacheBaselineEntry>
  notes?: string
}

export interface CacheGateRegression {
  test: string
  /** `baselineFloor` = the baseline itself is below the documented floor. */
  metric: 'ratio' | 'turnTokens' | 'baselineFloor'
  baseline: number
  current: number
  /** current - baseline, in the metric's own units (ratio is 0..1). */
  delta: number
}

export interface CacheGateResult {
  ok: boolean
  regressions: CacheGateRegression[]
  checked: number
  /** Set when no comparison was possible (no baseline yet, or no shared tests). */
  reason?: string
}

/** One eval result collapsed to the numbers the gate compares. */
export function cacheMetricsOf(result: EvalResult): CacheBaselineEntry {
  const turns = result.perTurnUsage ?? []
  const first = turns[0]
  return {
    ratio: cacheHitRatio(result.metrics.tokens),
    turnTokens: first ? totalInputTokens(first) : 0,
    prefixTokens: prefixTokens(result).total,
    turns: turns.length,
  }
}

/** Build a baseline from one suite run's results. */
export function computeCacheBaseline(model: string, results: EvalResult[], date = new Date().toISOString()): CacheBaseline {
  const perTest: Record<string, CacheBaselineEntry> = {}
  for (const result of results) {
    // Structural (no-LLM) tests have no tokens; they are gates on their own
    // criteria, not on a ratio.
    if ((result.perTurnUsage ?? []).length === 0) continue
    perTest[result.eval.id] = cacheMetricsOf(result)
  }
  return { model, date, perTest }
}

/**
 * Compare a run against the baseline. A missing baseline is not a failure —
 * the first run records one — but a baseline the run can't match is.
 */
export function compareCacheBaseline(
  current: Record<string, CacheBaselineEntry>,
  baseline: CacheBaseline | null,
): CacheGateResult {
  if (!baseline) return { ok: true, regressions: [], checked: 0, reason: 'no baseline recorded yet' }
  const shared = Object.keys(current).filter((id) => baseline.perTest[id])
  if (shared.length === 0) {
    return { ok: true, regressions: [], checked: 0, reason: 'baseline has no test in common with this run' }
  }
  const regressions: CacheGateRegression[] = []
  // Refuse to gate against a baseline that cannot be a real measurement: a
  // hand-edited baseline is the one way to make every later run look healthy.
  for (const id of shared) {
    const floor = CACHE_RATIO_FLOORS[id]
    if (floor === undefined) continue
    if (baseline.perTest[id].ratio + 1e-9 < floor) {
      regressions.push({
        test: id,
        metric: 'baselineFloor',
        baseline: floor,
        current: baseline.perTest[id].ratio,
        delta: baseline.perTest[id].ratio - floor,
      })
    }
  }
  for (const id of shared) {
    const was = baseline.perTest[id]
    const now = current[id]
    const ratioDropPoints = (was.ratio - now.ratio) * 100
    if (ratioDropPoints > CACHE_GATE_RATIO_DROP_POINTS) {
      regressions.push({ test: id, metric: 'ratio', baseline: was.ratio, current: now.ratio, delta: now.ratio - was.ratio })
    }
    if (was.turnTokens > 0) {
      const growth = (now.turnTokens - was.turnTokens) / was.turnTokens
      if (growth > CACHE_GATE_TURN_TOKEN_GROWTH) {
        regressions.push({ test: id, metric: 'turnTokens', baseline: was.turnTokens, current: now.turnTokens, delta: now.turnTokens - was.turnTokens })
      }
    }
  }
  return { ok: regressions.length === 0, regressions, checked: shared.length }
}

/** Human-readable one-liner per regression, for eval criteria and CLI output. */
export function describeRegression(r: CacheGateRegression): string {
  if (r.metric === 'baselineFloor') {
    return `${r.test}: baseline ratio ${(r.current * 100).toFixed(1)}% is below the ${(r.baseline * 100).toFixed(1)}% floor — refusing to gate against an edited baseline`
  }
  if (r.metric === 'ratio') {
    return `${r.test}: cache-hit ratio ${(r.baseline * 100).toFixed(1)}% → ${(r.current * 100).toFixed(1)}% (${(r.delta * 100).toFixed(1)} pts)`
  }
  return `${r.test}: turn-1 prompt ${r.baseline.toLocaleString()} → ${r.current.toLocaleString()} tokens (+${((r.delta / r.baseline) * 100).toFixed(1)}%)`
}
