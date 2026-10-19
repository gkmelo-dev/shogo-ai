// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * When a settled task row leaves the running-tasks dock.
 *
 * The runtime keeps a finished task in `listDock()` for ten minutes so a late
 * `wait`, `task_list` or output read still finds it. That retention is a
 * server concern; the dock only needs the row long enough to read the outcome.
 * These constants and helpers are the dock's side of that split, kept pure so
 * the timing is testable without a mounted panel.
 */

import type { RunningProcess } from "../ProcessPanel"

/** How long a settled row stays readable before it starts leaving the dock. */
export const DOCK_FINISHED_LINGER_MS = 4_000
/** Fade + height collapse of a row on its way out. */
export const DOCK_FINISHED_EXIT_MS = 220

/** Stable identity of a task row — the task id, or the run it was started as. */
export function processKey(proc: RunningProcess): string {
  return proc.id ?? proc.runId
}

/** Settled: it has a finish time or a terminal status. `stale` rows are not. */
export function isFinishedProcess(proc: RunningProcess): boolean {
  return !!proc.finishedAt || (!!proc.status && proc.status !== "running")
}

/**
 * How long until a settled row starts its exit. Clamped to the linger window
 * so a row that arrives already older than it (a reload restoring a task that
 * finished a minute ago) leaves on the next tick instead of waiting again.
 */
export function finishLingerDelayMs(proc: RunningProcess, now: number): number {
  const finishedAt = proc.finishedAt ?? now
  return Math.min(
    DOCK_FINISHED_LINGER_MS,
    Math.max(0, finishedAt + DOCK_FINISHED_LINGER_MS - now),
  )
}
