// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P4 — the inbox routes through Hono against a real SQLite database.
 *
 * The service tests prove the behaviour; these prove the surface: a viewer may
 * read the inbox but not send as the account, a reply is a `201` with the
 * message the UI needs, and a thread belonging to another workspace is a `404`
 * rather than a leak.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { socialRoutes } = await import('../social')
const { setSocialClient } = await import('../../services/social/client')
const { ingestSocialEvent } = await import('../../services/social/inbox.service')

const db = prisma as any

const app = new Hono()
app.use('*', async (c, next) => {
  const userId = c.req.header('x-user')
  c.set('auth', { userId, isAuthenticated: !!userId } as never)
  await next()
})
app.route('/api', socialRoutes({ resolveUserId: async (c: any) => c.get('auth')?.userId ?? null }))

const request = (path: string, userId: string | null, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...(userId ? { 'x-user': userId } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

const suffix = crypto.randomUUID().slice(0, 8)
let owner = ''
let viewer = ''
let workspaceId = ''
let conversationId = ''

beforeAll(async () => {
  const [ownerUser, viewerUser] = await Promise.all([
    db.user.create({ data: { name: 'owner', email: `inbox-owner-${suffix}@example.com` } }),
    db.user.create({ data: { name: 'viewer', email: `inbox-viewer-${suffix}@example.com` } }),
  ])
  owner = ownerUser.id
  viewer = viewerUser.id

  const workspace = await db.workspace.create({
    data: { name: 'Inbox Routes', slug: `inbox-routes-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  await db.member.create({ data: { workspaceId, userId: owner, role: 'owner', projectId: null } })
  await db.member.create({ data: { workspaceId, userId: viewer, role: 'viewer', projectId: null } })

  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: `zp_${suffix}`,
      externalId: `ws_${workspaceId}`,
      name: 'Inbox Routes',
    },
  })
  await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: `zernio_${suffix}`,
      platform: 'instagram',
      username: `acme_${suffix}`,
      displayName: 'Acme',
    },
  })

  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      if (req.method === 'POST' && req.path.endsWith('/messages')) {
        return { data: { messageId: `out_${suffix}` } }
      }
      if (req.method === 'POST' && req.path.startsWith('/inbox/comments/')) {
        return { data: { commentId: `reply_${suffix}` } }
      }
      throw new Error(`unexpected ${req.method} ${req.path}`)
    },
  })

  const ingested = await ingestSocialEvent({
    workspaceId,
    type: 'message.received',
    account: { zernioAccountId: `zernio_${suffix}`, platform: 'instagram', username: `acme_${suffix}` },
    payload: {
      conversation: { id: `conv_${suffix}`, status: 'active' },
      message: {
        id: `msg_${suffix}`,
        conversationId: `conv_${suffix}`,
        platform: 'instagram',
        direction: 'incoming',
        text: 'Is this still in stock?',
        sender: { id: 'psid_1', name: 'Dana' },
        createdAt: '2026-10-19T21:00:00.000Z',
      },
    },
  })
  conversationId = ingested.conversationId!
})

afterAll(async () => {
  setSocialClient(null)
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
})

describe('inbox routes', () => {
  test('a member lists the inbox and its unread total', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/inbox`, owner)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.unread).toBe(1)
    expect(body.conversations).toHaveLength(1)
    expect(body.conversations[0]).toMatchObject({
      participantName: 'Dana',
      lastMessagePreview: 'Is this still in stock?',
    })
  })

  test('a thread returns its messages in order', async () => {
    const res = await request(
      `/api/workspaces/${workspaceId}/social/inbox/conversations/${conversationId}`,
      owner,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].direction).toBe('incoming')
  })

  test('a viewer can read but cannot send as the account', async () => {
    const read = await request(`/api/workspaces/${workspaceId}/social/inbox`, viewer)
    expect(read.status).toBe(200)

    const send = await request(
      `/api/workspaces/${workspaceId}/social/inbox/conversations/${conversationId}/messages`,
      viewer,
      { method: 'POST', body: JSON.stringify({ text: 'In stock!' }) },
    )
    expect(send.status).toBe(403)
  })

  test('an owner reply is a 201 carrying the stored message', async () => {
    const res = await request(
      `/api/workspaces/${workspaceId}/social/inbox/conversations/${conversationId}/messages`,
      owner,
      { method: 'POST', body: JSON.stringify({ text: 'Yes — in stock.' }) },
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.reply).toMatchObject({ providerMessageId: `out_${suffix}`, metered: false })
    expect(body.reply.messageId).toBeString()
  })

  test('an empty reply is a 400, a foreign thread is a 404', async () => {
    const empty = await request(
      `/api/workspaces/${workspaceId}/social/inbox/conversations/${conversationId}/messages`,
      owner,
      { method: 'POST', body: JSON.stringify({ text: '  ' }) },
    )
    expect(empty.status).toBe(400)

    const foreign = await request(
      `/api/workspaces/${workspaceId}/social/inbox/conversations/00000000-0000-4000-8000-000000000000`,
      owner,
    )
    expect(foreign.status).toBe(404)
  })

  test('marking the thread read clears the badge', async () => {
    const res = await request(
      `/api/workspaces/${workspaceId}/social/inbox/conversations/${conversationId}/read`,
      owner,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    expect((await res.json()).conversation.unreadCount).toBe(0)
  })

  test('comments list and reply end to end', async () => {
    const comment = await db.socialComment.create({
      data: {
        workspaceId,
        zernioCommentId: `cmt_${suffix}`,
        zernioPostId: `post_${suffix}`,
        platformPostId: `ig_${suffix}`,
        platform: 'instagram',
        text: 'MERGE',
        occurredAt: new Date('2026-10-19T20:00:00.000Z'),
      },
    })

    const list = await request(`/api/workspaces/${workspaceId}/social/comments`, owner)
    expect(list.status).toBe(200)
    expect((await list.json()).comments).toHaveLength(1)

    const reply = await request(`/api/workspaces/${workspaceId}/social/comments/${comment.id}/reply`, owner, {
      method: 'POST',
      body: JSON.stringify({ text: 'Merged — thanks!' }),
    })
    expect(reply.status).toBe(201)
    expect((await reply.json()).reply).toMatchObject({ commentId: comment.id, providerReplyId: `reply_${suffix}` })

    const stored = await db.socialComment.findUnique({ where: { id: comment.id } })
    expect(stored.status).toBe('replied')
  })

  test('an outsider cannot read the inbox', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/inbox`, 'nobody')
    expect(res.status).toBe(404)
  })
})
