// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Durable delivery of webhooks for a desktop's local scope.
 *
 * The cloud cannot apply one of those events (a local scope has no rows in the
 * cloud), and an in-memory broadcast is not a transport: it is per process and
 * per restart, while the provider has already been told `200` and will never
 * send it again. So the verified event is written down first, and the desktop
 * polls its scopes, applies each row in its own DB and acks it.
 *
 * `dedupeKey` is `zernio:<provider event id>` — the same key the cloud event
 * outbox uses — so a provider retry (Zernio retries 7×) collapses onto the row
 * that already exists instead of delivering twice.
 */

import { prisma } from '../../lib/prisma'

const db = prisma as any

/** Applied rows are kept this long so a reconnecting desktop can backfill. */
const KEEP_APPLIED_DAYS = 7

export interface SocialRelayedEventEnvelope {
  externalId: string
  localWorkspaceId: string
  eventId: string
  type: string
  account?: { zernioAccountId: string; platform: string; username: string } | null
  detail?: unknown
  occurredAt: string
}

export interface SocialRelayedEventRow extends SocialRelayedEventEnvelope {
  id: string
  dedupeKey: string
  workspaceId: string
}

export function relayedEventDedupeKey(eventId: string): string {
  return `zernio:${eventId}`
}

/**
 * Write the delivery down. Must succeed before the provider gets its `200`:
 * throwing here surfaces a 500, which Zernio retries, which is the only way an
 * event survives a failure on our side.
 *
 * A duplicate is not a failure — it means the provider retried something we
 * already hold.
 */
export async function enqueueRelayedEvent(args: {
  workspaceId: string
  envelope: SocialRelayedEventEnvelope
}): Promise<{ id: string; duplicate: boolean }> {
  const { workspaceId, envelope } = args
  const dedupeKey = relayedEventDedupeKey(envelope.eventId)
  try {
    const row = await db.socialRelayedEvent.create({
      data: {
        dedupeKey,
        workspaceId,
        localWorkspaceId: envelope.localWorkspaceId,
        externalId: envelope.externalId,
        eventType: envelope.type,
        eventJson: JSON.stringify(envelope),
        occurredAt: new Date(envelope.occurredAt),
      },
    })
    return { id: row.id, duplicate: false }
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err
    const existing = await db.socialRelayedEvent.findUnique({ where: { dedupeKey } })
    if (!existing) throw err
    return { id: existing.id, duplicate: true }
  }
}

function readEnvelope(row: any): SocialRelayedEventEnvelope {
  try {
    const parsed = JSON.parse(row.eventJson)
    if (parsed && typeof parsed === 'object') return parsed as SocialRelayedEventEnvelope
  } catch {
    // A row we cannot read is still a row we must not lose: fall back to the
    // columns, which carry everything routing needs.
  }
  return {
    externalId: row.externalId,
    localWorkspaceId: row.localWorkspaceId,
    eventId: row.dedupeKey.replace(/^zernio:/, ''),
    type: row.eventType,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt),
  }
}

/**
 * Undelivered rows for the caller's workspace — all of its local scopes, or
 * just one when the desktop names it. Scoping by workspace id comes from the
 * caller's key, never from a request parameter.
 */
export async function listRelayedEvents(args: {
  workspaceId: string
  localWorkspaceId?: string
  limit?: number
}): Promise<SocialRelayedEventRow[]> {
  const where: Record<string, unknown> = { workspaceId: args.workspaceId, appliedAt: null }
  if (args.localWorkspaceId) where.localWorkspaceId = args.localWorkspaceId
  const rows = await db.socialRelayedEvent.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(args.limit ?? 50, 1), 200),
  })
  return rows.map((row: any) => ({
    id: row.id,
    dedupeKey: row.dedupeKey,
    workspaceId: row.workspaceId,
    ...readEnvelope(row),
  }))
}

/**
 * Mark deliveries applied. Only the caller's own workspace can ack, and an id
 * from another tenant is silently not theirs — the count that comes back is
 * what the route reports.
 */
export async function ackRelayedEvents(args: {
  workspaceId: string
  ids: string[]
}): Promise<number> {
  if (args.ids.length === 0) return 0
  const result = await db.socialRelayedEvent.updateMany({
    where: { workspaceId: args.workspaceId, id: { in: args.ids }, appliedAt: null },
    data: { appliedAt: new Date() },
  })
  return result.count
}

/** Drop applied rows past the backfill window; called opportunistically. */
export async function pruneRelayedEvents(workspaceId: string): Promise<number> {
  const cutoff = new Date(Date.now() - KEEP_APPLIED_DAYS * 86_400_000)
  const result = await db.socialRelayedEvent.deleteMany({
    where: { workspaceId, appliedAt: { lt: cutoff } },
  })
  return result.count
}
