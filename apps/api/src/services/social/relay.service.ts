// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tenant scoping for the cloud relay.
 *
 * The relay holds the master Zernio key, so it must never forward a caller's
 * raw operation. Every workspace shares Shogo's one Zernio account: without
 * scoping, any `shogo_sk_*` key could list every tenant's profiles or delete
 * another workspace's account. `planRelayRequest` is therefore a
 * **deny-by-default allowlist** that rewrites each permitted operation onto the
 * caller's own profile, and the route verifies the resource ids it returns.
 *
 * Scoping is derived from the caller's workspace id, never from the request:
 * `externalId` and `profileId` in a caller's body or query are discarded.
 */

import { prisma } from '../../lib/prisma'
import { SocialError, getSocialClient, type SocialClient } from './client'
import { externalIdFor, getProfile, recordProfileMapping, type SocialProfileRow } from './profiles.service'
import { planRelayRequest } from './relay-plan'
import { normalizeZernioAccount, upsertAccount } from './accounts.service'
import {
  assertSocialBudget,
  meterXPost,
  projectedConnectRawUsd,
  projectedPublishRawUsd,
} from './usage.service'

const db = prisma as any

/** Does this Zernio account belong to the workspace (locally, else live at Zernio)? */
async function accountBelongsToWorkspace(
  workspaceId: string,
  zernioAccountId: string,
  client: SocialClient,
  profile: SocialProfileRow,
): Promise<boolean> {
  const row = await db.socialAccount.findFirst({ where: { workspaceId, zernioAccountId } })
  if (row) return true
  const payload = await client.request<any>({
    method: 'GET',
    path: '/accounts',
    query: { profileId: profile.zernioProfileId },
  })
  const list = Array.isArray(payload) ? payload : (payload?.accounts ?? payload?.data ?? [])
  return list.some((account: any) => account?.id === zernioAccountId)
}

/** Does this Zernio post belong to the workspace? Every relayed create is recorded. */
async function postBelongsToWorkspace(workspaceId: string, zernioPostId: string): Promise<boolean> {
  const row = await db.socialPost.findFirst({ where: { workspaceId, zernioPostId } })
  return !!row
}

async function recordAccounts(workspaceId: string, profileId: string, payload: any): Promise<void> {
  const list = Array.isArray(payload) ? payload : (payload?.accounts ?? payload?.data ?? [])
  for (const raw of list) {
    const account = normalizeZernioAccount(raw)
    if (!account) continue
    try {
      await upsertAccount(workspaceId, profileId, account)
    } catch (err) {
      // Already bound to a different workspace is the only case worth ignoring:
      // it means the provider and our rows disagree, not that this call failed.
      if (!(err instanceof SocialError) || err.status !== 409) throw err
    }
  }
}

async function recordPost(
  workspaceId: string,
  localWorkspaceId: string,
  body: any,
  payload: any,
  key: string | undefined,
): Promise<void> {
  const zernioPostId = typeof payload?.id === 'string' ? payload.id : null
  if (!zernioPostId) return
  const scheduledFor = typeof body?.scheduledFor === 'string' ? new Date(body.scheduledFor) : null
  const mediaUrls = Array.isArray(body?.mediaUrls) ? body.mediaUrls : []
  const publishNow = body?.publishNow === true

  // The relay is where a broadcast is billed, so the cloud keeps the same
  // per-account legs the desktop wrote locally: without them the `social_x_api`
  // meter has nothing to claim and an X post composed on a desktop would never
  // be charged.
  const platforms: any[] = Array.isArray(body?.platforms) ? body.platforms : []
  const providerAccountIds = platforms
    .map((platform: any) => platform?.accountId)
    .filter((id: unknown): id is string => typeof id === 'string')
  const accounts = providerAccountIds.length
    ? await db.socialAccount.findMany({
        where: { workspaceId, zernioAccountId: { in: providerAccountIds } },
        select: { id: true, zernioAccountId: true },
      })
    : []
  const byProviderId = new Map(accounts.map((account: any) => [account.zernioAccountId, account.id]))
  const targets = platforms
    .map((platform: any) => {
      const accountId = byProviderId.get(platform?.accountId)
      if (!accountId || typeof platform?.platform !== 'string') return null
      return {
        accountId,
        platform: platform.platform,
        customContent: typeof platform.customContent === 'string' ? platform.customContent : null,
        // The relay only relays the create; per-target delivery status arrives
        // on the desktop that owns the post, so a scheduled leg stays `pending`.
        status: publishNow ? 'published' : 'pending',
      }
    })
    .filter((target): target is NonNullable<typeof target> => target !== null)

  let created: any = null
  try {
    created = await db.socialPost.create({
      data: {
        workspaceId,
        status: publishNow ? 'published' : 'scheduled',
        content: typeof body?.content === 'string' ? body.content : '',
        mediaJson: mediaUrls.length ? mediaUrls : null,
        scheduledFor: Number.isNaN(scheduledFor?.getTime() ?? NaN) ? null : scheduledFor,
        publishedAt: publishNow ? new Date() : null,
        zernioPostId,
        // Already unique per tenant; the prefix keeps a desktop's hash from
        // colliding with a cloud-composed post.
        idempotencyKey: `relay:${workspaceId}:${localWorkspaceId}:${key ?? zernioPostId}`,
        ...(targets.length ? { targets: { create: targets } } : {}),
      },
      include: { targets: { select: { id: true, platform: true } } },
    })
  } catch (err: any) {
    // The same relayed create arriving twice is one post and one charge.
    if (err?.code !== 'P2002') throw err
    return
  }

  for (const target of created?.targets ?? []) {
    if (target.platform !== 'x') continue
    await meterXPost(workspaceId, target.id)
  }
}

export interface RelayOutcome {
  status: number
  body: unknown
}

/**
 * Run one relayed operation for one scope of `workspaceId`. Resolves the
 * scope's profile, scopes the operation to it, verifies any resource id it
 * names, performs the call and records what the cloud needs for routing and
 * billing.
 *
 * `localWorkspaceId` comes from the caller's `X-Shogo-Local-Workspace` header
 * and is always read together with the workspace the key resolved to, so a
 * desktop's second local workspace gets its own profile instead of colliding
 * with the first. Resource ownership is still proved against the whole cloud
 * workspace: every local scope of a tenant belongs to that tenant.
 */
export async function relayOperation(args: {
  workspaceId: string
  localWorkspaceId?: string
  method: string
  path: string
  query: Record<string, string>
  body: any
  idempotencyKey?: string
}): Promise<RelayOutcome> {
  const localWorkspaceId = args.localWorkspaceId ?? ''
  const externalId = externalIdFor(args.workspaceId, localWorkspaceId)
  const profile = await getProfile(args.workspaceId, localWorkspaceId)
  const plan = planRelayRequest({ ...args, localWorkspaceId, externalId, profile })

  if (plan.kind === 'deny') {
    const error = new SocialError(plan.status, plan.code, plan.message)
    return { status: plan.status, body: error.toJSON() }
  }

  const client = getSocialClient()
  if (client.mode === 'relay') {
    throw new SocialError(500, 'relay_loop', 'The relay host is itself in relay mode')
  }

  if (plan.verifyAccountId) {
    if (!profile) throw new SocialError(412, 'social_not_connected', 'Connect a social account first.')
    if (!(await accountBelongsToWorkspace(args.workspaceId, plan.verifyAccountId, client, profile))) {
      return {
        status: 403,
        body: new SocialError(403, 'account_out_of_scope', 'That account belongs to another workspace.').toJSON(),
      }
    }
  }

  if (plan.verifyPostId && !(await postBelongsToWorkspace(args.workspaceId, plan.verifyPostId))) {
    return {
      status: 403,
      body: new SocialError(403, 'post_out_of_scope', 'That post belongs to another workspace.').toJSON(),
    }
  }

  // The wallet is asked before the provider is: a connect adds a monthly account
  // charge and a broadcast can carry X's per-post charge. `402` here costs the
  // user nothing; a call we then have to collect on costs us the provider bill.
  try {
    if (plan.path.startsWith('/connect/')) {
      const active = await db.socialAccount.count({
        where: { workspaceId: args.workspaceId, isActive: true },
      })
      await assertSocialBudget(args.workspaceId, projectedConnectRawUsd(active))
    } else if (plan.record === 'post-created') {
      const body: any = plan.body ?? {}
      const content = typeof body.content === 'string' ? body.content : ''
      const platforms: any[] = Array.isArray(body.platforms) ? body.platforms : []
      await assertSocialBudget(
        args.workspaceId,
        projectedPublishRawUsd(
          platforms.map((platform: any) => ({
            platform: typeof platform?.platform === 'string' ? platform.platform : '',
            content: typeof platform?.customContent === 'string' ? platform.customContent : content,
          })),
        ),
      )
    }
  } catch (err) {
    if (err instanceof SocialError) return { status: err.status, body: err.toJSON() }
    throw err
  }

  const result = await client.request<any>({
    workspaceId: args.workspaceId,
    method: args.method as any,
    path: plan.path,
    query: plan.query,
    body: plan.body,
    idempotencyKey: args.idempotencyKey,
  })

  if (plan.record === 'profile-created') {
    const zernioProfileId = typeof result?.id === 'string' ? result.id : null
    if (zernioProfileId) {
      await recordProfileMapping({
        workspaceId: args.workspaceId,
        localWorkspaceId,
        zernioProfileId,
        externalId: typeof result?.externalId === 'string' && result.externalId ? result.externalId : externalId,
      })
    }
  } else if (plan.record === 'accounts-listed' && profile) {
    await recordAccounts(args.workspaceId, profile.id, result)
  } else if (plan.record === 'post-created') {
    await recordPost(args.workspaceId, localWorkspaceId, plan.body, result, args.idempotencyKey)
  }

  return { status: 200, body: result ?? {} }
}
