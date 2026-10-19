// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The relay's tenant scoping is the security boundary for the master Zernio
 * key, so it is tested as a pure decision first — no database, no provider.
 */

import { describe, expect, test } from 'bun:test'
import { planRelayRequest } from '../relay-plan'

const workspaceId = 'ws_own'
const profile = {
  id: 'profile_1',
  workspaceId,
  zernioProfileId: 'zernio_profile_1',
  externalId: workspaceId,
  name: 'Acme',
}

const plan = (args: Partial<Parameters<typeof planRelayRequest>[0]> = {}) =>
  planRelayRequest({
    method: 'GET',
    path: '/profiles',
    query: {},
    body: undefined,
    workspaceId,
    profile,
    ...args,
  })

describe('relay scoping', () => {
  test('the caller can only ever read its own profile', () => {
    const result = plan({ path: '/profiles', query: { externalId: 'someone_else' } })
    expect(result).toMatchObject({ kind: 'forward', query: { externalId: workspaceId } })
  })

  test('a profile create is rewritten onto the caller’s workspace', () => {
    const result = plan({
      method: 'POST',
      path: '/profiles',
      body: { name: 'Acme', externalId: 'victim_workspace' },
    })
    expect(result).toMatchObject({ kind: 'forward', record: 'profile-created' })
    expect((result as any).body).toEqual({ name: 'Acme', externalId: workspaceId })
  })

  test('another workspace’s profile id is refused', () => {
    const result = plan({ path: '/profiles/zernio_profile_other', method: 'DELETE' })
    expect(result).toMatchObject({ kind: 'deny', status: 403, code: 'profile_out_of_scope' })
  })

  test('account reads are pinned to the caller’s profile id', () => {
    const result = plan({
      path: '/accounts',
      query: { profileId: 'zernio_profile_other' },
    })
    expect(result).toMatchObject({
      kind: 'forward',
      query: { profileId: 'zernio_profile_1' },
      record: 'accounts-listed',
    })
  })

  test('an account mutation must name an id the route can verify', () => {
    const result = plan({ path: '/accounts/zernio_account_9', method: 'DELETE' })
    expect(result).toMatchObject({
      kind: 'forward',
      path: '/accounts/zernio_account_9',
      verifyAccountId: 'zernio_account_9',
    })
  })

  test('a publish is forced onto the caller’s profile', () => {
    const result = plan({
      method: 'POST',
      path: '/posts',
      body: { content: 'hi', profileId: 'zernio_profile_other', platforms: [] },
    })
    expect((result as any).body).toMatchObject({ profileId: 'zernio_profile_1', content: 'hi' })
    expect(result).toMatchObject({ record: 'post-created' })
  })

  test('post mutations must name an id the route can verify', () => {
    const result = plan({ path: '/posts/zernio_post_9', method: 'PATCH', body: { content: 'x' } })
    expect(result).toMatchObject({ kind: 'forward', verifyPostId: 'zernio_post_9' })
    expect((result as any).body).toMatchObject({ profileId: 'zernio_profile_1' })
  })

  test('anything outside the allowlist is denied by default', () => {
    for (const path of ['/analytics', '/workflows', '/webhooks/settings', '/', '/profiles/1/2']) {
      expect(plan({ path, method: 'POST' })).toMatchObject({
        kind: 'deny',
        code: expect.stringMatching(/relay_path_not_allowed|method_not_allowed|invalid_path/),
      })
    }
  })

  test('operations that need a profile are refused before the provider is called', () => {
    for (const [method, path] of [
      ['GET', '/accounts'],
      ['GET', '/posts'],
      ['POST', '/posts'],
      ['GET', '/connect/instagram'],
    ] as const) {
      expect(plan({ method, path, profile: null })).toMatchObject({
        kind: 'deny',
        status: 412,
        code: 'social_not_connected',
      })
    }
  })

  test('unsupported methods never reach the provider', () => {
    expect(plan({ method: 'PUT', path: '/posts' })).toMatchObject({
      kind: 'deny',
      status: 405,
      code: 'method_not_allowed',
    })
  })
})
