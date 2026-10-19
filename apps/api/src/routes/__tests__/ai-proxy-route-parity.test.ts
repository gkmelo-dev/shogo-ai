// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Route-parity guard for the AI proxy.
 *
 * Every `/ai/…` route is either forwarded to Shogo Cloud when the desktop is
 * cloud-authed, or it is genuinely local. That distinction used to be applied
 * by hand, one route at a time, and it drifted: chat, responses and Anthropic
 * messages forwarded, while images, video, 3D and transcription kept resolving
 * a local provider key and answered `provider_not_configured` on a machine
 * whose key was saved in cloud admin (SHO-74).
 *
 * This test parses the router instead of trusting the next author. A new
 * `/ai/…` route that is neither under a forwarded prefix, nor carrying its own
 * `isShogoCloudForwarding()` branch, nor on the explicit local-only allowlist
 * fails with the offending route named.
 */

import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('../ai-proxy.ts', import.meta.url)).text()

const ROUTE_RE = /router\.(get|post|put|patch|delete|all)\(\s*'(\/ai\/[^']*)'/g

interface RegisteredRoute {
  method: string
  path: string
  /** Source text from this route's registration to the next one. */
  body: string
}

function registeredRoutes(text = source): RegisteredRoute[] {
  const matches = [...text.matchAll(ROUTE_RE)]
  return matches.map((match, index) => {
    const start = match.index ?? 0
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length
    return { method: match[1], path: match[2], body: text.slice(start, end) }
  })
}

/** The prefix list the forwarder itself uses, read from the router source. */
function cloudForwardedPrefixes(text = source): string[] {
  const block = text.match(/export const CLOUD_FORWARDED_AI_PREFIXES = \[([\s\S]*?)\]/)
  if (!block) throw new Error('CLOUD_FORWARDED_AI_PREFIXES is missing from routes/ai-proxy.ts')
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
}

/**
 * Routes with their own cloud branch. Listed explicitly so deleting the branch
 * from one of these handlers fails here rather than silently going local.
 */
const DEDICATED_FORWARDERS: Record<string, string> = {
  '/ai/v1/chat/completions': 'forwardChatCompletionsToCloud',
  '/ai/v1/responses': 'forwardResponsesToCloud',
  '/ai/anthropic/v1/messages': 'forwardAnthropicToCloud',
  '/ai/anthropic/v1/messages/count_tokens': 'inline cloud forward',
}

/**
 * Routes that must stay on the local instance, each with the reason. Adding an
 * entry is a deliberate decision, not an oversight — that is the point.
 */
const LOCAL_ONLY: Record<string, string> = {
  '/ai/v1/models': 'local model registry plus this workspace\'s visibility rows; the cloud has its own list',
  '/ai/proxy/tokens': 'mints an rt_v1 token for the local runtime — nothing to forward',
  '/ai/v1/access': 'reads the local workspace\'s advanced-model entitlement',
  '/ai/v1/subscription': 'inspection of the local subscription/wallet view',
  '/ai/proxy/health': 'local health probe',
  '/ai/upstream-health': 'local upstream provider probe',
  // Known gap, same class as SHO-74 but outside that card's five prefixes:
  // without a local ANTHROPIC_API_KEY this 503s on a cloud-authed desktop.
  '/ai/anthropic/v1/models': 'known gap: still resolves a local ANTHROPIC_API_KEY (follow-up to SHO-74)',
}

type Coverage = 'prefix' | 'dedicated' | 'local-only' | 'missing'

function classify(
  route: Pick<RegisteredRoute, 'path' | 'body'>,
  prefixes = cloudForwardedPrefixes(),
): Coverage {
  if (prefixes.some((prefix) => route.path.startsWith(prefix))) return 'prefix'
  if (route.path in DEDICATED_FORWARDERS) return 'dedicated'
  if (route.path in LOCAL_ONLY) return 'local-only'
  return 'missing'
}

describe('AI proxy route parity', () => {
  test('the router still registers the routes this guard was written against', () => {
    const routes = registeredRoutes()
    expect(routes.length).toBeGreaterThan(20)
    expect(routes.map((route) => route.path)).toContain('/ai/v1/3d/generations')
    expect(routes.every((route) => route.path.startsWith('/ai/'))).toBe(true)
  })

  test('every /ai/ route is forwarded, or explicitly local with a reason', () => {
    const missing = registeredRoutes()
      .filter((route) => classify(route) === 'missing')
      .map((route) => `${route.method.toUpperCase()} ${route.path} — add it to CLOUD_FORWARDED_AI_PREFIXES, forward it in the handler, or allowlist it in LOCAL_ONLY`)

    expect(missing).toEqual([])
  })

  test('every dedicated forwarder actually carries the cloud gate', () => {
    const routes = registeredRoutes()
    const ungated = Object.entries(DEDICATED_FORWARDERS)
      .map(([path, label]) => {
        const route = routes.find((candidate) => candidate.path === path)
        if (!route) return `${path} — listed as a dedicated forwarder (${label}) but not registered`
        if (!route.body.includes('isShogoCloudForwarding()')) {
          return `${path} — ${label} no longer checks isShogoCloudForwarding(), so it only ever runs locally`
        }
        return null
      })
      .filter((entry): entry is string => entry !== null)

    expect(ungated).toEqual([])
  })

  test('the forwarded prefixes still cover the media, 3D and audio families', () => {
    expect(cloudForwardedPrefixes()).toEqual([
      '/ai/v1/images/',
      '/ai/v1/media/',
      '/ai/v1/videos/',
      '/ai/v1/3d/',
      '/ai/v1/audio/',
    ])
  })

  test('a new local-only route is reported as missing (the guard is not a no-op)', () => {
    // A plausible next route that no prefix covers — e.g. cloud embeddings,
    // which is the known follow-up to SHO-74 (no cloud route exists yet).
    const dummy = { path: '/ai/v1/embeddings', body: "router.post('/ai/v1/embeddings', async (c) => c.json({}))" }
    expect(classify(dummy)).toBe('missing')
    // …and a route that lands under a forwarded prefix is covered automatically.
    expect(classify({ path: '/ai/v1/audio/transcriptions', body: '' })).toBe('prefix')
  })
})
