// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P3 — §3a scoping and the Zernio webhook ingress.
 *
 * Two things are proved here against a real SQLite DB (migrations replayed)
 * and a fake provider: a desktop's second local workspace gets its own profile
 * instead of colliding on the unique columns, and a signed webhook is routed to
 * the scope its `externalId` names — emitted in place for the cloud scope,
 * relayed to the desktop for a local one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

process.env.ZERNIO_WEBHOOK_SECRET = 'whsec_sho71'

const { prisma } = await import('../../lib/prisma')
const { socialRelayRoutes, socialEventRoutes, socialWebhookRoutes } = await import('../social')
const { setSocialClient } = await import('../../services/social/client')
const { getSyncEngine } = await import('../../lib/sync-engine')

const db = prisma as any

/** A signed request through the relay route, scoped to `workspaceId` + `localScope`. */
const app = new Hono()
app.use('*', async (c, next) => {
  const workspaceId = c.req.header('x-workspace')
  c.set('auth', { workspaceId, isAuthenticated: !!workspaceId } as never)
  await next()
})
app.route('/api', socialRelayRoutes())
app.route('/api', socialWebhookRoutes())
app.route(
  '/api',
  socialEventRoutes({ authorize: async (c) => (c.req.header('x-runtime-token') === 'rt_ok' ? {} : null) }),
)

const relay = (path: string, workspaceId: string, localScope: string | null, init: RequestInit = {}) =>
  app.request(`/api/social-relay${path}`, {
    ...init,
    headers: {
      'x-workspace': workspaceId,
      ...(localScope ? { 'x-shogo-local-workspace': localScope } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  })

const suffix = crypto.randomUUID().slice(0, 8)
let cloudWorkspace = ''
let desktopLocalA = ''
let desktopLocalB = ''
let zernioProfileSeq = 0
const calls: any[] = []

const signedHook = (body: string, eventId: string, secret = 'whsec_sho71') =>
  app.request('/api/webhooks/zernio', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-zernio-event-id': eventId,
      'x-zernio-signature': createHmac('sha256', secret).update(body).digest('hex'),
    },
  })

const zernioEvent = (externalId: string, type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type,
    profiles: [{ id: 'zp', externalId }],
    account: { id: 'acc_hook', platform: 'instagram', username: 'hook.ig' },
    ...extra,
  })

beforeAll(async () => {
  const [cloud, localA, localB] = await Promise.all([
    db.workspace.create({ data: { name: 'Cloud', slug: `cloud-${suffix}`, kind: 'team' } }),
    db.workspace.create({ data: { name: 'Local A', slug: `local-a-${suffix}`, kind: 'team' } }),
    db.workspace.create({ data: { name: 'Local B', slug: `local-b-${suffix}`, kind: 'team' } }),
  ])
  cloudWorkspace = cloud.id
  desktopLocalA = localA.id
  desktopLocalB = localB.id

  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      if (req.method === 'POST' && req.path === '/profiles') {
        return { id: `zernio_created_${++zernioProfileSeq}`, externalId: req.body.externalId }
      }
      return { id: 'zernio_created', ...req.body }
    },
  })
})

afterAll(() => {
  setSocialClient(null)
})

describe('§3a — one Zernio profile per local workspace', () => {
  test('a second local workspace gets its own profile instead of a constraint error', async () => {
    calls.length = 0
    const first = await relay('/profiles', cloudWorkspace, desktopLocalA, {
      method: 'POST',
      body: JSON.stringify({ name: 'Local A' }),
    })
    expect(first.status).toBe(200)
    expect(calls[0].body.externalId).toBe(`lws_${desktopLocalA}`)

    const second = await relay('/profiles', cloudWorkspace, desktopLocalB, {
      method: 'POST',
      body: JSON.stringify({ name: 'Local B' }),
    })
    expect(second.status).toBe(200)
    expect(calls[1].body.externalId).toBe(`lws_${desktopLocalB}`)

    const rows = await db.socialProfile.findMany({ where: { workspaceId: cloudWorkspace } })
    expect(rows.map((row: any) => row.localWorkspaceId).sort()).toEqual([desktopLocalA, desktopLocalB].sort())
    expect(rows.map((row: any) => row.externalId).sort()).toEqual(
      [`lws_${desktopLocalA}`, `lws_${desktopLocalB}`].sort(),
    )
    expect(new Set(rows.map((row: any) => row.zernioProfileId)).size).toBe(2)
  })

  test('the same local scope re-connects to the same row and the same routing id', async () => {
    const before = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: cloudWorkspace, localWorkspaceId: desktopLocalA } },
    })
    const again = await relay('/profiles', cloudWorkspace, desktopLocalA, {
      method: 'POST',
      body: JSON.stringify({ name: 'Local A again' }),
    })
    expect(again.status).toBe(200)
    const after = await db.socialProfile.findUnique({
      where: { workspaceId_localWorkspaceId: { workspaceId: cloudWorkspace, localWorkspaceId: desktopLocalA } },
    })
    expect(after.id).toBe(before.id)
    expect(after.externalId).toBe(`lws_${desktopLocalA}`)
    expect(await db.socialProfile.count({ where: { workspaceId: cloudWorkspace } })).toBe(2)
  })

  test('a read is pinned to the caller’s own scope, never the cloud one', async () => {
    calls.length = 0
    const res = await relay('/profiles', cloudWorkspace, desktopLocalB)
    expect(res.status).toBe(200)
    expect(calls[0].query).toEqual({ externalId: `lws_${desktopLocalB}` })
  })

  test('a rename changes the name, never the routing id', async () => {
    const { renameProfile } = await import('../../services/social/profiles.service')
    const where = { workspaceId: cloudWorkspace, localWorkspaceId: desktopLocalA }
    const before = await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: where } })

    await renameProfile(cloudWorkspace, 'Renamed A')

    const after = await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: where } })
    expect(after.name).toBe('Renamed A')
    expect(after.externalId).toBe(before.externalId)
    expect(after.zernioProfileId).toBe(before.zernioProfileId)
  })

  test('a local scope that is not a workspace id is refused before any provider call', async () => {
    calls.length = 0
    const res = await relay('/profiles', cloudWorkspace, 'not-a-uuid')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_local_workspace')
    expect(calls.length).toBe(0)
  })
})

describe('webhook ingress', () => {
  beforeAll(async () => {
    await db.socialProfile.create({
      data: {
        workspaceId: cloudWorkspace,
        localWorkspaceId: '',
        zernioProfileId: 'zernio_cloud_scope',
        externalId: `ws_${cloudWorkspace}`,
        name: 'Cloud',
      },
    })
    await db.socialAccount.create({
      data: {
        workspaceId: cloudWorkspace,
        profileId: (
          await db.socialProfile.findUnique({
            where: { workspaceId_localWorkspaceId: { workspaceId: cloudWorkspace, localWorkspaceId: '' } },
          })
        ).id,
        zernioAccountId: 'acc_hook',
        platform: 'instagram',
        username: 'hook.ig',
      },
    })
  })

  test('an unsigned or wrongly signed delivery is rejected', async () => {
    const body = zernioEvent(`ws_${cloudWorkspace}`, 'comment.received')
    const unsigned = await app.request('/api/webhooks/zernio', { method: 'POST', body })
    expect(unsigned.status).toBe(401)
    const wrong = await signedHook(body, 'evt_bad', 'not-the-secret')
    expect(wrong.status).toBe(401)
  })

  test('a cloud-scope comment is emitted as social.comment.received, once per event id', async () => {
    const eventId = `evt_${crypto.randomUUID()}`
    const body = zernioEvent(`ws_${cloudWorkspace}`, 'comment.received', {
      comment: { id: 'cmt_1', text: 'MERGE' },
    })

    const first = await signedHook(body, eventId)
    expect(first.status).toBe(200)
    expect((await first.json()).type).toBe('social.comment.received')

    const emitted = await db.workspaceEvent.findUnique({
      where: { workspaceId_dedupeKey: { workspaceId: cloudWorkspace, dedupeKey: `zernio:${eventId}` } },
    })
    expect(emitted.type).toBe('social.comment.received')
    expect(emitted.source).toBe('zernio')
    expect(emitted.payload.externalId).toBe(`ws_${cloudWorkspace}`)
    expect(emitted.payload.comment).toEqual({ id: 'cmt_1', text: 'MERGE' })

    // Zernio retries 7×: the same event id must not fan out twice.
    const replay = await signedHook(body, eventId)
    expect(replay.status).toBe(200)
    expect((await replay.json()).duplicate).toBe(true)
    expect(
      await db.workspaceEvent.count({
        where: { workspaceId: cloudWorkspace, dedupeKey: `zernio:${eventId}` },
      }),
    ).toBe(1)
  })

  test('account.disconnected flips the account to needs-reconnect', async () => {
    const res = await signedHook(
      zernioEvent(`ws_${cloudWorkspace}`, 'account.disconnected'),
      `evt_${crypto.randomUUID()}`,
    )
    expect(res.status).toBe(200)
    const row = await db.socialAccount.findUnique({ where: { zernioAccountId: 'acc_hook' } })
    expect(row.needsReconnect).toBe(true)
    expect(row.isActive).toBe(false)
  })

  test('a local-scope event is relayed to that desktop and writes nothing in the cloud', async () => {
    const externalId = `lws_${desktopLocalA}`
    const eventId = `evt_${crypto.randomUUID()}`
    const seen: any[] = []
    const unsubscribe = getSyncEngine().subscribe('test-desktop', cloudWorkspace, 'desktop', (event) => {
      seen.push(event)
    })

    const res = await signedHook(
      zernioEvent(externalId, 'message.received', { message: { id: 'msg_1', text: 'hi' } }),
      eventId,
    )
    unsubscribe()

    expect(res.status).toBe(200)
    expect((await res.json()).relayed).toBe(desktopLocalA)
    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe('SOCIAL_EVENT')
    expect(seen[0].payload.localWorkspaceId).toBe(desktopLocalA)
    expect(seen[0].payload.eventId).toBe(eventId)

    // The cloud owns no rows for a local scope: it cannot apply what it does not store.
    expect(
      await db.workspaceEvent.count({ where: { workspaceId: cloudWorkspace, dedupeKey: `zernio:${eventId}` } }),
    ).toBe(0)
  })

  test('the desktop applies the relayed payload idempotently, in its own DB', async () => {
    const eventId = `evt_${crypto.randomUUID()}`
    const body = JSON.stringify({
      workspaceId: desktopLocalA,
      localWorkspaceId: desktopLocalA,
      externalId: `lws_${desktopLocalA}`,
      eventId,
      type: 'comment.received',
      account: { zernioAccountId: 'acc_local', platform: 'instagram', username: 'local.ig' },
      detail: { id: 'cmt_9', text: 'MERGED' },
    })
    const post = (token: string | null) =>
      app.request('/api/social/events', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-runtime-token': token } : {}),
        },
      })

    expect((await post(null)).status).toBe(401)

    const first = await post('rt_ok')
    expect(first.status).toBe(200)
    expect((await first.json()).type).toBe('social.comment.received')

    const second = await post('rt_ok')
    expect((await second.json()).duplicate).toBe(true)
    expect(
      await db.workspaceEvent.count({ where: { workspaceId: desktopLocalA, dedupeKey: `zernio:${eventId}` } }),
    ).toBe(1)
  })

  test('an unknown profile is accepted and dropped, never a 404 the provider would retry', async () => {
    const res = await signedHook(
      zernioEvent(`ws_${crypto.randomUUID()}`, 'comment.received'),
      `evt_${crypto.randomUUID()}`,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe('unknown_profile')
  })

  test('a malformed local routing id is a 400 and writes nothing', async () => {
    const res = await signedHook(
      zernioEvent('lws_not-a-uuid', 'comment.received'),
      `evt_${crypto.randomUUID()}`,
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_local_workspace')
  })
})
