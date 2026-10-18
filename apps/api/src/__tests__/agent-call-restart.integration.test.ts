// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The desktop API restarts mid-call — an app update, quit/relaunch, or the
 * SIGKILL recovery in `apps/desktop/src/local-server.ts`. A `project_call`'s
 * record and its callee-chat link used to live only in per-process Maps, so
 * after the restart the caller's long-poll found nothing and the callee chat
 * stayed a prompt with no answer, forever.
 *
 * These tests run the real store against the real desktop SQLite schema (a temp
 * database replayed from `apps/desktop/prisma/migrations`) and rebuild the
 * process Maps between steps with `_testing.simulateRestart()`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const store = await import('../lib/agent-call-store')
const { reconcileCallReplyOnRead } = await import('../services/agent-call-reconcile.service')

const db = prisma as any
const seed: SeededWorkspace = await seedWorkspace(db)

/**
 * Replace the API process: drop every per-process cache. On a build without the
 * durable store that is the whole store, which is the bug this guards.
 */
function restart() {
  store._testing.records.clear()
  store._testing.sessionLinks.clear()
  store._testing.simulateRestart?.()
}

afterAll(async () => {
  restart()
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

/** What `callProjectAgentAsChat` leaves behind: the session and the prompt row. */
async function seedCallChat(chatSessionId: string, projectId: string, runId: string, text = 'Reply with PONG') {
  await db.chatSession.create({
    data: { id: chatSessionId, inferredName: 'Caller', contextType: 'project', contextId: projectId },
  })
  await db.chatMessage.create({
    data: {
      sessionId: chatSessionId,
      role: 'user',
      content: text,
      parts: JSON.stringify([
        { type: 'text', text },
        { type: 'data-project-call', data: { runId, callerName: 'Caller' } },
      ]),
      agent: 'project_call',
    },
  })
}

async function assistantRows(chatSessionId: string) {
  return db.chatMessage.findMany({
    where: { sessionId: chatSessionId, role: 'assistant' },
    orderBy: { createdAt: 'asc' },
  })
}

describe('agent-call store across an API restart (local mode)', () => {
  test('the record and the chat link survive, so opening the chat writes the reply once', async () => {
    const projectId = seed.projectId
    const runId = 'run-restart-1'
    const chatSessionId = `chat-restart-1-${crypto.randomUUID().slice(0, 8)}`
    const startedAt = Date.now()

    await seedCallChat(chatSessionId, projectId, runId)

    await store.putAgentCall(projectId, {
      status: 'running',
      runId,
      sessionId: chatSessionId,
      chatSessionId,
      startedAt,
      updatedAt: startedAt,
    })
    await store.linkAgentCallSession(chatSessionId, { projectId, runId, startedAt })
    await store.putAgentCall(projectId, {
      status: 'completed',
      runId,
      sessionId: chatSessionId,
      chatSessionId,
      reply: 'PONG',
      startedAt,
      updatedAt: Date.now(),
    })

    // The API process is replaced: every Map is gone.
    restart()
    expect(store._testing.records.size).toBe(0)
    expect(store._testing.sessionLinks.size).toBe(0)

    expect(await store.getAgentCall(projectId, runId)).toMatchObject({ status: 'completed', reply: 'PONG' })
    expect(await store.getAgentCallSessionLink(chatSessionId)).toMatchObject({ projectId, runId })

    // The caller's long-poll path resolves the call that was in flight.
    expect(await store.waitForAgentCall(projectId, runId, 0)).toMatchObject({ status: 'completed', reply: 'PONG' })

    expect(await reconcileCallReplyOnRead(db, chatSessionId)).toBe(true)
    const rows = await assistantRows(chatSessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent: 'technical', content: 'PONG' })

    // A second open finds the reply as the newest row and writes nothing more.
    expect(await reconcileCallReplyOnRead(db, chatSessionId)).toBe(false)
    expect(await assistantRows(chatSessionId)).toHaveLength(1)
  })

  test('a call that was still running when the API died ends as an explicit failure row', async () => {
    const projectId = seed.projectId
    const runId = 'run-restart-2'
    const chatSessionId = `chat-restart-2-${crypto.randomUUID().slice(0, 8)}`
    const startedAt = Date.now() - 5 * 60_000

    await seedCallChat(chatSessionId, projectId, runId)
    // Left behind by the previous process: a running record and its link.
    await db.agentCall.create({
      data: {
        projectId,
        runId,
        status: 'running',
        sessionId: chatSessionId,
        chatSessionId,
        startedAt: new Date(startedAt),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    })
    await db.agentCallSessionLink.create({
      data: { chatSessionId, projectId, runId, startedAt: new Date(startedAt), expiresAt: new Date(Date.now() + 60 * 60_000) },
    })

    restart()

    const record = await store.getAgentCall(projectId, runId)
    expect(record).toMatchObject({ status: 'failed' })
    expect(record?.error?.code).toBe('api_restart')

    // The caller's poll settles instead of hanging on `running`.
    expect((await store.waitForAgentCall(projectId, runId, 0))?.status).toBe('failed')

    expect(await reconcileCallReplyOnRead(db, chatSessionId)).toBe(true)
    const rows = await assistantRows(chatSessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toContain('api_restart')
  })

  test('expired records and links resolve to nothing and are deleted', async () => {
    const projectId = seed.projectId
    const runId = 'run-restart-3'
    const chatSessionId = `chat-restart-3-${crypto.randomUUID().slice(0, 8)}`

    // Trigger the once-per-process sweep first, so this exercises the read path.
    expect(await store.getAgentCall(projectId, 'run-never-tracked')).toBeUndefined()

    const expiredAt = new Date(Date.now() - 60_000)
    await db.agentCall.create({
      data: {
        projectId,
        runId,
        status: 'completed',
        reply: 'too late',
        startedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000),
        expiresAt: expiredAt,
      },
    })
    await db.agentCallSessionLink.create({
      data: {
        chatSessionId,
        projectId,
        runId,
        startedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000),
        expiresAt: expiredAt,
      },
    })

    expect(await store.getAgentCall(projectId, runId)).toBeUndefined()
    expect(await store.getAgentCallSessionLink(chatSessionId)).toBeUndefined()
    expect(await db.agentCall.count({ where: { runId } })).toBe(0)
    expect(await db.agentCallSessionLink.count({ where: { chatSessionId } })).toBe(0)
  })

  test('a call record is scoped to its project, and to its 7-day TTL', async () => {
    const projectId = seed.projectId
    const runId = 'run-restart-4'
    const startedAt = Date.now()

    await store.putAgentCall(projectId, { status: 'completed', runId, reply: 'PONG', startedAt, updatedAt: startedAt })

    expect(await store.getAgentCall(seed.foreignProjectId, runId)).toBeUndefined()

    const row = await db.agentCall.findUnique({ where: { projectId_runId: { projectId, runId } } })
    const ttlMs = new Date(row.expiresAt).getTime() - Date.now()
    expect(ttlMs).toBeGreaterThan(agentCallTtlMs() - 60_000)
    expect(ttlMs).toBeLessThanOrEqual(agentCallTtlMs())
  })
})

function agentCallTtlMs(): number {
  return store.AGENT_CALL_TTL_SECONDS * 1000
}
