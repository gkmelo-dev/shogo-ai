// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ChatReferenceInput } from "./chat-references";

/**
 * Hands "Add to Chat" requests (file tree, editor ⌘L, terminal ⌘L, Shogo
 * Code) to the active chat composer. Requests made while no composer is
 * mounted — e.g. a narrow layout showing only the IDE — are queued and
 * applied when one subscribes.
 */

export type ChatInsertSource = "ide-tree" | "ide-editor" | "terminal" | "shogo-code";

export interface ChatInsertRequest {
  references?: ChatReferenceInput[];
  /** Plain text inserted verbatim (terminal output). */
  text?: string;
  source: ChatInsertSource;
}

export type ChatInsertHandler = (request: ChatInsertRequest) => void;

export const MAX_QUEUED_CHAT_INSERTS = 50;
/** Dispatched by packages/desktop-terminal's Add to Chat button (`detail: { text }`). */
export const TERMINAL_ADD_TO_CHAT_EVENT = "shogo:add-to-chat";

const queue: ChatInsertRequest[] = [];
// The most recent subscriber is active; an older one takes over again when
// the newer one unsubscribes (e.g. a chat tab closing).
const subscribers: ChatInsertHandler[] = [];
const observers = new Set<ChatInsertHandler>();

export function requestChatInsert(request: ChatInsertRequest): void {
  ensureWindowAdapter();
  for (const observer of observers) observer(request);
  const active = subscribers[subscribers.length - 1];
  if (active) {
    active(request);
    return;
  }
  queue.push(request);
  if (queue.length > MAX_QUEUED_CHAT_INSERTS) queue.splice(0, queue.length - MAX_QUEUED_CHAT_INSERTS);
}

/** Subscribe the active composer; queued requests are delivered synchronously, in order. */
export function subscribeChatInsert(handler: ChatInsertHandler): () => void {
  ensureWindowAdapter();
  subscribers.push(handler);
  while (queue.length > 0 && subscribers[subscribers.length - 1] === handler) handler(queue.shift()!);
  return () => {
    const i = subscribers.lastIndexOf(handler);
    if (i !== -1) subscribers.splice(i, 1);
  };
}

export function hasChatInsertSubscriber(): boolean {
  return subscribers.length > 0;
}

/**
 * Notified of every request before it is delivered or queued, without
 * consuming it — e.g. the project layout reveals a collapsed chat panel.
 */
export function onChatInsertRequested(observer: ChatInsertHandler): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

const ADAPTER_FLAG = "__shogoChatInsertAdapterInstalled";

/** Routes the terminal's window event through the bus, once per window (idempotent across module copies). */
export function ensureWindowAdapter(): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  const w = window as unknown as Record<string, unknown>;
  if (w[ADAPTER_FLAG]) return;
  w[ADAPTER_FLAG] = true;
  window.addEventListener(TERMINAL_ADD_TO_CHAT_EVENT, (event: Event) => {
    const text = (event as CustomEvent<{ text?: string }>).detail?.text?.trim();
    if (text) requestChatInsert({ text, source: "terminal" });
  });
}

ensureWindowAdapter();

/** Test-only: drop queued requests and subscribers. */
export function _resetChatInsertBusForTests(): void {
  queue.length = 0;
  subscribers.length = 0;
  observers.clear();
}
