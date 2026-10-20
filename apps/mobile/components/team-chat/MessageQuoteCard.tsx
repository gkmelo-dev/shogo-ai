// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A link to another message, rendered as what it points at: who wrote it, when,
 * and the opening of the message — the way Slack and Discord show a quoted
 * message, instead of a URL you have to decode.
 *
 * The quote is built per viewer at render time from
 * `GET /api/conversation-messages/:id`, which already enforces membership and
 * per-message visibility, so a message someone can't read never reaches this
 * component. The server answers 404 for both "deleted" and "not yours" there,
 * and the card says the same neutral thing for either: naming which of the two
 * it was would tell a stranger what exists in a channel they're not in.
 */
import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { CornerDownRight, MessageSquare } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { teamChatApi, type ChatMessage } from '../../lib/team-chat-api'
import { formatShortTime } from '../../lib/team-chat-time'
import type { MessageQuote } from '../../lib/message-quotes'

const api = teamChatApi()

type QuoteState =
  | { status: 'loading' }
  | { status: 'ready'; message: ChatMessage }
  | { status: 'unavailable' }

function useQuotedMessage(messageId: string): QuoteState {
  const [state, setState] = useState<QuoteState>({ status: 'loading' })

  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    api
      .message(messageId)
      .then((message) => {
        if (live) setState({ status: 'ready', message })
      })
      .catch((err: { status?: number }) => {
        // 404 is the server's only answer for a message this viewer may not
        // read, deleted or elsewhere; anything else is worth retrying later.
        if (live) setState({ status: 'unavailable' })
        if (err?.status !== 404) console.warn('[message-quote] could not load quoted message:', err)
      })
    return () => {
      live = false
    }
  }, [messageId])

  return state
}

function authorName(message: ChatMessage): string {
  return message.author?.name ?? message.authorAgent?.name ?? 'Someone'
}

function excerpt(message: ChatMessage): string {
  const text = (message.text ?? '').replace(/\s+/g, ' ').trim()
  if (text) return text
  const count = message.attachments.length
  if (count) return count === 1 ? 'Shared a file' : `Shared ${count} files`
  return 'No preview for this message'
}

export interface MessageQuoteCardProps {
  quote: MessageQuote
  className?: string
}

export function MessageQuoteCard({ quote, className }: MessageQuoteCardProps) {
  const router = useRouter()
  const state = useQuotedMessage(quote.target.messageId)
  const { conversationId, messageId, threadRootId } = quote.target

  const open = () => {
    router.push({
      pathname: '/(app)/c/[conversationId]',
      params: { conversationId, msg: messageId, ...(threadRootId ? { thread: threadRootId } : {}) },
    } as never)
  }

  if (state.status === 'unavailable') {
    return (
      <View
        className={cn(
          'mt-1.5 max-w-[520px] flex-row items-start gap-2 rounded-md border-l-4 border-border bg-muted/30 py-2 pl-3 pr-2',
          className,
        )}
        testID="message-quote-unavailable"
      >
        <MessageSquare size={13} className="mt-0.5 text-muted-foreground" />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-muted-foreground">Message unavailable</Text>
          <Text className="mt-0.5 text-xs text-muted-foreground">
            It may have been deleted, or it's in a conversation you can't see.
          </Text>
        </View>
      </View>
    )
  }

  if (state.status === 'loading') {
    return (
      <View
        className={cn(
          'mt-1.5 max-w-[520px] rounded-md border-l-4 border-border bg-muted/30 py-2 pl-3 pr-2',
          className,
        )}
        testID="message-quote-loading"
      >
        <Text className="text-xs text-muted-foreground">Loading quoted message…</Text>
      </View>
    )
  }

  const { message } = state
  const deleted = !!message.deletedAt

  return (
    <Pressable
      onPress={deleted ? undefined : open}
      disabled={deleted}
      accessibilityRole={deleted ? undefined : 'link'}
      accessibilityLabel={`Quoted message from ${authorName(message)}`}
      className={cn(
        'mt-1.5 max-w-[520px] flex-row items-start gap-2 rounded-md border-l-4 border-primary/50 bg-muted/40 py-2 pl-3 pr-2',
        !deleted && 'active:bg-muted',
        className,
      )}
      testID="message-quote"
    >
      <CornerDownRight size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-baseline gap-1.5">
          <Text className="min-w-0 shrink text-sm font-semibold text-foreground" numberOfLines={1}>
            {authorName(message)}
          </Text>
          <Text className="text-[11px] text-muted-foreground">{formatShortTime(message.createdAt)}</Text>
        </View>
        <Text className="mt-0.5 text-sm text-muted-foreground" numberOfLines={3}>
          {deleted ? 'This message was deleted.' : excerpt(message)}
        </Text>
        {deleted ? null : (
          <Text className="mt-1 text-[11px] font-medium text-primary">Jump to message</Text>
        )}
      </View>
    </Pressable>
  )
}

/** Every quoted message in one body, in the order they appeared. */
export function MessageQuoteCards({ quotes, className }: { quotes: MessageQuote[]; className?: string }) {
  if (!quotes.length) return null
  return (
    <View className={cn('gap-1.5', className)} testID="message-quotes">
      {quotes.map((quote) => (
        <MessageQuoteCard key={`${quote.target.messageId}:${quote.href}`} quote={quote} />
      ))}
    </View>
  )
}
