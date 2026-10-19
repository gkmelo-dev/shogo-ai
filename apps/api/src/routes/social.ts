// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Social management API (Zernio): the workspace's connected accounts, its
 * publish fan-out and the calendar the composer schedules into.
 *
 * Mounted twice, like every other workspace surface:
 *   `socialRoutes()`      people, session auth, `/api/workspaces/:id/social/...`
 *   `agentSocialRoutes()` the runtime token, same bodies under `/api/internal`
 *
 * `socialRelayRoutes()` is the cloud half of the desktop relay: a desktop
 * forwards every social operation here and this is the only place the master
 * Zernio key is used.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { getFrontendUrl } from '../lib/cloud-urls'
import { getWorkspaceRole } from '../services/conversation.service'
import {
  SocialError,
  calendar,
  completeConnect,
  connectUrl,
  createPost,
  deletePost,
  disconnectAccount,
  ensureProfile,
  getPost,
  getProfile,
  getSocialClient,
  listAccounts,
  listPosts,
  socialMode,
  syncAccounts,
  updatePost,
  workspaceName,
} from '../services/social'

const db = prisma as any

export interface SocialRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
}

export interface AgentSocialAuthContext {
  workspaceId: string
  projectId?: string
}

export interface AgentSocialRoutesConfig {
  authorize: (c: any) => Promise<AgentSocialAuthContext | Response>
}

function errorResponse(c: any, err: unknown) {
  if (err instanceof SocialError) {
    return c.json(err.toJSON(), err.status as any)
  }
  throw err
}

async function readJson(c: any): Promise<Record<string, any>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

function parseDateParam(raw: string | undefined, fallback: Date): Date {
  if (!raw) return fallback
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    throw new SocialError(400, 'invalid_range', `Invalid date: ${raw}`)
  }
  return date
}

function requireString(raw: unknown, field: string): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) throw new SocialError(400, 'invalid_body', `${field} is required`)
  return value
}

/**
 * Default landing place for the OAuth redirect when the caller does not name
 * one (the agent tool never has a mobile deep link to hand).
 */
function defaultRedirectUrl(): string {
  return process.env.SOCIAL_CONNECT_REDIRECT_URL || `${getFrontendUrl()}/settings/social`
}

export function socialRoutes(config: SocialRoutesConfig): Hono {
  const router = new Hono()

  async function requireMember(c: any, workspaceId: string): Promise<string | Response> {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Sign in first' } }, 401)
    const role = await getWorkspaceRole(workspaceId, userId)
    if (!role) return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)
    if (role === 'viewer' && c.req.method !== 'GET') {
      return c.json({ error: { code: 'forbidden', message: 'Viewers cannot change connected accounts' } }, 403)
    }
    return userId
  }

  router.get('/workspaces/:workspaceId/social/status', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const [profile, accounts] = await Promise.all([
      getProfile(workspaceId),
      listAccounts(workspaceId),
    ])
    let mode: string = 'unavailable'
    let error: string | null = null
    try {
      mode = socialMode()
    } catch (err) {
      error = err instanceof SocialError ? err.message : 'Social is not configured'
    }
    return c.json({
      mode,
      configured: !!error ? false : true,
      error,
      connected: !!profile,
      accounts: accounts.filter((account: any) => account.isActive).length,
    })
  })

  router.get('/workspaces/:workspaceId/social/accounts', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    return c.json({ accounts: await listAccounts(workspaceId) })
  })

  router.post('/workspaces/:workspaceId/social/accounts/sync', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json({ accounts: await syncAccounts(workspaceId, await workspaceName(workspaceId)) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/social/connect', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const result = await connectUrl({
        workspaceId,
        workspaceName: await workspaceName(workspaceId),
        platform: body.platform,
        redirectUrl: typeof body.redirectUrl === 'string' && body.redirectUrl.trim()
          ? body.redirectUrl.trim()
          : defaultRedirectUrl(),
      })
      return c.json(result)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/social/connect/complete', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const account = await completeConnect({
        workspaceId,
        workspaceName: await workspaceName(workspaceId),
        platform: body.platform,
        accountId: requireString(body.accountId, 'accountId'),
        username: requireString(body.username, 'username'),
        displayName: typeof body.displayName === 'string' ? body.displayName : null,
      })
      return c.json({ account })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.delete('/workspaces/:workspaceId/social/accounts/:accountId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json({ account: await disconnectAccount(workspaceId, c.req.param('accountId')) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/posts', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({
      posts: await listPosts(workspaceId, {
        status: c.req.query('status') ?? null,
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    })
  })

  router.post('/workspaces/:workspaceId/social/posts', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const post = await createPost(workspaceId, await workspaceName(workspaceId), {
        content: body.content,
        accountIds: body.accountIds,
        variants: body.variants && typeof body.variants === 'object' ? body.variants : undefined,
        mediaUrls: body.mediaUrls,
        scheduledFor: body.scheduledFor,
        publishNow: body.publishNow === true,
        draft: body.draft === true,
        tags: body.tags,
        createdByUserId: userId,
      })
      return c.json({ post }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/posts/:postId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json({ post: await getPost(workspaceId, c.req.param('postId')) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch('/workspaces/:workspaceId/social/posts/:postId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const post = await updatePost(workspaceId, c.req.param('postId'), {
        content: body.content,
        scheduledFor: body.scheduledFor,
        tags: body.tags,
      })
      return c.json({ post })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.delete('/workspaces/:workspaceId/social/posts/:postId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json(await deletePost(workspaceId, c.req.param('postId')))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/calendar', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const now = new Date()
    const from = parseDateParam(c.req.query('from'), new Date(now.getTime() - 7 * 86_400_000))
    const to = parseDateParam(c.req.query('to'), new Date(now.getTime() + 30 * 86_400_000))
    try {
      return c.json({ from: from.toISOString(), to: to.toISOString(), posts: await calendar(workspaceId, from, to) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/profile', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const profile = await getProfile(workspaceId)
    return c.json({ profile: profile ? { externalId: profile.externalId, name: profile.name } : null })
  })

  router.post('/workspaces/:workspaceId/social/profile', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      const profile = await ensureProfile(workspaceId, await workspaceName(workspaceId))
      return c.json({ profile: { externalId: profile.externalId, name: profile.name } })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}

/**
 * The agent surface for social management. Deliberately a mirror of the user
 * routes (same bodies, same services) rather than a second implementation:
 * `social_media` calls these, so a tool action cannot drift from the UI.
 */
export function agentSocialRoutes(config: AgentSocialRoutesConfig): Hono {
  const router = new Hono()

  async function authorize(c: any): Promise<AgentSocialAuthContext | Response> {
    return config.authorize(c)
  }

  router.get('/workspaces/:workspaceId/social/accounts', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    return c.json({ accounts: await listAccounts(auth.workspaceId) })
  })

  router.post('/workspaces/:workspaceId/social/connect', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      return c.json(
        await connectUrl({
          workspaceId: auth.workspaceId,
          workspaceName: await workspaceName(auth.workspaceId),
          platform: body.platform,
          redirectUrl: typeof body.redirectUrl === 'string' && body.redirectUrl.trim()
            ? body.redirectUrl.trim()
            : defaultRedirectUrl(),
        }),
      )
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/posts', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    return c.json({
      posts: await listPosts(auth.workspaceId, {
        status: c.req.query('status') ?? null,
        limit: Number(c.req.query('limit') ?? 20),
      }),
    })
  })

  router.post('/workspaces/:workspaceId/social/posts', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      const post = await createPost(auth.workspaceId, await workspaceName(auth.workspaceId), {
        content: body.content,
        accountIds: body.accountIds,
        variants: body.variants && typeof body.variants === 'object' ? body.variants : undefined,
        mediaUrls: body.mediaUrls,
        scheduledFor: body.scheduledFor,
        publishNow: body.publishNow === true,
        draft: body.draft === true,
        tags: body.tags,
      })
      return c.json({ post }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/calendar', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const now = new Date()
    const from = parseDateParam(c.req.query('from'), new Date(now.getTime() - 7 * 86_400_000))
    const to = parseDateParam(c.req.query('to'), new Date(now.getTime() + 30 * 86_400_000))
    try {
      return c.json({ from: from.toISOString(), to: to.toISOString(), posts: await calendar(auth.workspaceId, from, to) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}

/**
 * Cloud half of the desktop relay (decision 1: every social call on every
 * surface goes through the cloud, which holds the master key and meters it).
 * It relays operations verbatim — it is not a second domain layer — so a
 * desktop's `client.ts` can target it instead of Zernio.
 */
export function socialRelayRoutes(): Hono {
  const router = new Hono()

  async function requireCaller(c: any): Promise<Response | null> {
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) return c.json({ error: { code: 'unauthorized', message: 'Missing relay token' } }, 401)
    if (process.env.SHOGO_API_KEY && token === process.env.SHOGO_API_KEY) return null
    if (token.startsWith('shogo_sk_')) {
      try {
        const { resolveApiKey } = await import('./api-keys')
        if (await resolveApiKey(token)) return null
      } catch {
        // fall through to the rejection below
      }
    }
    return c.json({ error: { code: 'unauthorized', message: 'Invalid relay token' } }, 401)
  }

  router.all('/social-relay/*', async (c) => {
    const denied = await requireCaller(c)
    if (denied) return denied

    const prefix = '/api/social-relay'
    const rawPath = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : ''
    if (!rawPath.startsWith('/')) {
      return c.json({ error: { code: 'invalid_path', message: 'Relay needs a Zernio path' } }, 400)
    }
    // The relay only ever speaks to the fixed Zernio base; a caller-supplied
    // absolute URL can never redirect the master key elsewhere.
    const query: Record<string, string> = {}
    for (const [key, value] of new URL(c.req.url).searchParams) query[key] = value

    const method = c.req.method as 'GET' | 'POST' | 'PATCH' | 'DELETE'
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
      return c.json({ error: { code: 'invalid_method', message: `${method} is not relayed` } }, 405)
    }

    const bodyText = method === 'GET' || method === 'DELETE' ? '' : await c.req.text()
    const client = getSocialClient()
    if (client.mode === 'relay') {
      return c.json({ error: { code: 'relay_loop', message: 'The relay host is itself in relay mode' } }, 500)
    }
    try {
      const result = await client.request({
        method,
        path: rawPath,
        query,
        body: bodyText ? JSON.parse(bodyText) : undefined,
        idempotencyKey: c.req.header('idempotency-key') ?? undefined,
      })
      return c.json((result ?? {}) as any)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}
