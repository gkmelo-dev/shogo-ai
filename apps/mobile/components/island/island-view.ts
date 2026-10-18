// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The island's view stack. Opening the notch lands on a blank workspace-agent
 * chat; the inbox is a secondary view reached from the header, and projects
 * and project chats hang off it.
 */

import { isWorkspaceAgentId, type IslandFileRef } from "./types"
import type { IslandInitialSend } from "./IslandChatHost"

export type IslandView =
  /** Blank workspace-agent chat: no session until the first send. */
  | { name: "agent" }
  | { name: "inbox" }
  | {
      name: "project"
      projectId: string
      projectName: string
      initialFiles?: IslandFileRef[]
    }
  | {
      name: "chat"
      projectId: string
      projectName: string
      sessionId: string
      title: string
      initialSend?: IslandInitialSend
      initialFiles?: IslandFileRef[]
    }
  | { name: "drop"; files: IslandFileRef[]; returnTo: IslandView }

/** The view the card shows when it opens, or undefined for today's inbox
 * behaviour when the workspace runtime is off. */
export function initialIslandView(workspaceAgentEnabled: boolean): IslandView {
  return workspaceAgentEnabled ? { name: "agent" } : { name: "inbox" }
}

/** True for a chat that belongs to the workspace agent rather than a project. */
export function isWorkspaceAgentChat(view: IslandView): boolean {
  return view.name === "chat" && isWorkspaceAgentId(view.projectId)
}

/** Where Back goes from `view`; null means collapse the card. */
export function parentView(view: IslandView, workspaceAgentEnabled: boolean): IslandView | null {
  switch (view.name) {
    case "agent":
      return null
    case "inbox":
      return workspaceAgentEnabled ? { name: "agent" } : null
    case "drop":
      return view.returnTo
    case "project":
      return { name: "inbox" }
    case "chat":
      return isWorkspaceAgentChat(view)
        ? { name: "inbox" }
        : {
            name: "project",
            projectId: view.projectId,
            projectName: view.projectName,
          }
  }
}

/** Shown when the workspace agent has no profile name yet. */
export const DEFAULT_AGENT_NAME = "Shogo"
