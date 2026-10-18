// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_AGENT_NAME,
  initialIslandView,
  isWorkspaceAgentChat,
  parentView,
  type IslandView,
} from "../island-view"
import { ISLAND_WORKSPACE_AGENT_ID } from "../types"

const projectChat: IslandView = {
  name: "chat",
  projectId: "project-1",
  projectName: "Website",
  sessionId: "session-1",
  title: "Chat",
}

const agentChat: IslandView = {
  name: "chat",
  projectId: ISLAND_WORKSPACE_AGENT_ID,
  projectName: "Shogo",
  sessionId: "ws-session-1",
  title: "New chat",
}

describe("initialIslandView", () => {
  test("opens on a blank workspace-agent chat when the runtime supports it", () => {
    expect(initialIslandView(true)).toEqual({ name: "agent" })
  })

  test("falls back to the project inbox without the workspace runtime", () => {
    expect(initialIslandView(false)).toEqual({ name: "inbox" })
  })
})

describe("parentView", () => {
  test("the blank agent chat closes the card", () => {
    expect(parentView({ name: "agent" }, true)).toBeNull()
  })

  test("the inbox goes back to the agent chat when enabled", () => {
    expect(parentView({ name: "inbox" }, true)).toEqual({ name: "agent" })
  })

  test("the inbox closes the card when the agent view is off", () => {
    expect(parentView({ name: "inbox" }, false)).toBeNull()
  })

  test("a project goes back to the inbox", () => {
    expect(parentView({ name: "project", projectId: "p1", projectName: "Website" }, true)).toEqual({
      name: "inbox",
    })
  })

  test("a project chat goes back to its project", () => {
    expect(parentView(projectChat, true)).toEqual({
      name: "project",
      projectId: "project-1",
      projectName: "Website",
    })
  })

  test("a workspace-agent chat goes back to the inbox, not a project", () => {
    expect(parentView(agentChat, true)).toEqual({ name: "inbox" })
  })

  test("the drop sheet returns to the view it covered", () => {
    const drop: IslandView = { name: "drop", files: [], returnTo: agentChat }
    expect(parentView(drop, true)).toBe(agentChat)
  })
})

describe("isWorkspaceAgentChat", () => {
  test("only chats keyed by the agent id count", () => {
    expect(isWorkspaceAgentChat(agentChat)).toBe(true)
    expect(isWorkspaceAgentChat(projectChat)).toBe(false)
    expect(isWorkspaceAgentChat({ name: "agent" })).toBe(false)
    expect(isWorkspaceAgentChat({ name: "inbox" })).toBe(false)
  })
})

test("the blank agent view carries no session, so opening creates nothing", () => {
  const view = initialIslandView(true)
  expect(view).toEqual({ name: "agent" })
  expect("sessionId" in view).toBe(false)
})

test("the fallback agent name is Shogo", () => {
  expect(DEFAULT_AGENT_NAME).toBe("Shogo")
})
