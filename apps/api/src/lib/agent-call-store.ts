// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent-Call Store — cross-pod status of tracked background `project_call`s.
 *
 * A runtime starts a tracked call (`POST /api/internal/projects/:id/agent-call`
 * with `wait: false, track: true`) on one API replica and long-polls
 * `GET .../agent-call/:runId` on whichever replica the load balancer picks,
 * so the record lives in Redis (shared ioredis client from `./tunnel-redis`).
 * Local mode, and cloud mode while Redis is unreachable, use a per-process
 * Map instead.
 *
 * The desktop app has no Redis and does restart its local API mid-call (app
 * update, quit/relaunch, the SIGKILL recovery in `apps/desktop/src/local-server.ts`),
 * so local mode also writes the record and the callee-chat link through to the
 * app's SQLite database. The Map stays the hot path; the database is what makes
 * the caller's poll and the chat's repair-on-read survive the restart.
 */

import { getSharedRedis } from './tunnel-redis'

export type AgentCallStatus = 'running' | 'completed' | 'failed'

export interface AgentCallRecord {
  status: AgentCallStatus
  runId: string
  reply?: string | null
  sessionId?: string
  chatSessionId?: string
  error?: { code?: string; message: string }
  startedAt: number
  updatedAt: number
}

/** A background call has no time limit, so its record has to outlive long turns. */
export const AGENT_CALL_TTL_SECONDS = 7 * 24 * 60 * 60
const TTL_SECONDS = AGENT_CALL_TTL_SECONDS
const POLL_INTERVAL_MS = 1_000

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'
const records = new Map<string, { record: AgentCallRecord; expiresAt: number }>()

/**
 * Local mode is the one place with no shared store, so it keeps a durable copy
 * in the app database. `SHOGO_APP_DATABASE_URL` is what the desktop launcher
 * (and the local-database test helper) sets; a local-mode process without one
 * keeps the memory-only behaviour.
 */
const durableLocal = isLocalMode && !!(process.env.SHOGO_APP_DATABASE_URL ?? process.env.DATABASE_URL)

/** A call that was already running when this process started cannot finish in it. */
let processStartedAt = Date.now()

function key(projectId: string, runId: string): string {
  return `agent-call:${projectId}:${runId}`
}

function redisOrNull() {
  if (isLocalMode) return null
  return getSharedRedis()
}

function putLocal(k: string, record: AgentCallRecord, expiresAt?: number): void {
  const now = Date.now()
  for (const [rk, entry] of records) {
    if (entry.expiresAt <= now) records.delete(rk)
  }
  records.set(k, { record, expiresAt: expiresAt ?? now + TTL_SECONDS * 1000 })
}

function getLocal(k: string): AgentCallRecord | undefined {
  const entry = records.get(k)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    records.delete(k)
    return undefined
  }
  return entry.record
}

// ─── Durable local store (desktop) ───────────────────────────────────────────

interface AgentCallRow {
  projectId: string
  runId: string
  status: AgentCallStatus
  reply: string | null
  error: string | null
  sessionId: string | null
  chatSessionId: string | null
  startedAt: Date | string
  updatedAt: Date | string
  expiresAt: Date | string
}

interface AgentCallLinkRow {
  chatSessionId: string
  projectId: string
  runId: string
  startedAt: Date | string
  expiresAt: Date | string
}

/** Just the two tables this store owns, so the prisma client stays opaque here. */
interface LocalCallDb {
  agentCall: {
    findUnique(args: any): Promise<AgentCallRow | null>
    upsert(args: any): Promise<unknown>
    delete(args: any): Promise<unknown>
    deleteMany(args: any): Promise<{ count: number }>
    updateMany(args: any): Promise<{ count: number }>
  }
  agentCallSessionLink: {
    findUnique(args: any): Promise<AgentCallLinkRow | null>
    upsert(args: any): Promise<unknown>
    delete(args: any): Promise<unknown>
    deleteMany(args: any): Promise<{ count: number }>
  }
}

let dbPromise: Promise<LocalCallDb | null> | null = null
let startupSweep: Promise<void> | null = null
let warnedDbFailure = false

function warnDbFailure(what: string, err: unknown): void {
  if (warnedDbFailure) return
  warnedDbFailure = true
  console.warn(
    `[agent-call-store] local database ${what} failed; keeping the call in memory only:`,
    (err as Error)?.message ?? err,
  )
}

async function localDb(): Promise<LocalCallDb | null> {
  if (!durableLocal) return null
  if (!dbPromise) {
    dbPromise = import('./prisma')
      .then((mod) => (mod.prisma as unknown as LocalCallDb) ?? null)
      .catch((err) => {
        warnDbFailure('open', err)
        return null
      })
  }
  return dbPromise
}

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

function parseErrorColumn(raw: string | null): AgentCallRecord['error'] {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed.message === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function rowToRecord(row: AgentCallRow): AgentCallRecord {
  const record: AgentCallRecord = {
    status: row.status,
    runId: row.runId,
    startedAt: toMillis(row.startedAt),
    updatedAt: toMillis(row.updatedAt),
  }
  if (row.reply != null) record.reply = row.reply
  if (row.sessionId) record.sessionId = row.sessionId
  if (row.chatSessionId) record.chatSessionId = row.chatSessionId
  const error = parseErrorColumn(row.error)
  if (error) record.error = error
  return record
}

/**
 * Once per process: drop expired rows, and fail the calls that were still
 * `running` when the previous process died. Nothing here can complete them, so
 * without this the caller's poll and the chat's repair-on-read would wait on
 * "running" forever — the silent blank the store exists to prevent.
 */
async function ensureSwept(db: LocalCallDb): Promise<void> {
  if (startupSweep) return startupSweep
  startupSweep = (async () => {
    const now = new Date()
    const interrupted = await db.agentCall.updateMany({
      where: { status: 'running', startedAt: { lt: new Date(processStartedAt) } },
      data: {
        status: 'failed',
        error: JSON.stringify({ code: 'api_restart', message: 'The Shogo API restarted while this call was running.' }),
      },
    })
    await db.agentCall.deleteMany({ where: { expiresAt: { lte: now } } })
    await db.agentCallSessionLink.deleteMany({ where: { expiresAt: { lte: now } } })
    if (interrupted.count > 0) {
      console.warn(`[agent-call-store] marked ${interrupted.count} interrupted call(s) failed after an API restart`)
    }
  })().catch((err) => {
    warnDbFailure('startup sweep', err)
  })
  return startupSweep
}

async function putDurable(projectId: string, record: AgentCallRecord): Promise<void> {
  const db = await localDb()
  if (!db) return
  await ensureSwept(db)
  const now = Date.now()
  const fields = {
    status: record.status,
    reply: record.reply ?? null,
    error: record.error ? JSON.stringify(record.error) : null,
    sessionId: record.sessionId ?? null,
    chatSessionId: record.chatSessionId ?? null,
    startedAt: new Date(record.startedAt || now),
    expiresAt: new Date(now + TTL_SECONDS * 1000),
  }
  try {
    await db.agentCall.upsert({
      where: { projectId_runId: { projectId, runId: record.runId } },
      create: { projectId, runId: record.runId, ...fields },
      update: fields,
    })
  } catch (err) {
    warnDbFailure('write', err)
  }
}

async function getDurable(projectId: string, runId: string): Promise<AgentCallRecord | undefined> {
  const db = await localDb()
  if (!db) return undefined
  await ensureSwept(db)
  const where = { projectId_runId: { projectId, runId } }
  try {
    const row = await db.agentCall.findUnique({ where })
    if (!row) return undefined
    const expiresAt = toMillis(row.expiresAt)
    if (expiresAt <= Date.now()) {
      await db.agentCall.delete({ where }).catch(() => {})
      return undefined
    }
    const record = rowToRecord(row)
    putLocal(key(projectId, runId), record, expiresAt)
    return record
  } catch (err) {
    warnDbFailure('read', err)
    return undefined
  }
}

async function putDurableLink(chatSessionId: string, link: AgentCallSessionLink): Promise<void> {
  const db = await localDb()
  if (!db) return
  await ensureSwept(db)
  const now = Date.now()
  const fields = {
    projectId: link.projectId,
    runId: link.runId,
    startedAt: new Date(link.startedAt || now),
    expiresAt: new Date(now + TTL_SECONDS * 1000),
  }
  try {
    await db.agentCallSessionLink.upsert({
      where: { chatSessionId },
      create: { chatSessionId, ...fields },
      update: fields,
    })
  } catch (err) {
    warnDbFailure('link write', err)
  }
}

async function getDurableLink(chatSessionId: string): Promise<AgentCallSessionLink | undefined> {
  const db = await localDb()
  if (!db) return undefined
  await ensureSwept(db)
  const where = { chatSessionId }
  try {
    const row = await db.agentCallSessionLink.findUnique({ where })
    if (!row) return undefined
    const expiresAt = toMillis(row.expiresAt)
    if (expiresAt <= Date.now()) {
      await db.agentCallSessionLink.delete({ where }).catch(() => {})
      return undefined
    }
    const link: AgentCallSessionLink = {
      projectId: row.projectId,
      runId: row.runId,
      startedAt: toMillis(row.startedAt),
    }
    sessionLinks.set(sessionKey(chatSessionId), { link, expiresAt })
    return link
  } catch (err) {
    warnDbFailure('link read', err)
    return undefined
  }
}

export async function putAgentCall(projectId: string, record: AgentCallRecord): Promise<void> {
  await storeAgentCall(projectId, record)
  if (record.status !== 'running') {
    const { emitTaskEvent } = await import('../services/background-tasks.service')
    await emitTaskEvent('project_call', `${projectId}:${record.runId}`, {
      status: record.status === 'completed' ? 'completed' : 'failed',
      line: record.reply?.trim() || record.error?.message,
      summary: record.status === 'completed' ? 'replied' : record.error?.message,
    })
  }
}

async function storeAgentCall(projectId: string, record: AgentCallRecord): Promise<void> {
  const k = key(projectId, record.runId)
  const r = redisOrNull()
  if (!r) {
    putLocal(k, record)
    await putDurable(projectId, record)
    return
  }
  try {
    await r.set(k, JSON.stringify(record), 'EX', TTL_SECONDS)
  } catch (err) {
    console.warn('[agent-call-store] Redis SET failed, falling back to local map:', (err as Error).message)
    putLocal(k, record)
    await putDurable(projectId, record)
  }
}

export async function getAgentCall(projectId: string, runId: string): Promise<AgentCallRecord | undefined> {
  const k = key(projectId, runId)
  const r = redisOrNull()
  if (!r) return getLocal(k) ?? (await getDurable(projectId, runId))
  try {
    const raw = await r.get(k)
    if (!raw) return getLocal(k) ?? (await getDurable(projectId, runId))
    return JSON.parse(raw) as AgentCallRecord
  } catch (err) {
    console.warn('[agent-call-store] Redis GET failed, falling back to local map:', (err as Error).message)
    return getLocal(k) ?? (await getDurable(projectId, runId))
  }
}

/**
 * Resolve with the record once it is no longer `running`, or with the latest
 * record after `waitMs`. `undefined` means no call was ever tracked under
 * this runId (or it expired).
 */
export async function waitForAgentCall(
  projectId: string,
  runId: string,
  waitMs: number,
  opts: { pollIntervalMs?: number; signal?: AbortSignal } = {},
): Promise<AgentCallRecord | undefined> {
  const deadline = Date.now() + Math.max(0, waitMs)
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  let record = await getAgentCall(projectId, runId)
  while (record && record.status === 'running' && Date.now() < deadline && !opts.signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))))
    record = await getAgentCall(projectId, runId)
  }
  return record
}

/** Which tracked call a callee chat session is running, so a reattach can complete it. */
export interface AgentCallSessionLink {
  projectId: string
  runId: string
  startedAt: number
}

const sessionLinks = new Map<string, { link: AgentCallSessionLink; expiresAt: number }>()

function sessionKey(chatSessionId: string): string {
  return `agent-call-session:${chatSessionId}`
}

export async function linkAgentCallSession(chatSessionId: string, link: AgentCallSessionLink): Promise<void> {
  const k = sessionKey(chatSessionId)
  const putLocalLink = () => {
    const now = Date.now()
    for (const [lk, entry] of sessionLinks) {
      if (entry.expiresAt <= now) sessionLinks.delete(lk)
    }
    sessionLinks.set(k, { link, expiresAt: now + TTL_SECONDS * 1000 })
  }
  const r = redisOrNull()
  if (!r) {
    putLocalLink()
    await putDurableLink(chatSessionId, link)
    return
  }
  try {
    await r.set(k, JSON.stringify(link), 'EX', TTL_SECONDS)
  } catch (err) {
    console.warn('[agent-call-store] Redis SET failed, falling back to local map:', (err as Error).message)
    putLocalLink()
    await putDurableLink(chatSessionId, link)
  }
}

export async function getAgentCallSessionLink(chatSessionId: string): Promise<AgentCallSessionLink | undefined> {
  const k = sessionKey(chatSessionId)
  const getLocalLink = () => {
    const entry = sessionLinks.get(k)
    if (!entry || entry.expiresAt <= Date.now()) return undefined
    return entry.link
  }
  const r = redisOrNull()
  if (!r) return getLocalLink() ?? (await getDurableLink(chatSessionId))
  try {
    const raw = await r.get(k)
    return raw ? (JSON.parse(raw) as AgentCallSessionLink) : (getLocalLink() ?? (await getDurableLink(chatSessionId)))
  } catch (err) {
    console.warn('[agent-call-store] Redis GET failed, falling back to local map:', (err as Error).message)
    return getLocalLink() ?? (await getDurableLink(chatSessionId))
  }
}

/**
 * Test seam — clears the in-memory Maps, and the durable layer's caches, so a
 * test can act like a freshly started API process.
 */
export const _testing = {
  records,
  sessionLinks,
  simulateRestart(): void {
    records.clear()
    sessionLinks.clear()
    dbPromise = null
    startupSweep = null
    warnedDbFailure = false
    processStartedAt = Date.now()
  },
  processStartedAt: () => processStartedAt,
}
