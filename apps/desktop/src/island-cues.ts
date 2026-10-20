// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Which sound cue a snapshot transition deserves when no island is on screen
// to play it. Mirrors `islandSoundForTransition` in the renderer's
// island-sounds.ts. The main process cannot import from the renderer, so the
// rule lives in both places and island-cues.test.ts pins it.

import { islandSessionKey, type IslandSnapshot } from './island-protocol'

export type IslandCue = 'needs-you' | 'done' | 'error'

/** The one cue a transition deserves, loudest first. Sessions the user is
 * looking at in a focused Shogo window stay silent. */
export function islandCueForTransition(previous: IslandSnapshot, next: IslandSnapshot): IslandCue | null {
  const before = new Map(
    previous.sessions.map((session) => [islandSessionKey(session.projectId, session.sessionId), session]),
  )
  let cue: IslandCue | null = null
  for (const session of next.sessions) {
    const key = islandSessionKey(session.projectId, session.sessionId)
    if (key === next.focusedSessionKey) continue
    const prior = before.get(key)
    const newRequest = !!session.pending && session.pending.request.id !== prior?.pending?.request.id
    const newPlan = !!session.pendingPlan && session.pendingPlan.toolCallId !== prior?.pendingPlan?.toolCallId
    if (newRequest || newPlan) return 'needs-you'
    if (prior?.status === 'running' && session.status === 'done') cue = 'done'
  }
  if (!cue && next.notice && next.notice !== previous.notice) return 'error'
  return cue
}
