// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, test } from "bun:test"
import {
  _resetChatInsertBusForTests,
  ensureWindowAdapter,
  hasChatInsertSubscriber,
  MAX_QUEUED_CHAT_INSERTS,
  onChatInsertRequested,
  requestChatInsert,
  subscribeChatInsert,
  TERMINAL_ADD_TO_CHAT_EVENT,
  type ChatInsertRequest,
} from "../chat-insert-bus"

const req = (text: string): ChatInsertRequest => ({ text, source: "ide-editor" })

beforeEach(() => _resetChatInsertBusForTests())

describe("chat insert bus", () => {
  test("queues while nobody listens and drains on subscribe, in order", () => {
    requestChatInsert(req("a"))
    requestChatInsert(req("b"))
    const seen: string[] = []
    subscribeChatInsert((r) => seen.push(r.text!))
    expect(seen).toEqual(["a", "b"])
    requestChatInsert(req("c"))
    expect(seen).toEqual(["a", "b", "c"])
  })

  test(`keeps at most ${MAX_QUEUED_CHAT_INSERTS} queued requests, dropping the oldest`, () => {
    for (let i = 0; i < MAX_QUEUED_CHAT_INSERTS + 7; i++) requestChatInsert(req(String(i)))
    const seen: string[] = []
    subscribeChatInsert((r) => seen.push(r.text!))
    expect(seen.length).toBe(MAX_QUEUED_CHAT_INSERTS)
    expect(seen[0]).toBe("7")
  })

  test("the last subscriber wins; unsubscribing hands back to the previous one, then to the queue", () => {
    const a: string[] = []
    const b: string[] = []
    const offA = subscribeChatInsert((r) => a.push(r.text!))
    const offB = subscribeChatInsert((r) => b.push(r.text!))
    expect(hasChatInsertSubscriber()).toBe(true)
    requestChatInsert(req("1"))
    offB()
    requestChatInsert(req("2"))
    offA()
    expect(hasChatInsertSubscriber()).toBe(false)
    requestChatInsert(req("3"))
    expect(a).toEqual(["2"])
    expect(b).toEqual(["1"])
    const later: string[] = []
    subscribeChatInsert((r) => later.push(r.text!))
    expect(later).toEqual(["3"])
  })

  test("observers see every request, delivered or queued, without consuming it", () => {
    const observed: string[] = []
    const off = onChatInsertRequested((r) => observed.push(r.text!))
    requestChatInsert(req("queued"))
    const delivered: string[] = []
    subscribeChatInsert((r) => delivered.push(r.text!))
    requestChatInsert(req("live"))
    expect(observed).toEqual(["queued", "live"])
    expect(delivered).toEqual(["queued", "live"])
    off()
    requestChatInsert(req("after"))
    expect(observed).toEqual(["queued", "live"])
    expect(delivered).toEqual(["queued", "live", "after"])
  })

  test("the terminal's window event becomes a terminal text request", () => {
    const seen: ChatInsertRequest[] = []
    subscribeChatInsert((r) => seen.push(r))
    window.dispatchEvent(new CustomEvent(TERMINAL_ADD_TO_CHAT_EVENT, { detail: { text: "  $ ls -la  " } }))
    window.dispatchEvent(new CustomEvent(TERMINAL_ADD_TO_CHAT_EVENT, { detail: { text: "   " } }))
    expect(seen).toEqual([{ text: "$ ls -la", source: "terminal" }])
  })

  test("the window adapter is installed only once", () => {
    // Re-running it (HMR, a duplicate module copy) must not add a second listener.
    ensureWindowAdapter()
    ensureWindowAdapter()
    const seen: ChatInsertRequest[] = []
    subscribeChatInsert((r) => seen.push(r))
    window.dispatchEvent(new CustomEvent(TERMINAL_ADD_TO_CHAT_EVENT, { detail: { text: "once" } }))
    expect(seen).toHaveLength(1)
  })
})
