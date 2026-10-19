// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the relay is allowed to do, as a pure decision.
 *
 * Kept free of database imports so the tenant boundary is testable on its own
 * and so no test that exercises it can drag Prisma (or a mocked Prisma) in.
 */

import type { SocialProfileRow } from './profiles.service'

export type RelayPlan =
  | {
      kind: 'forward'
      path: string
      query: Record<string, string>
      body?: unknown
      /** Post-forward bookkeeping the cloud needs to own: routing + billing. */
      record?: 'profile-created' | 'accounts-listed' | 'post-created'
      /** Resource id the route must prove belongs to the caller first. */
      verifyAccountId?: string
      verifyPostId?: string
    }
  | { kind: 'deny'; status: number; code: string; message: string }

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE'])

function deny(status: number, code: string, message: string): RelayPlan {
  return { kind: 'deny', status, code, message }
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function needsProfile(profile: SocialProfileRow | null): RelayPlan | null {
  if (profile) return null
  return deny(
    412,
    'social_not_connected',
    'Connect a social account in this workspace before calling the provider.',
  )
}

/**
 * Decide what the relay may do for one *scope* of a workspace, and rewrite the
 * operation so it can only ever touch that scope's Zernio profile.
 *
 * `externalId` is the derived routing id for the scope (`ws_<workspaceId>` or
 * `lws_<localWorkspaceId>`), never a value from the request: a desktop's local
 * workspaces each own a profile, so the caller's own local scope is the only
 * thing that may select one.
 */
export function planRelayRequest(args: {
  method: string
  path: string
  query: Record<string, string>
  body: any
  workspaceId: string
  localWorkspaceId?: string
  /** Derived routing id for the scope; never read from the request. */
  externalId: string
  profile: SocialProfileRow | null
}): RelayPlan {
  const method = args.method.toUpperCase()
  if (!METHODS.has(method)) return deny(405, 'method_not_allowed', `${method} is not relayed`)

  const seg = segments(args.path)
  if (seg.length === 0) return deny(400, 'invalid_path', 'Relay needs a Zernio path')

  // ── profiles ────────────────────────────────────────────────────────────
  if (seg[0] === 'profiles' && seg.length === 1) {
    if (method === 'GET') {
      // Only ever the caller's own profile, resolved by the routing id we own.
      return { kind: 'forward', path: '/profiles', query: { externalId: args.externalId } }
    }
    if (method === 'POST') {
      return {
        kind: 'forward',
        path: '/profiles',
        query: {},
        body: {
          name: typeof args.body?.name === 'string' && args.body.name ? args.body.name : (args.profile?.name ?? 'Shogo workspace'),
          externalId: args.externalId,
        },
        record: 'profile-created',
      }
    }
    return deny(405, 'method_not_allowed', `${method} /profiles is not relayed`)
  }

  if (seg[0] === 'profiles' && seg.length === 2) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (seg[1] !== args.profile!.zernioProfileId) {
      return deny(403, 'profile_out_of_scope', 'That profile belongs to another workspace.')
    }
    if (!['GET', 'PATCH', 'DELETE'].includes(method)) {
      return deny(405, 'method_not_allowed', `${method} /profiles/:id is not relayed`)
    }
    return {
      kind: 'forward',
      path: `/profiles/${encodeURIComponent(args.profile!.zernioProfileId)}`,
      query: {},
      body: method === 'PATCH' ? { name: args.body?.name } : undefined,
    }
  }

  // ── connect ─────────────────────────────────────────────────────────────
  if (seg[0] === 'connect') {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (method !== 'GET' || seg.length !== 2) {
      return deny(405, 'method_not_allowed', `${method} ${args.path} is not relayed`)
    }
    const query: Record<string, string> = { profileId: args.profile!.zernioProfileId }
    if (typeof args.query.redirect_url === 'string') query.redirect_url = args.query.redirect_url
    return { kind: 'forward', path: `/connect/${encodeURIComponent(seg[1]!)}`, query }
  }

  // ── accounts ────────────────────────────────────────────────────────────
  if (seg[0] === 'accounts' && seg.length === 1) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (method !== 'GET') return deny(405, 'method_not_allowed', `${method} /accounts is not relayed`)
    return {
      kind: 'forward',
      path: '/accounts',
      query: { profileId: args.profile!.zernioProfileId },
      record: 'accounts-listed',
    }
  }

  if (seg[0] === 'accounts' && seg.length === 2) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (!['GET', 'PATCH', 'DELETE'].includes(method)) {
      return deny(405, 'method_not_allowed', `${method} /accounts/:id is not relayed`)
    }
    return {
      kind: 'forward',
      path: `/accounts/${encodeURIComponent(seg[1]!)}`,
      query: { profileId: args.profile!.zernioProfileId },
      body: method === 'PATCH' ? { profileId: args.profile!.zernioProfileId } : undefined,
      verifyAccountId: seg[1]!,
    }
  }

  // ── posts ───────────────────────────────────────────────────────────────
  if (seg[0] === 'posts' && seg.length === 1) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (method === 'GET') {
      return {
        kind: 'forward',
        path: '/posts',
        query: { profileId: args.profile!.zernioProfileId },
      }
    }
    if (method === 'POST') {
      return {
        kind: 'forward',
        path: '/posts',
        query: {},
        body: { ...(args.body ?? {}), profileId: args.profile!.zernioProfileId },
        record: 'post-created',
      }
    }
    return deny(405, 'method_not_allowed', `${method} /posts is not relayed`)
  }

  if (seg[0] === 'posts' && seg.length === 2) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (!['GET', 'PATCH', 'DELETE'].includes(method)) {
      return deny(405, 'method_not_allowed', `${method} /posts/:id is not relayed`)
    }
    return {
      kind: 'forward',
      path: `/posts/${encodeURIComponent(seg[1]!)}`,
      query: { profileId: args.profile!.zernioProfileId },
      body: method === 'PATCH' ? { ...(args.body ?? {}), profileId: args.profile!.zernioProfileId } : undefined,
      verifyPostId: seg[1]!,
    }
  }

  return deny(403, 'relay_path_not_allowed', `The relay does not serve ${method} ${args.path}.`)
}
