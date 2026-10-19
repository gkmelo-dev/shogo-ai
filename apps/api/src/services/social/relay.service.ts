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
  await db.socialPost
    .create({
      data: {
        workspaceId,
        status: body?.publishNow ? 'published' : 'scheduled',
        content: typeof body?.content === 'string' ? body.content : '',
        mediaJson: mediaUrls.length ? mediaUrls : null,
        scheduledFor: Number.isNaN(scheduledFor?.getTime() ?? NaN) ? null : scheduledFor,
        zernioPostId,
        // Already unique per tenant; the prefix keeps a desktop's hash from
        // colliding with a cloud-composed post.
        idempotencyKey: `relay:${workspaceId}:${localWorkspaceId}:${key ?? zernioPostId}`,
      },
    })
    .catch((err: any) => {
      if (err?.code !== 'P2002') throw err
    })
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
