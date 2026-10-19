// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 QA round 1, B1 — the cloud relay must not let one workspace's key
 * drive another tenant's Zernio resources. These cases run the real route with
 * a fake provider: the point is what the relay forwards, and what it refuses,
 * not what Zernio answers.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { socialRelayRoutes } = await import('../social')
const { setSocialClient, SocialError } = await import('../../services/social/client')

const db = prisma as any

const app = new Hono()
app.use('*', async (c, next) => {
  const workspaceId = c.req.header('x-workspace')
  c.set('auth', { workspaceId, isAuthenticated: !!workspaceId } as never)
  await next()
})
app.route('/api', socialRelayRoutes())

const relay = (path: string, workspaceId: string | null, init: RequestInit = {}) =>
  app.request(`/api/social-relay${path}`, {
    ...init,
    headers: {
      ...(workspaceId ? { 'x-workspace': workspaceId } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

const suffix = crypto.randomUUID().slice(0, 8)
let own = ''
let other = ''
const calls: any[] = []

beforeAll(async () => {
  const [ownWs, otherWs] = await Promise.all([
    db.workspace.create({ data: { name: 'Own', slug: `own-${suffix}`, kind: 'team' } }),
    db.workspace.create({ data: { name: 'Other', slug: `other-${suffix}`, kind: 'team' } }),
  ])
  own = ownWs.id
  other = otherWs.id

  await db.socialProfile.create({
    data: { workspaceId: own, zernioProfileId: 'zernio_own', externalId: own, name: 'Own' },
  })
  await db.socialProfile.create({
    data: { workspaceId: other, zernioProfileId: 'zernio_other', externalId: other, name: 'Other' },
  })
  await db.socialAccount.create({
    data: {
      workspaceId: own,
      profileId: (await db.socialProfile.findUnique({ where: { workspaceId: own } })).id,
      zernioAccountId: 'acct_own',
      platform: 'instagram',
      username: 'own.ig',
    },
  })
  await db.socialAccount.create({
    data: {
      workspaceId: other,
      profileId: (await db.socialProfile.findUnique({ where: { workspaceId: other } })).id,
      zernioAccountId: 'acct_other',
      platform: 'instagram',
      username: 'other.ig',
    },
  })

  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      if (req.path === '/profiles' && req.method === 'POST') {
        return { id: 'zernio_created', externalId: req.body.externalId }
      }
      if (req.path === '/accounts') {
        return { accounts: [{ id: 'acct_own', platform: 'instagram', username: 'own.ig' }] }
      }
      if (req.path === '/posts' && req.method === 'POST') {
        return { id: 'zernio_post_new', targets: [] }
      }
      return {}
    },
  })
})

afterAll(async () => {
  setSocialClient(null)
  await db.workspace.deleteMany({ where: { id: { in: [own, other] } } }).catch(() => {})
})

describe('relay tenant scoping', () => {
  test('a request without a resolved workspace is refused', async () => {
    const res = await relay('/profiles', null)
    expect(res.status).toBe(401)
  })

  test('listing profiles only ever asks for the caller’s external id', async () => {
    calls.length = 0
    const res = await relay('/profiles?externalId=victim', own)
    expect(res.status).toBe(200)
    expect(calls[0].query).toEqual({ externalId: own })
  })

  test('creating a profile forces the caller’s external id and records the mapping', async () => {
    calls.length = 0
    const res = await relay('/profiles', own, {
      method: 'POST',
      body: JSON.stringify({ name: 'Hijack', externalId: other }),
    })
    expect(res.status).toBe(200)
    expect(calls[0].body.externalId).toBe(own)

    const created = await db.socialProfile.findUnique({ where: { workspaceId: own } })
    expect(created.zernioProfileId).toBe('zernio_created')
  })

  test('another workspace’s account cannot be deleted through the relay', async () => {
    calls.length = 0
    const res = await relay('/accounts/acct_other', own, { method: 'DELETE' })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('account_out_of_scope')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  })

  test('the caller’s own account still deletes', async () => {
    calls.length = 0
    const res = await relay('/accounts/acct_own', own, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(calls.find((call) => call.method === 'DELETE')?.path).toBe('/accounts/acct_own')
  })

  test('publishing is pinned to the caller’s profile even when the body lies', async () => {
    calls.length = 0
    const res = await relay('/posts', own, {
      method: 'POST',
      body: JSON.stringify({ content: 'mine', profileId: 'zernio_other', platforms: [] }),
    })
    expect(res.status).toBe(200)
    const profile = await db.socialProfile.findUnique({ where: { workspaceId: own } })
    expect(calls[0].body.profileId).toBe(profile.zernioProfileId)
    expect(calls[0].body.profileId).not.toBe('zernio_other')
  })

  test('an unknown post id is refused before the provider sees it', async () => {
    calls.length = 0
    const res = await relay('/posts/zernio_post_unknown', own, {
      method: 'PATCH',
      body: JSON.stringify({ scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('post_out_of_scope')
    expect(calls).toHaveLength(0)
  })

  test('a post this workspace created can be rescheduled', async () => {
    // Created through the relay above, so the cloud recorded its ownership.
    expect(
      await db.socialPost.findFirst({ where: { workspaceId: own, zernioPostId: 'zernio_post_new' } }),
    ).toBeTruthy()
    calls.length = 0
    const res = await relay('/posts/zernio_post_new', own, {
      method: 'PATCH',
      body: JSON.stringify({ scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }),
    })
    expect(res.status).toBe(200)
    expect(calls.find((call) => call.method === 'PATCH')?.path).toBe('/posts/zernio_post_new')
  })

  test('paths outside the allowlist never reach the provider', async () => {
    calls.length = 0
    const res = await relay('/workflows', own, { method: 'POST', body: JSON.stringify({}) })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('relay_path_not_allowed')
    expect(calls).toHaveLength(0)
  })

  test('a provider failure keeps the API error shape', async () => {
    setSocialClient({
      mode: 'cloud',
      async request() {
        throw new SocialError(400, 'rate_limited', 'Instagram rate limited', { platform: 'instagram' })
      },
    })
    const res = await relay('/accounts', own)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('rate_limited')
    expect(body.error.message).toBe('Instagram rate limited')
    expect(body.error.platform).toBe('instagram')
  })
})
