// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cache-efficiency accounting + non-regression gate (SHO-82).
 *
 * These run without a model: the numbers are the shape `data-usage` reports,
 * so the maths — ratio, per-call roll-up, gate thresholds — is pinned here and
 * the eval suite only has to prove the runtime produces those fields.
 */
import { describe, test, expect } from 'bun:test'
import type { EvalResult, PerCallUsage, TurnUsage } from './types'
import {
  cacheHitRatio,
  finalTurnCacheRatio,
  forkCacheRatio,
  prefixTokens,
  runCacheRatio,
  stablePrefixHeld,
  toolBlockHeld,
  toolLoopRewrite,
  totalInputTokens,
  turnCacheRatio,
} from './eval-helpers'
import {
  CACHE_GATE_RATIO_DROP_POINTS,
  CACHE_GATE_TURN_TOKEN_GROWTH,
  compareCacheBaseline,
  computeCacheBaseline,
  describeRegression,
  type CacheBaseline,
  type CacheBaselineEntry,
} from './cache-baseline'

function turn(
  n: number,
  u: Partial<Pick<TurnUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'iterations'>>,
  prefix?: TurnUsage['prefix'],
  perCallUsage: PerCallUsage[] = [],
): TurnUsage {
  return {
    turn: n,
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    iterations: u.iterations ?? 1,
    prefix,
    perCallUsage,
  }
}

function prefix(stableHash: string, dynamicHash = 'd1', toolsHash = 't1'): NonNullable<TurnUsage['prefix']> {
  return {
    turn: 1,
    stableHash,
    dynamicHash,
    toolsHash,
    historyHash: 'h1',
    stableChars: 40_000,
    dynamicChars: 8_000,
    toolCount: 32,
    messageCount: 2,
  }
}

function result(over: Partial<EvalResult> = {}): EvalResult {
  const perTurnUsage = over.perTurnUsage ?? []
  const tokens = over.metrics?.tokens ?? {
    input: perTurnUsage.reduce((s, t) => s + t.input, 0),
    output: perTurnUsage.reduce((s, t) => s + t.output, 0),
    cacheRead: perTurnUsage.reduce((s, t) => s + t.cacheRead, 0),
    cacheWrite: perTurnUsage.reduce((s, t) => s + t.cacheWrite, 0),
    total: 0,
  }
  return {
    eval: { id: (over.eval as any)?.id ?? 'test', category: 'cache-efficiency' } as any,
    passed: true,
    score: 100,
    maxScore: 100,
    percentage: 100,
    responseText: '',
    allResponseText: '',
    toolCalls: [],
    finalTurnToolCalls: [],
    perTurnToolCalls: [],
    criteriaResults: [],
    triggeredAntiPatterns: [],
    timing: { startTime: 0, endTime: 0, durationMs: 0 },
    metrics: { toolCallCount: 0, successfulToolCalls: 0, failedToolCalls: 0, iterations: 1, tokens, timing: { totalMs: 0 } },
    perTurnUsage,
    perCallUsage: perTurnUsage.flatMap((t) => t.perCallUsage),
    ...over,
  }
}

describe('cache accounting helpers', () => {
  test('ratio is cacheRead / (uncached + read + write)', () => {
    const u = { input: 1_000, cacheRead: 9_000, cacheWrite: 0 }
    expect(totalInputTokens(u)).toBe(10_000)
    expect(cacheHitRatio(u)).toBeCloseTo(0.9, 5)
    expect(cacheHitRatio({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0)
  })

  test('per-turn and run ratios come from the per-turn record, not one aggregate', () => {
    const r = result({
      perTurnUsage: [
        turn(1, { input: 10_000, cacheRead: 0, cacheWrite: 0 }),
        turn(2, { input: 1_000, cacheRead: 9_000 }),
      ],
    })
    expect(turnCacheRatio(r, 1)).toBe(0)
    expect(turnCacheRatio(r, 2)).toBeCloseTo(0.9, 5)
    expect(finalTurnCacheRatio(r)).toBeCloseTo(0.9, 5)
    expect(runCacheRatio(r)).toBeCloseTo(0.45, 5) // 9k of 20k prompt tokens
    expect(turnCacheRatio(r, 9)).toBeNull()
  })

  test('prefix tokens split by zone', () => {
    const r = result({
      promptBreakdown: {
        sections: [
          { label: 'guide', zone: 'stable', chars: 4_000, estTokens: 1_000 },
          { label: 'memory', zone: 'dynamic', chars: 400, estTokens: 100 },
        ],
        totalChars: 4_400,
        totalEstTokens: 1_100,
        toolSchemaChars: 4_000,
        toolSchemaEstTokens: 1_000,
        toolCount: 32,
        grandEstTokens: 2_100,
      },
    })
    const p = prefixTokens(r)
    expect(p).toEqual({ stable: 1_000, dynamic: 100, total: 2_100, stableShare: 1000 / 2100 })
  })

  test('stablePrefixHeld / toolBlockHeld need a stable hash on every turn', () => {
    const stable = result({
      perTurnUsage: [turn(1, {}, prefix('aaa')), turn(2, {}, prefix('aaa'))],
    })
    expect(stablePrefixHeld(stable, 2)).toBe(true)
    expect(toolBlockHeld(stable, 2)).toBe(true)

    const moved = result({
      perTurnUsage: [turn(1, {}, prefix('aaa')), turn(2, {}, prefix('bbb'))],
    })
    expect(stablePrefixHeld(moved, 2)).toBe(false)

    const single = result({ perTurnUsage: [turn(1, {}, prefix('aaa'))] })
    expect(stablePrefixHeld(single, 2)).toBe(false)
  })

  test('toolLoopRewrite compares write vs read after the first call', () => {
    const r = result({
      perTurnUsage: [
        turn(1, {}, undefined, [
          { iteration: 1, input: 0, output: 10, cacheRead: 0, cacheWrite: 10_000 },
          { iteration: 2, input: 100, output: 10, cacheRead: 9_900, cacheWrite: 200 },
          { iteration: 3, input: 100, output: 10, cacheRead: 10_100, cacheWrite: 200 },
        ]),
      ],
    })
    const loop = toolLoopRewrite(r)
    expect(loop.calls).toBe(3)
    expect(loop.medianWrite).toBe(200)
    expect(loop.medianRead).toBe(10_000)
    expect(loop.ratio).toBeCloseTo(0.02, 5)
  })

  test('forkCacheRatio refuses to guess when no fork reported usage', () => {
    expect(forkCacheRatio(result())).toBeNull()
    const forked = result({
      subagentUsage: [{ subagent: 'fork', input: 1_000, output: 50, cacheRead: 1_000, cacheWrite: 0 }],
    })
    expect(forkCacheRatio(forked)).toBeCloseTo(0.5, 5)
  })
})

describe('cache baseline + gate', () => {
  const perTestOf = (ratio: number, turnTokens = 12_000): Record<string, CacheBaselineEntry> => ({
    'cache-warm-repeat': { ratio, turnTokens, prefixTokens: 10_000, turns: 2 },
  })

  const baselineOf = (ratio: number, turnTokens = 12_000): CacheBaseline => ({
    model: 'hoshi-2-0',
    date: '2026-10-20T00:00:00.000Z',
    perTest: perTestOf(ratio, turnTokens),
  })

  test('the gate thresholds are the documented ones', () => {
    expect(CACHE_GATE_RATIO_DROP_POINTS).toBe(5)
    expect(CACHE_GATE_TURN_TOKEN_GROWTH).toBe(0.1)
  })

  test('no baseline is recorded yet — not a failure', () => {
    const gate = compareCacheBaseline(perTestOf(0.6), null)
    expect(gate.ok).toBe(true)
    expect(gate.checked).toBe(0)
    expect(gate.reason).toBeTruthy()
  })

  test('an unchanged run passes', () => {
    const gate = compareCacheBaseline(perTestOf(0.6), baselineOf(0.6))
    expect(gate.ok).toBe(true)
    expect(gate.checked).toBe(1)
  })

  test('a 4-point drop passes, a 6-point drop fails', () => {
    expect(compareCacheBaseline(perTestOf(0.56), baselineOf(0.6)).ok).toBe(true)
    const gate = compareCacheBaseline(perTestOf(0.54), baselineOf(0.6))
    expect(gate.ok).toBe(false)
    expect(gate.regressions[0].metric).toBe('ratio')
    expect(describeRegression(gate.regressions[0])).toContain('cache-warm-repeat')
  })

  test('a 15% bigger turn-1 prompt fails, 5% does not', () => {
    expect(compareCacheBaseline(perTestOf(0.6, 12_600), baselineOf(0.6, 12_000)).ok).toBe(true)
    const gate = compareCacheBaseline(perTestOf(0.6, 13_800), baselineOf(0.6, 12_000))
    expect(gate.ok).toBe(false)
    expect(gate.regressions[0].metric).toBe('turnTokens')
  })

  // The negative test the card asks for: a baseline edited DOWN by hand must
  // fail, because the gate refuses to measure against a number below the floor.
  test('a baseline hand-edited downward fails an unchanged run', () => {
    const honest = baselineOf(0.8)
    const handEdited: CacheBaseline = {
      ...honest,
      perTest: { 'cache-warm-repeat': { ...honest.perTest['cache-warm-repeat'], ratio: 0.3 } },
    }
    const current = perTestOf(0.8)
    expect(compareCacheBaseline(current, honest).ok).toBe(true)
    const gate = compareCacheBaseline(current, handEdited)
    expect(gate.ok).toBe(false)
    expect(gate.regressions[0].metric).toBe('baselineFloor')
    expect(describeRegression(gate.regressions[0])).toContain('floor')
  })

  test('computeCacheBaseline records only tests that spent tokens', () => {
    const withTokens = result({ eval: { id: 'cache-warm-repeat' } as any, perTurnUsage: [turn(1, { input: 100, cacheRead: 900 })] })
    const structural = result({ eval: { id: 'cache-stable-zone-identical' } as any, perTurnUsage: [] })
    const baseline = computeCacheBaseline('hoshi-2-0', [withTokens, structural])
    expect(Object.keys(baseline.perTest)).toEqual(['cache-warm-repeat'])
    expect(baseline.perTest['cache-warm-repeat'].ratio).toBeCloseTo(0.9, 5)
    expect(baseline.perTest['cache-warm-repeat'].turnTokens).toBe(1_000)
  })
})
