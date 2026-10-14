// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Recovery after the chat view itself fails mid-turn with React's
 * "Maximum update depth exceeded" (#185). The server-side turn keeps running
 * and finishes normally; only the client lost its stream.
 *
 * Replaying the buffered chunks into the same tree is what used to fail
 * again, so recovery never replays: while the turn is still active it
 * re-attaches once through the message-snapshot resume (#1250 — one chunk with
 * the whole message so far, then live chunks). If that fails too, or the turn
 * already ended, it waits for the turn to finish and reloads the persisted
 * messages once.
 *
 * Pure (time and I/O injected) so the state machine is unit-testable.
 */

import type { ChatTurnStatus } from "./probe-turn-status"
import { computeRecoveryBackoff } from "./stall-recovery"

export type RenderErrorRecoveryAction = "reattach-snapshot" | "poll-then-reload" | "reload"

/** Re-attach through the snapshot path at most this many times per turn. */
export const MAX_SNAPSHOT_REATTACHES = 1

export function decideRenderErrorRecovery({
  turnStatus,
  reattachAttempts,
}: {
  turnStatus: ChatTurnStatus
  /** Snapshot re-attaches already made for this turn. */
  reattachAttempts: number
}): RenderErrorRecoveryAction {
  if (turnStatus === "active") {
    return reattachAttempts < MAX_SNAPSHOT_REATTACHES ? "reattach-snapshot" : "poll-then-reload"
  }
  if (turnStatus === "unknown") return "poll-then-reload"
  return "reload"
}

export const RENDER_RECOVERY_MAX_WAIT_MS = 10 * 60_000

export type PollUntilTerminalResult =
  | { outcome: "terminal"; turnStatus: Exclude<ChatTurnStatus, "active" | "unknown"> }
  | { outcome: "cancelled" }
  | { outcome: "timeout"; turnStatus: ChatTurnStatus }

/**
 * Probe `/turn` with capped exponential backoff until it reports a terminal
 * status. `unknown` keeps polling: right after a turn ends its buffer may be
 * evicted, so a run of `unknown` after earlier `active` probes is treated as
 * finished once `unknownIsTerminalAfter` consecutive probes agree.
 */
export async function pollUntilTerminal({
  probe,
  isCancelled,
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  maxWaitMs = RENDER_RECOVERY_MAX_WAIT_MS,
  unknownIsTerminalAfter = 4,
}: {
  probe: () => Promise<ChatTurnStatus>
  isCancelled: () => boolean
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  maxWaitMs?: number
  unknownIsTerminalAfter?: number
}): Promise<PollUntilTerminalResult> {
  const deadline = now() + maxWaitMs
  let unknownRun = 0
  let last: ChatTurnStatus = "unknown"
  for (let attempt = 1; ; attempt++) {
    if (isCancelled()) return { outcome: "cancelled" }
    try {
      last = await probe()
    } catch {
      last = "unknown"
    }
    if (isCancelled()) return { outcome: "cancelled" }
    if (last === "completed" || last === "failed" || last === "aborted") {
      return { outcome: "terminal", turnStatus: last }
    }
    unknownRun = last === "unknown" ? unknownRun + 1 : 0
    if (unknownRun >= unknownIsTerminalAfter) return { outcome: "terminal", turnStatus: "completed" }
    if (now() >= deadline) return { outcome: "timeout", turnStatus: last }
    await sleep(computeRecoveryBackoff(attempt, { initialMs: 1_000, maxMs: 10_000 }))
  }
}
