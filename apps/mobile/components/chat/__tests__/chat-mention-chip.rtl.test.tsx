// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-52: pressing a chat chip opens the chat in the chat's own workspace.
 *
 * A chip tagged from another workspace must switch to it first — the chat
 * screens read the active workspace, and a send from the wrong one is rejected
 * server-side (`session_not_in_workspace`). The press also has to survive the
 * source turn finishing seconds later: that turn's clamp
 * (`shouldRestoreChatWorkspace`) must not put the app back in the workspace the
 * person just left.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render } from "@testing-library/react"
import React, { createElement, forwardRef } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

// react-native's `Text` in the shared mock drops `onPress`; map it to a DOM
// click so a chip press can be driven from the test. `Platform.OS: "ios"` keeps
// `openInWorkspace` on its native branch (persist + push) instead of a full
// `window.location` navigation.
const PressableText = forwardRef(function PressableText(props: any, ref: any) {
  const { onPress, children, ...rest } = props
  return createElement("span", { ...rest, ref, onClick: onPress }, children)
})

mock.module("react-native", () =>
  createReactNativeMock({ Text: PressableText, Platform: { OS: "ios" } }),
)

const push = mock((..._args: any[]) => {})
mock.module("expo-router", () => ({ useRouter: () => ({ push }) }))

// better-auth's expo client pings on construction; the chip only uses
// `$fetch` for title lookups, which these tests supply directly.
mock.module("../../../lib/auth-client", () => ({
  authClient: { $fetch: async () => ({ data: { chats: [] } }) },
}))

const projectCollection = { clear: mock(() => {}), loadAll: mock(async () => {}) }
mock.module("../../../contexts/domain", () => ({
  useProjectCollection: () => projectCollection,
  useWorkspaceCollection: () => ({ all: [] }),
}))

// Filled in below, after the mocked react-native is in place: the store and the
// switch helper must not load the real native modules.
const store = {
  get: (): string | null => null,
  set: (_id: string) => {},
}
mock.module("../../../hooks/useActiveWorkspace", () => ({
  useActiveWorkspace: () => ({ id: store.get() }),
}))

const storeModule = await import("../../../lib/workspace-store")
const switchModule = await import("../../../lib/switch-workspace")
store.get = storeModule.getActiveWorkspaceId
store.set = storeModule.setActiveWorkspaceId
const getActiveWorkspaceId = storeModule.getActiveWorkspaceId
const setActiveWorkspaceId = storeModule.setActiveWorkspaceId
const shouldRestoreChatWorkspace = switchModule.shouldRestoreChatWorkspace

const { ChatMentionChip, chatMentionHref, ChatMentionText } = await import(
  "../ChatMentionChip"
)

beforeEach(() => {
  setActiveWorkspaceId("ws-a")
  push.mockClear()
  projectCollection.clear.mockClear()
  projectCollection.loadAll.mockClear()
})

afterEach(() => {
  cleanup()
})

describe("chat mention chip", () => {
  test("a workspace chat carries its session and workspace", () => {
    expect(chatMentionHref({ id: "chat-b", projectId: null, workspaceId: "ws-b" })).toBe(
      "/(app)/agent?chatSessionId=chat-b&workspace=ws-b",
    )
  })

  test("a project chat opens its project surface with that session", () => {
    expect(
      chatMentionHref({ id: "chat-b", projectId: "proj-2", workspaceId: "ws-b" }),
    ).toBe("/(app)/projects/proj-2?chatSessionId=chat-b&workspace=ws-b")
  })

  test("a chat of unknown workspace opens on the session alone", () => {
    expect(chatMentionHref({ id: "chat-b", projectId: null })).toBe(
      "/(app)/agent?chatSessionId=chat-b",
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

    expect(getActiveWorkspaceId()).toBe("ws-b")
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][0]).toContain("workspace=ws-b")
    expect(projectCollection.clear).toHaveBeenCalled()
  })

  test("pressing a chip in the active workspace stays put", () => {
    const { getByText } = render(
      <ChatMentionChip
        id="chat-a"
        meta={{ id: "chat-a", title: "Billing bug", projectId: null, workspaceId: "ws-a" }}
      />,
    )

    fireEvent.click(getByText(/@Billing bug/))

    expect(getActiveWorkspaceId()).toBe("ws-a")
    expect(push).toHaveBeenCalledTimes(1)
    expect(projectCollection.clear).not.toHaveBeenCalled()
  })

  test("the source turn finishing does not undo the switch", () => {
    const { getByText } = render(
      <ChatMentionChip
        id="chat-b"
        meta={{ id: "chat-b", title: "Deploy notes", projectId: null, workspaceId: "ws-b" }}
      />,
    )

    fireEvent.click(getByText(/@Deploy notes/))
    expect(getActiveWorkspaceId()).toBe("ws-b")

    // The source chat's turn settles after the press. ChatPanel's onFinish sees
    // the finished session is no longer the live one and leaves the switch be.
    const restored = shouldRestoreChatWorkspace({
      chatWorkspaceId: "ws-a",
      activeWorkspaceId: getActiveWorkspaceId(),
      finishedSessionId: "chat-a",
      liveSessionId: "chat-b",
    })
    if (restored) setActiveWorkspaceId("ws-a")

    expect(restored).toBe(false)
    expect(getActiveWorkspaceId()).toBe("ws-b")
  })

  test("a finishing turn still restores its own workspace when nothing moved", () => {
    setActiveWorkspaceId("ws-b")

    expect(
      shouldRestoreChatWorkspace({
        chatWorkspaceId: "ws-a",
        activeWorkspaceId: getActiveWorkspaceId(),
        finishedSessionId: "chat-a",
        liveSessionId: "chat-a",
      }),
    ).toBe(true)
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
    const { container } = render(<ChatMentionText text="see <@c:chat-b> and <@c:chat-c>" />)
    const chips = Array.from(container.querySelectorAll("span")).filter((node) =>
      node.textContent?.startsWith("@"),
    )
    expect(chips.map((node) => node.textContent)).toEqual([
      "@chat chat-b",
      "@chat chat-c",
    ])
  })
})
