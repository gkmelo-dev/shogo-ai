// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { islandCueForTransition } from '../island-cues'
import { EMPTY_ISLAND_SNAPSHOT, type IslandSession, type IslandSnapshot } from '../island-protocol'

function session(over: Partial<IslandSession> = {}): IslandSession {
  return { sessionId: 's1', projectId: 'p1', projectName: 'Acme', title: 'Chat', status: 'running', ...over }
}

const permission = (id: string) => ({
  kind: 'permission' as const,
  request: { id, toolName: 'exec', category: 'shell', reason: 'Runs a command', params: {}, timeout: 60, startedAt: 1 },
})

function snap(sessions: IslandSession[], extra: Partial<IslandSnapshot> = {}): IslandSnapshot {
  return { ...EMPTY_ISLAND_SNAPSHOT, sessions, ...extra }
}

describe('islandCueForTransition', () => {
  test('a new permission request in an unfocused chat needs you', () => {
    const before = snap([session()])
    const after = snap([session({ pending: permission('r1') })])
    expect(islandCueForTransition(before, after)).toBe('needs-you')
  })

  test('a request in the focused chat stays silent', () => {
    const before = snap([session()])
    const after = snap([session({ pending: permission('r1') })], { focusedSessionKey: 'p1:s1' })
    expect(islandCueForTransition(before, after)).toBeNull()
  })

  test('the same request seen again does not repeat the cue', () => {
    const before = snap([session({ pending: permission('r1') })])
    const after = snap([session({ pending: permission('r1') })])
    expect(islandCueForTransition(before, after)).toBeNull()
  })

  test('a running chat that finishes plays done', () => {
    const before = snap([session({ status: 'running' })])
    const after = snap([session({ status: 'done' })])
    expect(islandCueForTransition(before, after)).toBe('done')
  })

  test('a new notice plays error', () => {
    const before = snap([session()])
    const after = snap([session()], { notice: 'Model unavailable' })
    expect(islandCueForTransition(before, after)).toBe('error')
  })

  test('needs-you wins over done in the same transition', () => {
    const before = snap([session({ sessionId: 'a', status: 'running' }), session({ sessionId: 'b' })])
    const after = snap([
      session({ sessionId: 'a', status: 'done' }),
      session({ sessionId: 'b', pending: permission('r2') }),
    ])
    expect(islandCueForTransition(before, after)).toBe('needs-you')
  })

  test('no change plays nothing', () => {
    const state = snap([session({ status: 'done' })])
    expect(islandCueForTransition(state, state)).toBeNull()
  })
})
