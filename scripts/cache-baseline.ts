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
 * One baseline is kept PER MODEL — hoshi (DeepSeek, implicit + best effort),
 * haiku (Anthropic, explicit breakpoints), luna (OpenAI, implicit) cache in
 * different ways, so a ratio from one is not a target for another. Record each
 * with its own run:
 *
 *   bun run run-eval.ts --track cache-efficiency --model hoshi-2-0 --repeat 3
 *   bun run run-eval.ts --track cache-efficiency --model haiku     --repeat 3
 *   bun run run-eval.ts --track cache-efficiency --model luna      --repeat 3
 *
 * (`--model hoshi` — the bare alias — does not resolve in the eval worker: the
 * runtime's model config rejects it and every turn answers "[ERROR] … please
 * try again". Use the full `hoshi-2-0` id.)
 *
 * `--check` fails (exit 1) when any test's cache-hit ratio drops more than 5
 * points, or its turn-1 prompt grows more than 10%, versus that model's
 * baseline at `packages/agent-runtime/src/evals/cache-baseline.json` (tracked,
 * unlike `bench-results/`, so CI can gate on it). Missing baseline for the
 * model being checked = not a failure; `--write` records it.
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
  selectBaseline,
  upsertBaseline,
  type CacheBaselineEntry,
  type CacheBaselineFile,
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
      firstTurnRatio: median(entries.map((e) => e.firstTurnRatio)),
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

const readFileState = (): CacheBaselineFile | null => {
  if (!existsSync(OUT)) return null
  try {
    return JSON.parse(readFileSync(OUT, 'utf-8')) as CacheBaselineFile
  } catch (err: any) {
    console.error(`Could not parse ${OUT}: ${err.message}`)
    process.exit(2)
  }
}

if (write) {
  // A single-model file written by an earlier version of this script is
  // migrated in place rather than clobbered.
  const raw = readFileState() as any
  const state: CacheBaselineFile | null = raw?.models
    ? raw
    : raw?.perTest
      ? { models: { [raw.model as string]: raw } }
      : null
  const previous = selectBaseline(state, model)
  const next = upsertBaseline(
    state,
    model,
    current,
    new Date().toISOString(),
    `median of ${suites.length} run(s)` + (previous?.date ? `; previous baseline ${previous.date}` : ''),
  )
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
  console.log(`Wrote ${OUT} (${model}: ${Object.keys(current).length} tests, ${suites.length} run(s))`)
  printTable(current)
}

if (check) {
  const baseline = selectBaseline(readFileState(), model)
  if (!baseline) console.log(`No baseline recorded for ${model} yet — recording only, not a failure.`)
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
