// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  applyInteractionModePrompt,
  ASK_MODE_PROMPT,
  autoFloorTierFor,
  buildPlanModePrompt,
  filterToolsForMode,
  missingCodePlanSections,
  PLAN_DELIVERY_NUDGE,
  PLAN_MODE_ALLOWED_TOOLS,
  PLAN_MODE_REMINDER,
  planWrittenInsteadOfCreated,
} from '../plan-mode-prompt'

describe('planWrittenInsteadOfCreated', () => {
  const chatPlan = '## Problem\nTimeouts at 5s.\n\n## Root cause\n`src/http/client.ts:24` hardcodes 5000.\n\n## Changes\n- read the setting'
  test('a plan-mode reply that holds a plan but called no plan tool', () => {
    expect(planWrittenInsteadOfCreated('plan', ['read_file', 'grep'], chatPlan)).toBe(true)
  })
  test('not when the plan was delivered, or the agent asked the user', () => {
    expect(planWrittenInsteadOfCreated('plan', ['read_file', 'create_plan'], chatPlan)).toBe(false)
    expect(planWrittenInsteadOfCreated('plan', ['update_plan'], chatPlan)).toBe(false)
    expect(planWrittenInsteadOfCreated('plan', ['ask_user'], chatPlan)).toBe(false)
  })
  test('not outside plan mode, and not for an ordinary answer', () => {
    expect(planWrittenInsteadOfCreated('agent', [], chatPlan)).toBe(false)
    expect(planWrittenInsteadOfCreated('plan', [], 'The timeout comes from `src/http/client.ts`. ## Problem')).toBe(false)
    expect(planWrittenInsteadOfCreated('plan', [], '## Problem\nOnly one heading here.')).toBe(false)
  })
  test('the nudge asks for create_plan with the same plan', () => {
    expect(PLAN_DELIVERY_NUDGE).toContain('Call `create_plan` now with that plan')
  })
})

describe('missingCodePlanSections', () => {
  test('a code plan without the root-cause sections reports both', () => {
    expect(missingCodePlanSections('## Problem\nx\n## Changes\n- `src/http/client.ts`: read the setting')).toEqual(['Root cause', 'Options considered'])
  })
  test('headings at any level and in any case count', () => {
    expect(missingCodePlanSections('### root cause\nsrc/a.ts:3\n# Options Considered\n1. a')).toEqual([])
    expect(missingCodePlanSections('## Root cause\nsrc/a.py:3')).toEqual(['Options considered'])
  })
  test('plans that name no source file are not code plans', () => {
    expect(missingCodePlanSections('## Itinerary\nDay 1: Lisbon')).toEqual([])
  })
})

/** Backticked identifiers that look like tool names (lowercase snake_case). */
function advertisedTools(prompt: string): string[] {
  return [...prompt.matchAll(/`([a-z][a-z_]*)`/g)].map((m) => m[1])
}

describe('plan mode prompt', () => {
  for (const searchEnabled of [false, true]) {
    test(`every advertised tool is allowed in plan mode (searchEnabled=${searchEnabled})`, () => {
      const tools = advertisedTools(buildPlanModePrompt({ searchEnabled }))
      expect(tools.length).toBeGreaterThan(5)
      for (const name of tools) {
        expect({ name, allowed: PLAN_MODE_ALLOWED_TOOLS.has(name) }).toEqual({ name, allowed: true })
      }
      expect(tools.includes('search')).toBe(searchEnabled)
    })
  }

  test('requires the investigation protocol and the code-change plan sections', () => {
    const prompt = buildPlanModePrompt({ searchEnabled: false })
    expect(prompt).toContain('Investigation protocol (required before `create_plan`)')
    for (const heading of ['## Problem', '## Root cause', '## Options considered', '## Changes', '## Tests', '## Verification', '## Risks']) {
      expect(prompt).toContain(`\`${heading}\``)
    }
    expect(prompt).toContain('`path:line`')
    expect(prompt).toContain('Self-check before calling `create_plan`')
  })

  test('a change request always ends in create_plan, never a snippet to apply by hand', () => {
    const prompt = buildPlanModePrompt({ searchEnabled: false })
    expect(prompt).toContain('Every request that would change code ends with `create_plan`')
    expect(prompt).toContain('even when the user does not say "plan"')
    expect(prompt).toContain('Never answer with a snippet for the user to apply instead')
    expect(prompt).toContain('The editing and command tools (edit_file, write_file, exec) do not exist in plan mode.')
  })

  test('no longer asks for a concise plan', () => {
    expect(buildPlanModePrompt({ searchEnabled: true }).toLowerCase()).not.toContain('concise')
  })

  test('keeps the no-mutation rule and the create_plan/update_plan exception', () => {
    const prompt = buildPlanModePrompt({ searchEnabled: false })
    expect(prompt).toContain('You MUST NOT edit source files, run mutating commands, or otherwise change the workspace before the user clicks Build.')
    expect(prompt).toContain('Exception: you may create or update the plan artifact using create_plan/update_plan')
  })
})

describe('PLAN_MODE_ALLOWED_TOOLS', () => {
  test('includes the exploration tools and nothing that mutates', () => {
    for (const name of ['grep', 'git_history', 'impact_radius', 'read_lints', 'read_file']) {
      expect(PLAN_MODE_ALLOWED_TOOLS.has(name)).toBe(true)
    }
    for (const name of ['exec', 'write_file', 'edit_file', 'delete_file', 'terminal_exec', 'publish']) {
      expect(PLAN_MODE_ALLOWED_TOOLS.has(name)).toBe(false)
    }
  })
})

describe('applyInteractionModePrompt', () => {
  test('plan prepends the plan prompt and closes with the reminder', () => {
    const out = applyInteractionModePrompt('BASE', 'plan', { searchEnabled: false })
    expect(out.startsWith('## PLAN MODE ACTIVE')).toBe(true)
    expect(out.endsWith(`\n\n---\n\nBASE\n\n---\n\n${PLAN_MODE_REMINDER}`)).toBe(true)
    expect(PLAN_MODE_REMINDER).toContain('finish by calling `create_plan`')
    expect(PLAN_MODE_REMINDER).toContain('Do not write the plan into your reply')
  })
  test('ask prepends the unchanged ask prompt', () => {
    expect(applyInteractionModePrompt('BASE', 'ask', { searchEnabled: false })).toBe(`${ASK_MODE_PROMPT}\n\n---\n\nBASE`)
    expect(ASK_MODE_PROMPT).toContain('You have no tools available.')
  })
  test('agent mode is unchanged', () => {
    expect(applyInteractionModePrompt('BASE', 'agent', { searchEnabled: true })).toBe('BASE')
    expect(applyInteractionModePrompt('BASE', undefined, { searchEnabled: true })).toBe('BASE')
  })
})

describe('filterToolsForMode', () => {
  const tools = ['read_file', 'grep', 'git_history', 'exec', 'write_file', 'create_plan', 'search'].map((name) => ({ name }))
  test('plan keeps registered allowlisted tools only', () => {
    expect(filterToolsForMode(tools, 'plan').map((t) => t.name)).toEqual(['read_file', 'grep', 'git_history', 'create_plan', 'search'])
    expect(filterToolsForMode(tools.filter((t) => t.name !== 'search'), 'plan').map((t) => t.name)).not.toContain('search')
  })
  test('ask has no tools; agent keeps all', () => {
    expect(filterToolsForMode(tools, 'ask')).toEqual([])
    expect(filterToolsForMode(tools, 'agent')).toBe(tools)
  })
})

describe('autoFloorTierFor', () => {
  test('plan turns get a standard floor', () => {
    expect(autoFloorTierFor('plan')).toBe('standard')
    expect(autoFloorTierFor('agent')).toBeUndefined()
    expect(autoFloorTierFor('ask')).toBeUndefined()
    expect(autoFloorTierFor(undefined)).toBeUndefined()
  })
})
