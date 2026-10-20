// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cache-efficiency baseline: record it, or gate a later run against it.
 *
 * Usage:
 *   bun scripts/cache-baseline.ts --write eval-a/results.json eval-b/results.json eval-c/results.json
 *   bun scripts/cache-baseline.ts --check eval-d/results.json
 *
 * Pass the `results.json` files written by
 * `run-eval.ts --track cache-efficiency --model hoshi-2-0` (one per `--repeat`).
 * With several files the baseline stores the MEDIAN of each test, which is what
 * DeepSeek's best-effort, async prefix cache needs — a single run can
 * under-report hits.
 *
 * `--check` fails (exit 1) when any test's cache-hit ratio drops more than 5
 * points, or its turn-1 prompt grows more than 10%, versus the checked-in
 * baseline at `packages/agent-runtime/src/evals/cache-baseline.json` (tracked,
 * unlike `bench-results/`, so CI can gate on it). Missing baseline = not a
 * failure; the first `--write` records it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { EvalResult, EvalSuiteResult } from '../packages/agent-runtime/src/evals/types'
import {
  CACHE_GATE_RATIO_DROP_POINTS,
  CACHE_GATE_TURN_TOKEN_GROWTH,
  compareCacheBaseline,
  computeCacheBaseline,
  describeRegression,
  type CacheBaseline,
  type CacheBaselineEntry,
} from '../packages/agent-runtime/src/evals/cache-baseline'
import { median } from '../packages/agent-runtime/src/evals/eval-helpers'

const ROOT = resolve(import.meta.dir, '..')
const DEFAULT_OUT = join(ROOT, 'packages/agent-runtime/src/evals/cache-baseline.json')

const args = process.argv.slice(2)
const write = args.includes('--write')
const check = args.includes('--check')
const outIdx = args.indexOf('--out')
const OUT = outIdx >= 0 && args[outIdx + 1] ? resolve(args[outIdx + 1]) : DEFAULT_OUT
const files = args.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1))

if (!write && !check) {
  console.error('Usage: bun scripts/cache-baseline.ts (--write | --check) <results.json...>')
  process.exit(2)
}
if (files.length === 0) {
  console.error('No results.json given.')
  process.exit(2)
}

const suites: EvalSuiteResult[] = []
for (const file of files) {
  const abs = resolve(file)
  if (!existsSync(abs)) {
    console.error(`Missing results file: ${abs}`)
    process.exit(2)
  }
  try {
    suites.push(JSON.parse(readFileSync(abs, 'utf-8')) as EvalSuiteResult)
  } catch (err: any) {
    console.error(`Could not parse ${abs}: ${err.message}`)
    process.exit(2)
  }
}

const model = suites[0].model
/** Median across runs of every test's numbers. */
function mediansOfRun(runs: EvalSuiteResult[]): Record<string, CacheBaselineEntry> {
  const perRun = runs.map((s) => computeCacheBaseline(s.model, s.results as EvalResult[]).perTest)
  const ids = new Set(perRun.flatMap((p) => Object.keys(p)))
  const out: Record<string, CacheBaselineEntry> = {}
  for (const id of ids) {
    const entries = perRun.map((p) => p[id]).filter((e): e is CacheBaselineEntry => !!e)
    if (entries.length === 0) continue
    out[id] = {
      ratio: median(entries.map((e) => e.ratio)),
      turnTokens: Math.round(median(entries.map((e) => e.turnTokens))),
      prefixTokens: Math.round(median(entries.map((e) => e.prefixTokens))),
      turns: Math.max(...entries.map((e) => e.turns)),
    }
  }
  return out
}

const current = mediansOfRun(suites)

function printTable(entries: Record<string, CacheBaselineEntry>): void {
  console.log('')
  console.log('test'.padEnd(32), 'ratio'.padEnd(9), 'turn-1 prompt'.padEnd(16), 'prefix tok')
  console.log('-'.repeat(78))
  for (const [id, e] of Object.entries(entries)) {
    console.log(
      id.padEnd(32),
      `${(e.ratio * 100).toFixed(1)}%`.padEnd(9),
      e.turnTokens.toLocaleString().padEnd(16),
      e.prefixTokens.toLocaleString(),
    )
  }
  console.log('')
}

if (write) {
  const previous = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf-8')) as CacheBaseline) : null
  const baseline: CacheBaseline = {
    model,
    date: new Date().toISOString(),
    perTest: current,
    notes: `median of ${suites.length} run(s) on ${model}` +
      (previous?.date ? `; previous baseline ${previous.date}` : ''),
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8')
  console.log(`Wrote ${OUT} (${Object.keys(current).length} tests, ${suites.length} run(s) on ${model})`)
  printTable(current)
}

if (check) {
  const baseline = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf-8')) as CacheBaseline) : null
  const gate = compareCacheBaseline(current, baseline)
  console.log(
    `Cache gate: ${gate.checked} test(s) compared against ${OUT} ` +
    `(fail on -${CACHE_GATE_RATIO_DROP_POINTS} pts ratio or +${CACHE_GATE_TURN_TOKEN_GROWTH * 100}% turn-1 prompt)`,
  )
  if (gate.reason) console.log(`Not a failure: ${gate.reason}`)
  printTable(current)
  if (!gate.ok) {
    console.error('Cache regressions:')
    for (const r of gate.regressions) console.error(`  - ${describeRegression(r)}`)
    process.exit(1)
  }
  console.log('Cache gate: PASS')
}
