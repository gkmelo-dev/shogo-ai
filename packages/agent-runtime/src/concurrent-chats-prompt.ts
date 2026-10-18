// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tells the agent which other chats are live in the same workspace, so it
 * stops assuming it has the project to itself. Chats share one working tree,
 * one dev database, one preview/dev server and its ports; their turns run in
 * parallel and their edits and commands land mid-turn.
 */

export interface ConcurrentChat {
  id: string
  /** Chat title, else the first user message trimmed, else `chat <id8>`. */
  label: string
  /** A turn is in flight right now. */
  running: boolean
  idleSeconds: number
}

const MAX_ROWS = 5
const LABEL_MAX_CHARS = 60

/** Resolve a chat's display label: title, else first user message, else the id. */
export function concurrentChatLabel(input: {
  id: string
  title?: string | null
  firstUserText?: string | null
}): string {
  const title = input.title?.trim()
  if (title) return title
  const first = input.firstUserText?.replace(/\s+/g, ' ').trim()
  if (first) {
    return first.length > LABEL_MAX_CHARS ? `${first.slice(0, LABEL_MAX_CHARS - 1).trimEnd()}…` : first
  }
  return `chat ${input.id.slice(0, 8)}`
}

function idleLabel(idleSeconds: number): string {
  const seconds = Math.max(0, Math.floor(idleSeconds))
  if (seconds < 60) return `idle ${seconds}s`
  if (seconds < 3600) return `idle ${Math.round(seconds / 60)}m`
  return `idle ${Math.round(seconds / 3600)}h`
}

/**
 * Build the "other chats" section, or `null` when this chat has the workspace
 * to itself (the common case must add zero prompt bytes).
 */
export function buildConcurrentChatsPrompt(
  chats: ConcurrentChat[],
  opts: { isolatedEdits?: boolean } = {},
): string | null {
  if (chats.length === 0) return null

  const ordered = [...chats].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1
    return a.idleSeconds - b.idleSeconds
  })
  const shown = ordered.slice(0, MAX_ROWS)
  const hidden = ordered.length - shown.length

  const lines: string[] = ['## Other chats in this workspace', 'These chats are open in this same workspace right now:']
  for (const chat of shown) {
    lines.push(`- "${chat.label}" — ${chat.running ? 'turn running now' : idleLabel(chat.idleSeconds)}`)
  }
  if (hidden > 0) lines.push(`(and ${hidden} more)`)

  lines.push('')
  if (opts.isolatedEdits) {
    lines.push('- They share one dev database, one preview/dev server and its ports with you; their commands land while you work.')
  } else {
    lines.push(
      '- They share one working tree, one dev database, one preview/dev server and its ports with you; their edits and commands land while you work.',
    )
    lines.push(
      '- A file you did not change, a dirty diff, a failing build or a restarted preview may be theirs — re-read before concluding your change broke or reverted something.',
    )
  }
  lines.push(
    '- Before a workspace-wide or destructive step (`prisma db push`, switching branch, mass edits, killing a process, restarting the server), say what you are about to do: another chat\'s turn may be using it.',
  )
  lines.push(
    '- You can see that these chats exist, not what they are saying. Do not invent their content; if it matters, ask the user.',
  )

  return lines.join('\n')
}
