// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The background-task graders on scripted trajectories: the intended
 * behaviour earns full marks and each anti-pattern loses its points.
 */

import { describe, expect, test } from 'bun:test'
import { BACKGROUND_TASK_EVALS } from './test-cases-background-tasks'
import type { AgentEval, EvalResult, ToolCallRecord } from './types'

function evalById(id: string): AgentEval {
  const found = BACKGROUND_TASK_EVALS.find((e) => e.id === id)
  if (!found) throw new Error(`no eval ${id}`)
  return found
}

function result(toolCalls: Array<Partial<ToolCallRecord> & { name: string }>, responseText: string): EvalResult {
  const calls = toolCalls.map((t) => ({ input: {}, output: '', ...t })) as ToolCallRecord[]
  return { toolCalls: calls, finalTurnToolCalls: calls, responseText } as unknown as EvalResult
}

function failing(ev: AgentEval, r: EvalResult): string[] {
  return ev.validationCriteria.filter((c) => !c.validate(r)).map((c) => c.id)
}

const running = (taskId: string) => JSON.stringify({ status: 'running', task_id: taskId, output_file: `.shogo/tasks/s/${taskId}.log` })

describe('background task graders', () => {
  test('every case has points that add up to its max score', () => {
    for (const ev of BACKGROUND_TASK_EVALS) {
      expect(ev.validationCriteria.reduce((n, c) => n + c.points, 0)).toBe(ev.maxScore)
    }
  })

  test('long command: wait on the task passes; sleep polling and re-running fail', () => {
    const ev = evalById('bg-long-command-wait')
    const good = result([
      { name: 'exec', input: { command: 'bash scripts/slow-tests.sh' }, output: running('t_aaaa1111') },
      { name: 'wait', input: { task_ids: ['t_aaaa1111'], timeout_ms: 60_000 } },
    ], 'Tests: 42 passed, 0 failed.')
    expect(failing(ev, good)).toEqual([])

    const bad = result([
      { name: 'exec', input: { command: 'bash scripts/slow-tests.sh' }, output: running('t_aaaa1111') },
      { name: 'exec', input: { command: 'sleep 30' } },
      { name: 'exec', input: { command: 'bash scripts/slow-tests.sh' } },
    ], '42 passed')
    expect(failing(ev, bad)).toEqual(['ran-once', 'waited-on-task', 'no-polling'])
  })

  test('dev server: background + wait until passes; killing it fails', () => {
    const ev = evalById('bg-dev-server-until')
    const start = { name: 'exec', input: { command: 'bash scripts/dev.sh', background: true }, output: running('t_dev00001') }
    expect(failing(ev, result([start, { name: 'wait', input: { task_ids: ['t_dev00001'], until: 'ready on port' } }], 'Ready on port 4321.'))).toEqual([])
    expect(failing(ev, result([start, { name: 'wait', input: {} }, { name: 'task_cancel', input: { task_id: 't_dev00001' } }], 'port 4321')))
      .toEqual(['waited-until-ready', 'left-running', 'no-polling'])
  })

  test('project call: async + wait reporting the number passes; calling twice fails', () => {
    const ev = evalById('bg-project-call-async')
    const call = { name: 'project_call', input: { project: 'Analyst', message: 'Q3 churn?', wait: false } }
    expect(failing(ev, result([call, { name: 'wait', input: { task_ids: ['t_pc00q3ch'] } }], 'Q3 churn was 4.2%.'))).toEqual([])
    expect(failing(ev, result([call], 'Started; I will report when the Analyst replies.'))).toEqual([])
    expect(failing(ev, result([call, { ...call, input: { ...call.input, wait: true } }], 'It was 4.2%'))).toEqual(['called-once'])
  })

  test('tagged agent: waiting on the reply task passes; polling the thread fails', () => {
    const ev = evalById('bg-tagged-agent-reply')
    const post = { name: 'team_chat_post', input: { channel: 'design', text: '@Designer which hex?' } }
    const write = { name: 'write_file', input: { path: 'theme.json', content: '{"primaryColor": "#3B82F6"}' } }
    expect(failing(ev, result([post, { name: 'wait', input: { task_ids: ['t_rep0dsgn'] } }, write], 'Done.'))).toEqual([])
    const read = { name: 'team_chat_read', input: { channel: 'design' } }
    expect(failing(ev, result([post, read, read, read], 'No reply yet.'))).toEqual(['waited-on-reply', 'no-thread-polling', 'wrote-color'])
  })

  test('card: wait until Done then post passes; posting first fails', () => {
    const ev = evalById('bg-card-done')
    const get = { name: 'work_item_get', input: { item: 'SUP-12' } }
    const wait = { name: 'wait', input: { task_ids: ['t_card0s12'], until: 'Done' } }
    const post = { name: 'team_chat_post', input: { channel: 'releases', text: 'Login fix shipped' } }
    expect(failing(ev, result([get, wait, post], 'Posted.'))).toEqual([])
    expect(failing(ev, result([get, post, get, get], 'Posted.'))).toEqual(['waited-until-done', 'posted-after', 'no-polling'])
  })

  test('wake turn: reporting from the update passes; re-running the suite fails', () => {
    const ev = evalById('bg-wake-turn')
    expect(failing(ev, result([{ name: 'read_file', input: { path: '.shogo/tasks/eval/t_shell001.log' } }], 'One failure: totals > rounds to cents.'))).toEqual([])
    expect(failing(ev, result([{ name: 'exec', input: { command: 'bun test' } }, { name: 'wait', input: { task_ids: ['t_x'] } }], 'Re-ran.')))
      .toEqual(['did-not-rerun-suite', 'reported-failure', 'no-waiting'])
  })

  test('fan-out: background spawns collected with wait pass; no wait fails', () => {
    const ev = evalById('bg-fanout-subagents')
    const spawn = (n: number) => ({ name: 'agent_spawn', input: { type: 'explore', prompt: `read docs/${n}.md`, background: true } })
    expect(failing(ev, result([spawn(1), spawn(2), { name: 'wait', input: { task_ids: ['t_1', 't_2'] } }, { name: 'wait', input: { task_ids: ['t_2'] } }], 'The sum is 42.'))).toEqual([])
    expect(failing(ev, result([spawn(1), spawn(2), { name: 'exec', input: { command: 'sleep 20' } }], 'The sum is 42.')))
      .toEqual(['waited-on-tasks', 'no-polling'])
  })
})
