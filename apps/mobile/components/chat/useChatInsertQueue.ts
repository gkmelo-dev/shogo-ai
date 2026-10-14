// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useEffect, useRef, useState } from "react"
import { Platform } from "react-native"
import { subscribeChatInsert } from "../../lib/chat-insert-bus"
import type { ChatInsertComposerRequest } from "./ChatInput"

/**
 * Feeds "Add to Chat" requests (IDE tree/editor, terminal ⌘L, Shogo Code —
 * see lib/chat-insert-bus.ts) to the active panel's composer, one at a time.
 * Requests queue here while the composer is unmounted (collapsed chat), and
 * `expand` is called so it mounts and shows them.
 */
export function useChatInsertQueue({ isActive, expand }: { isActive: boolean; expand: () => void }) {
  const [queue, setQueue] = useState<ChatInsertComposerRequest[]>([])
  const nonceRef = useRef(0)
  const expandRef = useRef(expand)
  expandRef.current = expand

  useEffect(() => {
    if (Platform.OS !== "web" || !isActive) return
    return subscribeChatInsert((request) => {
      if (!request.references?.length && !request.text?.trim()) return
      expandRef.current()
      setQueue((current) => [
        ...current,
        { nonce: ++nonceRef.current, references: request.references, text: request.text },
      ])
    })
  }, [isActive])

  const markApplied = useCallback((nonce: number) => {
    setQueue((current) => current.filter((request) => request.nonce !== nonce))
  }, [])

  return { insertRequest: queue[0] ?? null, markApplied }
}
