// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { act, renderHook } from "@testing-library/react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({ Platform: { OS: "web", select: (s: any) => s.web ?? s.default } as any }),
)

const { useIdeBridge, parseIdeReferences } = await import("../ideBridge")
const bus = await import("../../../lib/chat-insert-bus")

const posted: any[] = []
const originalPostMessage = window.parent.postMessage

beforeEach(() => {
  posted.length = 0
  bus._resetChatInsertBusForTests()
  ;(window.parent as any).postMessage = (message: unknown) => posted.push(message)
})
afterEach(() => {
  ;(window.parent as any).postMessage = originalPostMessage
  bus._resetChatInsertBusForTests()
})

function deliver(data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data }))
  })
}

const selection = {
  type: "selection",
  path: "src/big.ts",
  name: "big.ts",
  startLine: 120,
  endLine: 140,
  text: "const x = 1",
  languageId: "typescript",
}

describe("useIdeBridge — Shogo Code Add to Chat", () => {
  test("addReferences becomes a shogo-code insert request and is acknowledged with its batchId", () => {
    const seen: any[] = []
    bus.subscribeChatInsert((r) => seen.push(r))
    renderHook(() => useIdeBridge(true))
    deliver({ type: "shogo.ide.addReferences", batchId: "b1", references: [selection, { type: "file", path: "a.ts", name: "a.ts" }] })
    expect(seen).toHaveLength(1)
    expect(seen[0].source).toBe("shogo-code")
    expect(seen[0].references).toEqual([selection, { type: "file", path: "a.ts", name: "a.ts" }])
    expect(posted).toContainEqual({ type: "shogo.ide.referencesAck", batchId: "b1" })
  })

  test("a re-sent batch (after reconnect) is inserted once but acknowledged again", () => {
    const seen: any[] = []
    bus.subscribeChatInsert((r) => seen.push(r))
    renderHook(() => useIdeBridge(true))
    const msg = { type: "shogo.ide.addReferences", batchId: "b2", references: [selection] }
    deliver(msg)
    deliver(msg)
    expect(seen).toHaveLength(1)
    expect(posted.filter((m) => m.type === "shogo.ide.referencesAck")).toHaveLength(2)
  })

  test("malformed references are dropped", () => {
    const seen: any[] = []
    bus.subscribeChatInsert((r) => seen.push(r))
    renderHook(() => useIdeBridge(true))
    deliver({
      type: "shogo.ide.addReferences",
      batchId: "b3",
      references: [
        { type: "file", path: "", name: "x" },
        { type: "selection", path: "a.ts", name: "a.ts", startLine: 5, endLine: 2, text: "x" },
        { type: "selection", path: "a.ts", name: "a.ts", startLine: 1, endLine: 2, text: "  " },
        { type: "project", id: "p", name: "p", path: "p" },
        "nope",
        { type: "folder", path: "src", name: "src" },
      ],
    })
    expect(seen[0].references).toEqual([{ type: "folder", path: "src", name: "src" }])
  })

  test("an addReferences without a batchId is ignored", () => {
    const seen: any[] = []
    bus.subscribeChatInsert((r) => seen.push(r))
    renderHook(() => useIdeBridge(true))
    deliver({ type: "shogo.ide.addReferences", references: [selection] })
    expect(seen).toEqual([])
    expect(posted.some((m) => m.type === "shogo.ide.referencesAck")).toBe(false)
  })

  test("shogo.ide.context still parses activeFile / workspaceFolders / workspaceItems", () => {
    const { result } = renderHook(() => useIdeBridge(true))
    deliver({
      type: "shogo.ide.context",
      activeFile: { path: "src/a.ts", languageId: "typescript" },
      workspaceFolders: [{ name: "app", path: "" }],
      workspaceItems: [{ type: "file", path: "src/a.ts", name: "a.ts" }],
    })
    expect(result.current.isConnected).toBe(true)
    expect(result.current.context).toEqual({
      activeFile: { path: "src/a.ts", languageId: "typescript" },
      workspaceFolders: [{ name: "app", path: "" }],
      workspaceItems: [{ type: "file", path: "src/a.ts", name: "a.ts" }],
    })
  })

  test("disabled bridges ignore Shogo Code messages", () => {
    const seen: any[] = []
    bus.subscribeChatInsert((r) => seen.push(r))
    renderHook(() => useIdeBridge(false))
    deliver({ type: "shogo.ide.addReferences", batchId: "b4", references: [selection] })
    expect(seen).toEqual([])
  })
})

describe("parseIdeReferences", () => {
  test("keeps the optional selection fields", () => {
    expect(parseIdeReferences([{ ...selection, truncated: true }])).toEqual([{ ...selection, truncated: true }])
    expect(parseIdeReferences("x")).toEqual([])
  })
})
