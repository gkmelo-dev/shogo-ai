// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-52 HTTP surface: the composer's chat picker and the source chip's
 * delivery state. Access is decided per chat on the server, so these tests pin
 * the auth gate and the fact that an unopenable chat is never described.
 */

import { describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const openable = new Set(['chat-a', 'chat-b'])

mock.module('../lib/chat-mentionables', () => ({
  listChatMentionables: async (options: { ids?: string[]; excludeSessionId?: string }) => {
    const ids = (options.ids ?? [...openable]).filter(
      (id) => openable.has(id) && id !== options.excludeSessionId,
    )
    return ids.map((id) => ({
      id,
      title: id === 'chat-a' ? 'Deploy notes' : 'Billing bug',
      contextType: 'workspace',
      projectId: null,
      projectName: null,
      workspaceId: 'ws-1',
      workspaceName: 'Acme',
      lastActiveAt: '2026-10-19T12:00:00.000Z',
    }))
  },
  resolveChatForUser: async (_userId: string, chatId: string) =>
    openable.has(chatId) ? { id: chatId } : null,
}))

mock.module('../lib/prisma', () => ({
  prisma: {
    chatSession: {
      findMany: async () => [
        { id: 'chat-a', activeTurnId: 'turn-1', activeTurnHeartbeatAt: new Date() },
        { id: 'chat-b', activeTurnId: null, activeTurnHeartbeatAt: null },
      ],
    },
    chatQueuedMessage: {
      findMany: async () => [{ sessionId: 'chat-b' }],
    },
    chatMessage: {
      findMany: async () => [{ sessionId: 'chat-a', createdAt: new Date('2026-10-19T12:05:00Z') }],
    },
  },
}))

const { chatMentionRoutes } = await import('../routes/chat-mentions')

function appFor(userId: string | null) {
  const app = new Hono()
  app.route('/api', chatMentionRoutes({ resolveUserId: async () => userId }))
  return app
}

describe('GET /api/chat-mentionables', () => {
  test('requires authentication', async () => {
    expect((await appFor(null).request('/api/chat-mentionables?q=deploy')).status).toBe(401)
  })

  test('returns chats with their workspace so duplicates are distinguishable', async () => {
    const response = await appFor('user-1').request('/api/chat-mentionables?q=')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.chats.map((chat: any) => chat.id)).toEqual(['chat-a', 'chat-b'])
    expect(body.chats[0].workspaceName).toBe('Acme')
  })

  test('drops the chat the composer is already in', async () => {
    const response = await appFor('user-1').request('/api/chat-mentionables?exclude=chat-a')
    const body = await response.json()
    expect(body.chats.map((chat: any) => chat.id)).toEqual(['chat-b'])
  })

  test('resolves titles by id for chips in an old message', async () => {
    const response = await appFor('user-1').request('/api/chat-mentionables?ids=chat-b,gone')
    const body = await response.json()
    expect(body.chats.map((chat: any) => chat.id)).toEqual(['chat-b'])
  })
})

describe('GET /api/chat-mention-status', () => {
  test('requires authentication', async () => {
    expect((await appFor(null).request('/api/chat-mention-status?ids=chat-a')).status).toBe(401)
  })

  test('reports working, queued and replied for openable chats only', async () => {
    const response = await appFor('user-1').request(
      '/api/chat-mention-status?ids=chat-a,chat-b,not-mine&since=2026-10-19T12:00:00.000Z',
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Object.keys(body.statuses).sort()).toEqual(['chat-a', 'chat-b'])
    expect(body.statuses['chat-a']).toMatchObject({ working: true, queued: 0 })
    expect(body.statuses['chat-a'].repliedAt).toBeTruthy()
    expect(body.statuses['chat-b']).toMatchObject({ working: false, queued: 1, repliedAt: null })
  })

  test('returns nothing for ids the caller cannot open', async () => {
    const response = await appFor('user-1').request('/api/chat-mention-status?ids=not-mine')
    expect(await response.json()).toEqual({ statuses: {} })
  })
})
