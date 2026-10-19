// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import type { RunningProcess } from "../../../ProcessPanel"
import {
  DOCK_FINISHED_LINGER_MS,
  finishLingerDelayMs,
  isFinishedProcess,
  processKey,
} from "../finished-rows"

function task(overrides: Partial<RunningProcess> = {}): RunningProcess {
  return {
    runId: "t_1",
    id: "t_1",
    command: "bun dev",
    startedAt: 0,
    status: "running",
    ...overrides,
  } as RunningProcess
}

describe("finished-rows", () => {
  test("a task is identified by its task id, falling back to the run", () => {
    expect(processKey(task({ id: "t_9", runId: "r_9" }))).toBe("t_9")
    expect(processKey(task({ id: undefined, runId: "r_9" }))).toBe("r_9")
  })

  test("finished means a finish time or a terminal status — not a stale row", () => {
    expect(isFinishedProcess(task())).toBe(false)
    expect(isFinishedProcess(task({ stale: true }))).toBe(false)
    expect(isFinishedProcess(task({ status: "completed" }))).toBe(true)
    expect(isFinishedProcess(task({ status: "failed" }))).toBe(true)
    expect(isFinishedProcess(task({ status: "cancelled" }))).toBe(true)
    expect(isFinishedProcess(task({ finishedAt: 1_000 }))).toBe(true)
  })

  test("the linger counts from the moment the task settled", () => {
    const now = 1_000_000
    expect(finishLingerDelayMs(task({ status: "completed", finishedAt: now }), now)).toBe(
      DOCK_FINISHED_LINGER_MS,
    )
    expect(
      finishLingerDelayMs(task({ status: "completed", finishedAt: now - 1_500 }), now),
    ).toBe(DOCK_FINISHED_LINGER_MS - 1_500)
  })

  test("a row that settled longer ago than the linger leaves immediately", () => {
    const now = 1_000_000
    expect(
      finishLingerDelayMs(task({ status: "completed", finishedAt: now - 60_000 }), now),
    ).toBe(0)
    // A clock skew that puts finishedAt in the future must not park the row forever.
    expect(
      finishLingerDelayMs(task({ status: "completed", finishedAt: now + 60_000 }), now),
    ).toBe(DOCK_FINISHED_LINGER_MS)
  })
})
