// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Background Task Evals
 *
 * One rule covers every slow thing the agent starts: the tool returns a
 * `task_id`, and the agent either blocks with `wait({ task_ids, until })` or
 * ends its turn and continues from the `[Task update]` it is sent. These
 * cases check that the agent follows that rule for each task source (shell,
 * subagent, project call, tagged agent, card) and for the wake turn itself,
 * graded only on deterministic tool-call assertions.
 *
 * Anti-patterns scored across the track: polling with `sleep` or repeated
 * status checks, starting the same work twice, and cancelling tasks it was
 * not asked to stop.
 *
 * Track: --track background-tasks
 */

import type { AgentEval, EvalResult, ToolCallRecord } from './types'
import type { ToolMockMap } from './tool-mocks'
import { responseContains, toolCallCount, usedTool } from './eval-helpers'

const HINT = 'Call wait({ task_ids: [task_id] }) to block on it, or end your turn and you will get a [Task update] when it finishes.'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function execCommands(r: EvalResult): string[] {
  return r.toolCalls
    .filter((t) => t.name === 'exec')
    .map((t) => String((t.input as { command?: unknown })?.command ?? ''))
}

function waitCalls(r: EvalResult): ToolCallRecord[] {
  return r.toolCalls.filter((t) => t.name === 'wait')
}

function waitedOn(r: EvalResult, taskId: string): ToolCallRecord | undefined {
  return waitCalls(r).find((t) => {
    const ids = (t.input as { task_ids?: unknown })?.task_ids
    return Array.isArray(ids) && ids.includes(taskId)
  })
}

/** The task id an exec call handed back, if it became a background task. */
function execTaskIds(r: EvalResult, commandPart: string): string[] {
  const ids: string[] = []
  for (const t of r.toolCalls) {
    if (t.name !== 'exec' || !String((t.input as any)?.command ?? '').includes(commandPart)) continue
    const text = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
    const match = text.match(/"task_id"\s*:\s*"(t_[A-Za-z0-9]+)"/)
    if (match) ids.push(match[1]!)
  }
  return ids
}

/**
 * Polling instead of waiting: a shell `sleep` (outside the scripts under
 * test), a bare `wait` with no task ids, or many `task_list` checks.
 */
function polled(r: EvalResult, allowedSleepIn: string[] = []): boolean {
  const sleeps = execCommands(r).some((cmd) =>
    /(^|[;&|(]\s*)sleep\s+\d/.test(cmd) && !allowedSleepIn.some((s) => cmd.includes(s)))
  const bareWaits = waitCalls(r).some((t) => {
    const ids = (t.input as { task_ids?: unknown })?.task_ids
    return !Array.isArray(ids) || ids.length === 0
  })
  return sleeps || bareWaits || toolCallCount(r, 'task_list') > 2
}

function cancelledSomething(r: EvalResult): boolean {
  return usedTool(r, 'task_cancel')
    || execCommands(r).some((cmd) => /\b(kill|pkill|killall)\b/.test(cmd))
}

function callsTo(r: EvalResult, name: string): ToolCallRecord[] {
  return r.toolCalls.filter((t) => t.name === name)
}

const writtenContent = (r: EvalResult, path: string): string =>
  r.toolCalls
    .filter((t) => (t.name === 'write_file' || t.name === 'edit_file') && String((t.input as any)?.path ?? '').endsWith(path))
    .map((t) => JSON.stringify(t.input))
    .join('\n')

// ---------------------------------------------------------------------------
// Mocks for API-tracked sources (project call, tagged agent, card)
// ---------------------------------------------------------------------------

const PROJECT_CALL_MOCKS: ToolMockMap = {
  project_call: {
    type: 'pattern',
    patterns: [
      {
        match: { wait: '"wait":false' },
        response: {
          ok: true,
          project: { id: 'proj_analyst', name: 'Analyst' },
          runId: 'run_q3churn',
          status: 'running',
          task_id: 't_pc00q3ch',
          output_file: '.shogo/tasks/eval/t_pc00q3ch.log',
          hint: HINT,
        },
      },
    ],
    default: {
      ok: true,
      project: { id: 'proj_analyst', name: 'Analyst' },
      runId: 'run_q3churn',
      status: 'completed',
      reply: 'Q3 churn was 4.2%, down from 5.1% in Q2.',
    },
    delayMs: 0,
  },
  wait: {
    type: 'static',
    response: {
      task_id: 't_pc00q3ch',
      source: 'project_call',
      title: 'Analyst',
      status: 'completed',
      output: 'Q3 churn was 4.2%, down from 5.1% in Q2.',
      still_running: [],
    },
    delayMs: 0,
  },
}

const TAGGED_AGENT_MOCKS: ToolMockMap = {
  team_chat_post: {
    type: 'static',
    description: 'Post a message to a workspace channel or thread. Tag agents with @Name to hand them work. Returns the message id, thread_id, and a background task per agent you tagged.',
    paramKeys: ['channel', 'text', 'thread_id'],
    response: {
      ok: true,
      id: 'msg_design1',
      thread_id: 'msg_design1',
      tasks: [{ task_id: 't_rep0dsgn', title: '@Designer reply', status: 'running' }],
      task_ids: ['t_rep0dsgn'],
      hint: HINT,
    },
    delayMs: 0,
  },
  team_chat_read: {
    type: 'static',
    description: 'Read recent messages in a workspace channel or thread.',
    paramKeys: ['channel', 'thread_id'],
    response: { messages: [{ id: 'msg_design1', author: 'you', text: '@Designer which hex color for the primary button?' }] },
    delayMs: 0,
  },
  wait: {
    type: 'static',
    response: {
      task_id: 't_rep0dsgn',
      source: 'agent_reply',
      title: '@Designer reply',
      status: 'completed',
      output: 'Use #3B82F6 for the primary button.',
      still_running: [],
    },
    delayMs: 0,
  },
}

const CARD_MOCKS: ToolMockMap = {
  work_item_get: {
    type: 'static',
    description: 'Get one card by key or id: its fields, column, history and comments. The result has a task_id: wait on it (with until, e.g. "Done") to be told when the card changes.',
    paramKeys: ['item'],
    response: {
      item: { id: 'item_sup12', key: 'SUP-12', title: 'Fix login redirect loop', column: { name: 'In Progress', category: 'active' } },
      task_id: 't_card0s12',
    },
    delayMs: 0,
  },
  wait: {
    type: 'static',
    response: {
      task_id: 't_card0s12',
      source: 'work_item',
      title: 'SUP-12 Fix login redirect loop',
      status: 'completed',
      matched: 'Done',
      output: 'moved to Review (review)\nmoved to Done (done)',
    },
    delayMs: 0,
  },
  team_chat_post: {
    type: 'static',
    description: 'Post a message to a workspace channel or thread.',
    paramKeys: ['channel', 'text', 'thread_id'],
    response: { ok: true, id: 'msg_rel1', thread_id: 'msg_rel1' },
    delayMs: 0,
  },
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const BACKGROUND_TASK_EVALS: AgentEval[] = [
  {
    id: 'bg-long-command-wait',
    name: 'A long command is waited on, not polled or re-run',
    category: 'tool-usage',
    level: 2,
    input: 'Run `bash scripts/slow-tests.sh` (it takes about 40 seconds) and tell me how many tests passed.',
    workspaceFiles: {
      'scripts/slow-tests.sh': '#!/bin/bash\nsleep 40\necho "Tests: 42 passed, 0 failed"\n',
    },
    validationCriteria: [
      {
        id: 'ran-once',
        description: 'Ran the script exactly once',
        points: 3,
        phase: 'execution',
        validate: (r) => execCommands(r).filter((c) => c.includes('slow-tests.sh')).length === 1,
      },
      {
        id: 'waited-on-task',
        description: 'Collected the result with wait on its task (or gave exec a long enough timeout)',
        points: 3,
        phase: 'intention',
        validate: (r) => {
          const ids = execTaskIds(r, 'slow-tests.sh')
          if (ids.some((id) => waitedOn(r, id))) return true
          return callsTo(r, 'exec').some((t) => Number((t.input as any)?.timeout) >= 45_000)
        },
      },
      {
        id: 'no-polling',
        description: 'No sleep loops, bare waits or repeated task_list',
        points: 3,
        phase: 'intention',
        validate: (r) => !polled(r, ['slow-tests.sh']),
      },
      {
        id: 'reported-result',
        description: 'Reported 42 passing tests',
        points: 3,
        phase: 'execution',
        validate: (r) => responseContains(r, '42'),
      },
    ],
    antiPatterns: ['sleep polling', 'running the script twice'],
    maxScore: 12,
  },
  {
    id: 'bg-dev-server-until',
    name: 'A dev server runs in the background and is waited on until ready',
    category: 'tool-usage',
    level: 3,
    input: 'Start the dev server with `bash scripts/dev.sh` and tell me which port it is on once it is ready. Leave it running.',
    workspaceFiles: {
      'scripts/dev.sh': '#!/bin/bash\necho "compiling..."\nsleep 5\necho "ready on port 4321"\nsleep 600\n',
    },
    validationCriteria: [
      {
        id: 'started-in-background',
        description: 'Started the server as a background task',
        points: 3,
        phase: 'intention',
        validate: (r) => callsTo(r, 'exec').some((t) =>
          String((t.input as any)?.command ?? '').includes('dev.sh') && (t.input as any)?.background === true),
      },
      {
        id: 'waited-until-ready',
        description: 'Waited on the server task with an until pattern',
        points: 4,
        phase: 'intention',
        validate: (r) => {
          const ids = execTaskIds(r, 'dev.sh')
          return ids.some((id) => {
            const call = waitedOn(r, id)
            return !!call && typeof (call.input as any)?.until === 'string'
          })
        },
      },
      {
        id: 'left-running',
        description: 'Did not kill or cancel the server',
        points: 2,
        phase: 'execution',
        validate: (r) => !cancelledSomething(r),
      },
      {
        id: 'no-polling',
        description: 'No sleep loops, bare waits or repeated task_list',
        points: 2,
        phase: 'intention',
        validate: (r) => !polled(r, ['dev.sh']),
      },
      {
        id: 'reported-port',
        description: 'Reported port 4321',
        points: 3,
        phase: 'execution',
        validate: (r) => responseContains(r, '4321'),
      },
    ],
    antiPatterns: ['sleep polling', 'killing the server', 'starting it twice'],
    maxScore: 14,
  },
  {
    id: 'bg-fanout-subagents',
    name: 'Background subagents fan out and their results are collected',
    category: 'subagent',
    level: 3,
    input: 'Use two background agents in parallel: one reads docs/a.md and one reads docs/b.md, and each reports the magic number in its file. Then tell me the sum of the two numbers.',
    workspaceFiles: {
      'docs/a.md': '# Service A\n\nThe magic number is 17.\n',
      'docs/b.md': '# Service B\n\nThe magic number is 25.\n',
    },
    validationCriteria: [
      {
        id: 'spawned-in-background',
        description: 'Spawned at least two agents with background: true',
        points: 4,
        phase: 'intention',
        validate: (r) => callsTo(r, 'agent_spawn').filter((t) => (t.input as any)?.background === true).length >= 2,
      },
      {
        id: 'waited-on-tasks',
        description: 'Collected results with wait on the agents\' tasks',
        points: 3,
        phase: 'intention',
        validate: (r) => waitCalls(r).some((t) => Array.isArray((t.input as any)?.task_ids) && (t.input as any).task_ids.length > 0),
      },
      {
        id: 'no-polling',
        description: 'No sleep loops, bare waits, repeated task_list or more waits than needed',
        points: 3,
        phase: 'intention',
        validate: (r) => !polled(r) && waitCalls(r).length <= 4,
      },
      {
        id: 'correct-sum',
        description: 'Reported the sum 42',
        points: 3,
        phase: 'execution',
        validate: (r) => responseContains(r, '42'),
      },
    ],
    antiPatterns: ['polling agent status', 'spawning the same agent twice'],
    maxScore: 13,
  },
  {
    id: 'bg-project-call-async',
    name: 'A slow project call runs in the background and is not repeated',
    category: 'tool-usage',
    level: 3,
    input: 'Ask the Analyst project what Q3 churn was. It can take several minutes, so do not block on the call itself: start it, then get me the number.',
    toolMocks: PROJECT_CALL_MOCKS,
    validationCriteria: [
      {
        id: 'called-async',
        description: 'Called project_call with wait: false',
        points: 3,
        phase: 'intention',
        validate: (r) => callsTo(r, 'project_call').some((t) => (t.input as any)?.wait === false),
      },
      {
        id: 'called-once',
        description: 'Did not call the project again while its task was running',
        points: 3,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'project_call') === 1,
      },
      {
        id: 'followed-task',
        description: 'Waited on the returned task and reported 4.2%, or ended the turn to be told when it finishes',
        points: 3,
        phase: 'execution',
        validate: (r) => waitedOn(r, 't_pc00q3ch') ? responseContains(r, '4.2') : waitCalls(r).length === 0,
      },
      {
        id: 'no-polling',
        description: 'No sleep loops, bare waits or repeated task_list',
        points: 3,
        phase: 'intention',
        validate: (r) => !polled(r),
      },
    ],
    antiPatterns: ['re-sending the request', 'sleep polling'],
    maxScore: 12,
  },
  {
    id: 'bg-tagged-agent-reply',
    name: 'Waiting for a tagged agent\'s reply before acting on it',
    category: 'teammate-coordination',
    level: 3,
    input: 'Ask @Designer in #design which hex color to use for the primary button. Once they reply, write it into theme.json as {"primaryColor": "<hex>"}.',
    workspaceFiles: { 'theme.json': '{}\n' },
    toolMocks: TAGGED_AGENT_MOCKS,
    validationCriteria: [
      {
        id: 'posted-once',
        description: 'Posted the question once',
        points: 2,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'team_chat_post') === 1,
      },
      {
        id: 'waited-on-reply',
        description: 'Waited on the reply task the post returned',
        points: 4,
        phase: 'intention',
        validate: (r) => !!waitedOn(r, 't_rep0dsgn'),
      },
      {
        id: 'no-thread-polling',
        description: 'Did not poll the thread for the reply',
        points: 3,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'team_chat_read') <= 1 && !polled(r),
      },
      {
        id: 'wrote-color',
        description: 'Wrote #3B82F6 into theme.json',
        points: 4,
        phase: 'execution',
        validate: (r) => /3B82F6/i.test(writtenContent(r, 'theme.json')),
      },
    ],
    antiPatterns: ['re-reading the thread in a loop', 'posting the question twice'],
    maxScore: 13,
  },
  {
    id: 'bg-card-done',
    name: 'Waiting for a card to reach Done',
    category: 'teammate-coordination',
    level: 3,
    input: 'When SUP-12 reaches Done, post "Login fix shipped" to #releases.',
    toolMocks: CARD_MOCKS,
    validationCriteria: [
      {
        id: 'waited-until-done',
        description: 'Waited on the card task with an until pattern for Done',
        points: 4,
        phase: 'intention',
        validate: (r) => {
          const call = waitedOn(r, 't_card0s12')
          return !!call && /done/i.test(String((call.input as any)?.until ?? ''))
        },
      },
      {
        id: 'posted-after',
        description: 'Posted the release note after the wait returned',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const waitIdx = r.toolCalls.findIndex((t) => t.name === 'wait')
          const postIdx = r.toolCalls.findIndex((t) =>
            t.name === 'team_chat_post' && /login fix shipped/i.test(JSON.stringify(t.input)))
          return waitIdx !== -1 && postIdx > waitIdx
        },
      },
      {
        id: 'no-polling',
        description: 'Did not re-read the card in a loop',
        points: 3,
        phase: 'intention',
        validate: (r) => toolCallCount(r, 'work_item_get') <= 2 && !polled(r),
      },
    ],
    antiPatterns: ['polling the card', 'posting before it is done'],
    maxScore: 11,
  },
  {
    id: 'bg-wake-turn',
    name: 'A [Task update] turn continues from the result instead of re-running',
    category: 'tool-usage',
    level: 2,
    conversationHistory: [
      { role: 'user', content: 'Run the full test suite in the background and tell me when it is done.' },
      { role: 'assistant', content: 'Started the test suite in the background (task t_shell001). I will report back when it finishes.' },
    ],
    input: [
      '[Task update] bun test (t_shell001) failed (exit code 1).',
      'Output: .shogo/tasks/eval/t_shell001.log',
      'Last output:',
      '41 pass',
      '1 fail',
      '  ✗ totals > rounds to cents',
    ].join('\n'),
    workspaceFiles: {
      '.shogo/tasks/eval/t_shell001.log': [
        '---', 'task_id: t_shell001', 'source: shell', 'title: bun test', '---',
        'src/totals.test.ts:',
        '  ✗ totals > rounds to cents',
        '    expected 10.01, received 10.005',
        '41 pass', '1 fail',
        '---', 'status: failed', 'exit_code: 1', '---',
      ].join('\n'),
    },
    validationCriteria: [
      {
        id: 'did-not-rerun-suite',
        description: 'Did not run the whole suite again',
        points: 4,
        phase: 'intention',
        validate: (r) => !execCommands(r).some((c) => /\bbun\s+(run\s+)?test\s*$/.test(c.trim())),
      },
      {
        id: 'reported-failure',
        description: 'Reported the failing test',
        points: 4,
        phase: 'execution',
        validate: (r) => responseContains(r, 'rounds to cents') || responseContains(r, 'totals'),
      },
      {
        id: 'no-waiting',
        description: 'Did not wait or poll for a task that already finished',
        points: 2,
        phase: 'intention',
        validate: (r) => waitCalls(r).length === 0 && toolCallCount(r, 'task_list') === 0,
      },
    ],
    antiPatterns: ['re-running the finished task', 'waiting on a finished task'],
    maxScore: 10,
  },
]
