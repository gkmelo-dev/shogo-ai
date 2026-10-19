// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat tags in a message body (SHO-52).
 *
 * The wire form is `<@c:CHAT_ID>`; readers see `@Chat title` as a chip that
 * opens that chat. Titles are not in the message (a rename must not rewrite
 * history), so they come from `/api/chat-mentionables?ids=` and are cached for
 * the session. The source chip also shows delivery state — queued, working,
 * replied — polled from `/api/chat-mention-status`, so nobody has to refresh
 * to know the handoff landed.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Platform, Pressable, Text, type StyleProp, type TextStyle } from "react-native"
import { useRouter } from "expo-router"
import { API_URL } from "../../lib/api-url"
import { authClient } from "../../lib/auth-client"
import { openActiveChat } from "../../lib/open-active-chat"
import { chatIdsIn } from "../../lib/chat-mention-text"

export interface ChatMentionMeta {
  id: string
  title: string
  projectId?: string | null
  workspaceName?: string
}

interface ChatMentionStatus {
  queued: number
  working: boolean
  repliedAt: string | null
}

const CHAT_TOKEN_RE = /<@c:([A-Za-z0-9_-]+)>/g
const STATUS_POLL_MS = 5000

const metaCache = new Map<string, ChatMentionMeta>()
const metaListeners = new Set<() => void>()
let pendingIds = new Set<string>()
let pendingTimer: ReturnType<typeof setTimeout> | null = null

function notifyMeta() {
  for (const listener of metaListeners) listener()
}

function authHeaders(): Record<string, string> {
  if (Platform.OS === "web") return {}
  const cookie = (authClient as any).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

async function fetchMeta(ids: string[]) {
  const params = new URLSearchParams({ ids: ids.join(","), limit: String(ids.length) })
  const response = await fetch(`${API_URL}/api/chat-mentionables?${params}`, {
    headers: authHeaders(),
    credentials: Platform.OS === "web" ? "include" : undefined,
  } as any)
  if (!response.ok) return
  const data = await response.json().catch(() => null)
  for (const chat of Array.isArray(data?.chats) ? data.chats : []) {
    metaCache.set(chat.id, {
      id: chat.id,
      title: chat.title,
      projectId: chat.projectId,
      workspaceName: chat.workspaceName,
    })
  }
  // Cache the misses too, so a chat that was deleted does not refetch forever.
  for (const id of ids) {
    if (!metaCache.has(id)) metaCache.set(id, { id, title: `chat ${id.slice(0, 8)}` })
  }
  notifyMeta()
}

function requestMeta(id: string) {
  if (metaCache.has(id) || pendingIds.has(id)) return
  pendingIds.add(id)
  if (pendingTimer) return
  pendingTimer = setTimeout(() => {
    const ids = [...pendingIds]
    pendingIds = new Set()
    pendingTimer = null
    void fetchMeta(ids).catch(() => {
      for (const missing of ids) metaCache.set(missing, { id: missing, title: `chat ${missing.slice(0, 8)}` })
      notifyMeta()
    })
  }, 50)
}

/** Titles for the chat ids in `ids`, fetched once and shared across messages. */
export function useChatMentionMeta(ids: string[]): Record<string, ChatMentionMeta> {
  const key = ids.join(",")
  const [, force] = useState(0)
  useEffect(() => {
    const listener = () => force((n) => n + 1)
    metaListeners.add(listener)
    return () => {
      metaListeners.delete(listener)
    }
  }, [])
  useEffect(() => {
    for (const id of ids) requestMeta(id)
    // `key` captures the id list; `ids` is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return useMemo(() => {
    const out: Record<string, ChatMentionMeta> = {}
    for (const id of ids) {
      const meta = metaCache.get(id)
      if (meta) out[id] = meta
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, metaCache.size])
}

/**
 * Delivery state of the chats tagged in one message. Only polled for messages
 * the user sent (`since` = when it was sent); stops once every chat replied.
 */
function useChatMentionStatus(ids: string[], since?: string | number | Date | null) {
  const [statuses, setStatuses] = useState<Record<string, ChatMentionStatus>>({})
  const sinceIso = useMemo(() => {
    if (!since) return null
    const date = since instanceof Date ? since : new Date(since)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }, [since])
  const key = ids.join(",")

  useEffect(() => {
    if (!sinceIso || !key) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const params = new URLSearchParams({ ids: key, since: sinceIso })
        const response = await fetch(`${API_URL}/api/chat-mention-status?${params}`, {
          headers: authHeaders(),
          credentials: Platform.OS === "web" ? "include" : undefined,
        } as any)
        if (cancelled || !response.ok) return
        const data = await response.json().catch(() => null)
        if (cancelled) return
        const next = (data?.statuses ?? {}) as Record<string, ChatMentionStatus>
        setStatuses(next)
        const settled = ids.every((id) => next[id]?.repliedAt)
        if (!settled) timer = setTimeout(poll, STATUS_POLL_MS)
      } catch {
        if (!cancelled) timer = setTimeout(poll, STATUS_POLL_MS * 3)
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sinceIso])

  return statuses
}

function statusLabel(status?: ChatMentionStatus): string | null {
  if (!status) return null
  if (status.repliedAt) {
    const date = new Date(status.repliedAt)
    return Number.isNaN(date.getTime())
      ? "replied"
      : `replied ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
  }
  if (status.working) return "working"
  if (status.queued > 0) return "queued"
  return null
}

/** One chat chip: title from the cache, press opens the chat. */
export function ChatMentionChip({
  id,
  meta,
  status,
  inverted = false,
}: {
  id: string
  meta?: ChatMentionMeta
  status?: ChatMentionStatus
  inverted?: boolean
}) {
  const router = useRouter()
  const label = meta?.title ?? `chat ${id.slice(0, 8)}`
  const state = statusLabel(status)
  const open = useCallback(() => {
    openActiveChat(router, {
      chatSessionId: id,
      projectId: meta?.projectId ?? null,
    } as any)
  }, [router, id, meta?.projectId])

  return (
    <Text
      onPress={open}
      suppressHighlighting
      className={
        inverted
          ? "text-[13px] font-medium text-sky-100 underline"
          : "text-[13px] font-medium text-sky-600 underline dark:text-sky-300"
      }
    >
      @{label}
      {state ? <Text className="text-[11px] opacity-70">{` · ${state}`}</Text> : null}
    </Text>
  )
}

/**
 * A message body with its `<@c:ID>` tokens rendered as chips. Everything else
 * is plain text (user messages are not markdown).
 */
export function ChatMentionText({
  text,
  since,
  className,
  style,
  selectable,
  inverted = false,
}: {
  text: string
  since?: string | number | Date | null
  className?: string
  style?: StyleProp<TextStyle>
  selectable?: boolean
  inverted?: boolean
}) {
  const ids = useMemo(() => chatIdsIn(text), [text])
  const metas = useChatMentionMeta(ids)
  const statuses = useChatMentionStatus(ids, since)

  const segments = useMemo(() => {
    const out: Array<{ kind: "text"; value: string } | { kind: "chat"; id: string }> = []
    let last = 0
    for (const match of text.matchAll(CHAT_TOKEN_RE)) {
      const index = match.index ?? 0
      if (index > last) out.push({ kind: "text", value: text.slice(last, index) })
      out.push({ kind: "chat", id: match[1] })
      last = index + match[0].length
    }
    if (last < text.length) out.push({ kind: "text", value: text.slice(last) })
    return out
  }, [text])

  return (
    <Text className={className} style={style} selectable={selectable}>
      {segments.map((segment, index) =>
        segment.kind === "chat" ? (
          <ChatMentionChip
            key={`chat-${segment.id}-${index}`}
            id={segment.id}
            meta={metas[segment.id]}
            status={statuses[segment.id]}
            inverted={inverted}
          />
        ) : (
          <Text key={`text-${index}`}>{segment.value}</Text>
        ),
      )}
    </Text>
  )
}
