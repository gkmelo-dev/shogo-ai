// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-52: pressing a chat chip opens the chat's own workspace.
 *
 * A chat tagged from another workspace must switch to it first — the chat
 * screens read the active workspace, and a send from the wrong one is rejected
 * server-side (`session_not_in_workspace`). The chip carries `workspaceId` for
 * exactly that reason.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render } from "@testing-library/react"
import React, { createElement, forwardRef } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

// react-native's `Text` in the shared mock drops `onPress`; map it to a DOM
// click so a chip press can be driven from the test.
const PressableText = forwardRef(function PressableText(props: any, ref: any) {
  const { onPress, children, ...rest } = props
  return createElement("span", { ...rest, ref, onClick: onPress }, children)
})

mock.module("react-native", () =>
  createReactNativeMock({ Text: PressableText }),
)

const openInWorkspace = mock((..._args: any[]) => {})
mock.module("../../../lib/switch-workspace", () => ({ openInWorkspace }))

const push = mock((..._args: any[]) => {})
mock.module("expo-router", () => ({ useRouter: () => ({ push }) }))

mock.module("../../../contexts/domain", () => ({
  useProjectCollection: () => projectCollection,
  useWorkspaceCollection: () => ({ all: [] }),
}))

mock.module("../../../hooks/useActiveWorkspace", () => ({
  useActiveWorkspace: () => ({ id: "ws-a" }),
}))

const projectCollection = { clear: mock(() => {}), loadAll: mock(async () => {}) }

const { ChatMentionChip, chatMentionHref, ChatMentionText } = await import(
  "../ChatMentionChip"
)

afterEach(() => {
  cleanup()
  openInWorkspace.mockClear()
  push.mockClear()
})

describe("chat mention chip", () => {
  test("a workspace chat opens the workspace agent with that session", () => {
    expect(chatMentionHref({ id: "chat-b", projectId: null })).toBe(
      "/(app)/agent?chatSessionId=chat-b",
    )
  })

  test("a project chat opens its project surface with that session", () => {
    expect(chatMentionHref({ id: "chat-b", projectId: "proj-2" })).toBe(
      "/(app)/projects/proj-2?chatSessionId=chat-b",
    )
  })

  test("pressing a chip for another workspace switches to it", () => {
    const { getByText } = render(
      <ChatMentionChip
        id="chat-b"
        meta={{
          id: "chat-b",
          title: "Deploy notes",
          projectId: null,
          workspaceId: "ws-b",
          workspaceName: "Other team",
        }}
      />,
    )

    fireEvent.click(getByText(/@Deploy notes/))

    expect(openInWorkspace).toHaveBeenCalledTimes(1)
    expect(openInWorkspace.mock.calls[0][1]).toBe("ws-b")
    expect(openInWorkspace.mock.calls[0][2]).toBe("/(app)/agent?chatSessionId=chat-b")
    expect(openInWorkspace.mock.calls[0][3]).toBe("ws-a")
    expect(push).not.toHaveBeenCalled()
  })

  test("pressing a chip in the active workspace stays on a plain push", () => {
    const { getByText } = render(
      <ChatMentionChip
        id="chat-a"
        meta={{ id: "chat-a", title: "Billing bug", projectId: null, workspaceId: "ws-a" }}
      />,
    )

    fireEvent.click(getByText(/@Billing bug/))

    expect(openInWorkspace).toHaveBeenCalledTimes(1)
    expect(openInWorkspace.mock.calls[0][1]).toBe("ws-a")
    expect(openInWorkspace.mock.calls[0][3]).toBe("ws-a")
  })

  test("the status label rides along with the title", () => {
    const { container } = render(
      <ChatMentionChip
        id="chat-b"
        meta={{ id: "chat-b", title: "Deploy notes", workspaceId: "ws-b" }}
        status={{ queued: 1, working: false, repliedAt: null }}
      />,
    )

    expect(container.textContent).toBe("@Deploy notes · queued")
  })

  test("a message body renders one chip per distinct tag", () => {
    const { container } = render(
      <ChatMentionText text="see <@c:chat-b> and <@c:chat-c>" />,
    )
    const chips = Array.from(container.querySelectorAll("span")).filter((node) =>
      node.textContent?.startsWith("@"),
    )
    expect(chips.map((node) => node.textContent)).toEqual([
      "@chat chat-b",
      "@chat chat-c",
    ])
  })
})
