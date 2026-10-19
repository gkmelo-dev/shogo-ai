// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Zernio profile ↔ workspace. One workspace is one brand, so there is exactly
 * one profile per workspace and `externalId` is the workspace id — that is the
 * value every Zernio webhook carries back, so it is also the routing key.
 */

import { prisma } from '../../lib/prisma'
import { SocialError, getSocialClient } from './client'

const db = prisma as any

export interface SocialProfileRow {
  id: string
  workspaceId: string
  zernioProfileId: string
  externalId: string
  name: string
}

/** Zernio may answer `{ id }` or wrap profiles in a list; read either shape. */
export function pickProfileId(payload: any): string | null {
  const candidate = payload?.id ?? payload?.profileId ?? payload?.profile?.id
  return typeof candidate === 'string' && candidate ? candidate : null
}

export function profileFromList(payload: any, externalId: string): any | null {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.profiles)
      ? payload.profiles
      : Array.isArray(payload?.data)
        ? payload.data
        : []
  return list.find((p: any) => p && p.externalId === externalId) ?? list[0] ?? null
}

export async function getProfile(workspaceId: string): Promise<SocialProfileRow | null> {
  return db.socialProfile.findUnique({ where: { workspaceId } })
}

export async function getProfileByExternalId(externalId: string): Promise<SocialProfileRow | null> {
  return db.socialProfile.findUnique({ where: { externalId } })
}

/**
 * Return the workspace's profile, creating the Zernio side on first use.
 * Idempotent: a concurrent create loses the race on the unique `workspaceId`
 * and then re-reads, and an existing Zernio profile (same `externalId`) is
 * adopted rather than duplicated.
 */
export async function ensureProfile(
  workspaceId: string,
  workspaceName: string,
): Promise<SocialProfileRow> {
  const existing = await getProfile(workspaceId)
  if (existing) return existing

  const client = getSocialClient()
  let zernioProfileId: string | null = null
  /**
   * The routing id Zernio will echo on every webhook. Usually our workspace id,
   * but through the relay the cloud forces the *cloud* workspace id (the one
   * that holds the key and bills), so trust the provider's echo over ours.
   */
  let externalId = workspaceId
  try {
    const created = await client.request<any>({
      method: 'POST',
      path: '/profiles',
      body: { name: workspaceName, externalId: workspaceId },
      idempotencyKey: `social-profile-${workspaceId}`,
    })
    zernioProfileId = pickProfileId(created)
    if (typeof created?.externalId === 'string' && created.externalId) externalId = created.externalId
  } catch (err) {
    if (!(err instanceof SocialError) || (err.status !== 409 && err.status !== 422)) throw err
  }

  if (!zernioProfileId) {
    const found = await client.request<any>({
      method: 'GET',
      path: '/profiles',
      query: { externalId },
    })
    const profile = profileFromList(found, externalId)
    zernioProfileId = profile?.id ?? profile?.profileId ?? null
    if (typeof profile?.externalId === 'string' && profile.externalId) externalId = profile.externalId
  }

  if (!zernioProfileId) {
    throw new SocialError(502, 'social_profile_unresolved', 'Zernio did not return a profile id.')
  }

  try {
    return await db.socialProfile.create({
      data: { workspaceId, zernioProfileId, externalId, name: workspaceName },
    })
  } catch (err: any) {
    if (err?.code === 'P2002') {
      const raced = await getProfile(workspaceId)
      if (raced) return raced
    }
    throw err
  }
}

/**
 * Record which Zernio profile a workspace owns. The cloud relay calls this
 * when it forces a desktop's `POST /profiles`, so the cloud always has the
 * row its webhook routing (P3) and per-account metering (P6) resolve against.
 */
export async function recordProfileMapping(args: {
  workspaceId: string
  zernioProfileId: string
}): Promise<SocialProfileRow> {
  const name = await workspaceName(args.workspaceId)
  return db.socialProfile.upsert({
    where: { workspaceId: args.workspaceId },
    create: {
      workspaceId: args.workspaceId,
      zernioProfileId: args.zernioProfileId,
      externalId: args.workspaceId,
      name,
    },
    update: { zernioProfileId: args.zernioProfileId, name },
  })
}

/** Keep the Zernio profile's name in step with the workspace name. */
export async function renameProfile(workspaceId: string, name: string): Promise<void> {
  const profile = await getProfile(workspaceId)
  if (!profile) return
  await getSocialClient().request({
    method: 'PATCH',
    path: `/profiles/${encodeURIComponent(profile.zernioProfileId)}`,
    body: { name },
  })
  await db.socialProfile.update({ where: { workspaceId }, data: { name } })
}

/** The rename source of truth for the Zernio profile's display name. */
export async function workspaceName(workspaceId: string): Promise<string> {
  const row = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })
  return (row?.name as string | undefined)?.trim() || 'Shogo workspace'
}

/**
 * Delete the Zernio profile with the workspace. Zernio bills per connected
 * account, so an orphaned profile is a permanent charge — this must run before
 * the workspace row (and its cascade) disappears. The local row is deleted
 * either way; `error` reports the provider failure so the wipe can surface it.
 */
export async function deleteProfileForWorkspace(
  workspaceId: string,
): Promise<{ deleted: boolean; error?: string }> {
  const profile = await getProfile(workspaceId)
  if (!profile) return { deleted: false }

  let error: string | undefined
  try {
    await getSocialClient().request({
      method: 'DELETE',
      path: `/profiles/${encodeURIComponent(profile.zernioProfileId)}`,
    })
  } catch (err) {
    error = err instanceof SocialError ? `${err.code}: ${err.message}` : String(err)
  }

  await db.socialProfile.delete({ where: { workspaceId } }).catch(() => {})
  return { deleted: true, error }
}
