// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The pack apply engine: what one install creates, in what order, and what an
 * uninstall is allowed to remove. Everything external is mocked, so these
 * assertions are about our decisions (channel suffixing, lock-free rebinding,
 * bound-ids-only deletes) rather than about Prisma.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const calls: Array<{ fn: string; args: any[] }> = []
const record = (fn: string) => (...args: any[]) => {
  calls.push({ fn, args })
}
const order = () => calls.map((c) => c.fn)

let liveChannels: Array<{ id: string; name: string }> = []
let liveSchedules: Array<{ id: string; name: string }> = []
let boards: Array<{ keyPrefix: string }> = []
let projects: Array<{ name: string }> = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findMany: async () => projects,
      update: async () => ({ id: 'p' }),
      delete: async () => ({ id: 'p' }),
    },
    board: { findMany: async () => boards, findFirst: async ({ where }: any) => ({ id: where.id }) },
    projectAttachment: { upsert: async () => ({ id: 'att' }) },
    conversation: { update: async () => ({ id: 'c' }) },
  },
}))

mock.module('../conversation-team-channels', () => ({
  listTeamChannels: async () => ({ channels: liveChannels }),
  upsertTeamChannel: async (_w: string, input: any) => {
    record('upsertTeamChannel')(input.name)
    return { channel: { id: `conv-${input.name}` }, created: true }
  },
  syncTeamChannelOwnership: async () => record('syncTeamChannelOwnership')(),
}))

mock.module('../project-lifecycle.service', () => ({
  createProjectInWorkspace: async (input: any) => {
    record('createProjectInWorkspace')(input.name)
    return { id: `proj-${input.name}` }
  },
  configureProject: async (id: string) => record('configureProject')(id),
}))

mock.module('../work-boards.service', () => ({
  createBoard: async (_w: string, input: any) => {
    record('createBoard')(input.name)
    return { id: `board-${input.name}` }
  },
  archiveBoard: async (board: any) => record('archiveBoard')(board.id),
}))

mock.module('../agent-schedule.service', () => ({
  listSchedules: async () => liveSchedules,
  createSchedule: async (input: any) => {
    record('createSchedule')(input)
    return { id: 'sched-new' }
  },
  updateSchedule: async (_w: string, id: string, input: any) => {
    record('updateSchedule')({ id, input })
    return { id }
  },
  deleteSchedule: async (_w: string, id: string) => {
    record('deleteSchedule')(id)
    return true
  },
}))

mock.module('../event-subscription.service', () => ({
  createSubscription: async (input: any) => {
    record('createSubscription')(input.name)
    return { subscription: { id: 'trig-new' } }
  },
  deleteSubscription: async (_w: string, id: string) => {
    record('deleteSubscription')(id)
    return true
  },
}))

mock.module('../conversation.service', () => ({
  deleteConversation: async (id: string) => record('deleteConversation')(id),
  slugify: (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
}))

const { applySystemPack, previewSystemPack, uninstallSystemPack } = await import('../system-apply.service')

const pack = {
  version: 1 as const,
  name: 'Self Evolving',
  projects: [{ key: 'evolver', name: 'Evolver', files: {} }],
  teamChannels: [
    { name: 'evolution', topic: 'Reviews' },
    { name: 'ideas', topic: 'Ideas' },
  ],
  schedules: [
    {
      key: 'daily-evolution',
      name: 'Daily self review',
      project: 'evolver',
      channel: 'evolution',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
      prompt: 'Review with <@a:p:{{agent.evolver}}> and post in {{channel.evolution}}.',
    },
  ],
  triggers: [],
}

beforeEach(() => {
  calls.length = 0
  liveChannels = []
  liveSchedules = []
  boards = []
  projects = []
})

describe('previewSystemPack', () => {
  it('suffixes a taken channel name instead of reusing it', async () => {
    liveChannels = [{ id: 'conv-old', name: 'ideas' }]
    const preview = await previewSystemPack({ workspaceId: 'w1', manifest: pack })
    expect(preview.channelNames).toEqual({ evolution: 'evolution', ideas: 'ideas-2' })
    expect(preview.conflicts.join('\n')).toContain('#ideas is taken → this install will use #ideas-2')
    expect(preview.plan.join('\n')).toContain('create schedule "Daily self review"')
  })

  it('reports a project name that is already used', async () => {
    projects = [{ name: 'Evolver' }]
    const preview = await previewSystemPack({ workspaceId: 'w1', manifest: pack })
    expect(preview.conflicts.join('\n')).toContain('A project named "Evolver" already exists')
  })
})

describe('applySystemPack', () => {
  it('binds the anchor, creates channels then boards then the schedule pointing at the channel', async () => {
    const result = await applySystemPack({
      workspaceId: 'w1',
      manifest: pack,
      actorUserId: 'u1',
      anchorProjectId: 'proj-anchor',
    })
    expect(result.ok).toBe(true)
    expect(result.bindings.projects.evolver).toBe('proj-anchor')
    expect(result.bindings.channels).toEqual({ evolution: 'conv-evolution', ideas: 'conv-ideas' })
    const schedule = calls.find((c) => c.fn === 'createSchedule')!
    expect(schedule.args[0].notifyConversationId).toBe('conv-evolution')
    expect(schedule.args[0].prompt).toContain('<@a:p:proj-anchor>')
    expect(schedule.args[0].prompt).toContain('conv-evolution')
    expect(order().indexOf('upsertTeamChannel')).toBeLessThan(order().indexOf('createSchedule'))
  })

  it('updates a bound schedule instead of creating a second one', async () => {
    const result = await applySystemPack({
      workspaceId: 'w1',
      manifest: pack,
      actorUserId: 'u1',
      anchorProjectId: 'proj-anchor',
      bindings: { projects: { evolver: 'proj-anchor' }, channels: {}, boards: {}, schedules: { 'daily-evolution': 'sched-old' }, triggers: {} },
    })
    expect(result.ok).toBe(true)
    expect(order()).not.toContain('createSchedule')
    expect(calls.find((c) => c.fn === 'updateSchedule')!.args[0].id).toBe('sched-old')
  })
})

describe('uninstallSystemPack', () => {
  it('removes only the bound ids, schedule first and project last', async () => {
    const result = await uninstallSystemPack({
      workspaceId: 'w1',
      actorUserId: 'u1',
      bindings: {
        projects: { evolver: 'proj-anchor' },
        channels: { evolution: 'conv-evolution' },
        boards: { 'evolution/Reviews': 'board-1' },
        schedules: { 'daily-evolution': 'sched-1' },
        triggers: { t: 'trig-1' },
      },
    })
    expect(result.errors).toEqual([])
    const sequence = order().filter((fn) => ['deleteSchedule', 'deleteSubscription', 'archiveBoard', 'deleteConversation'].includes(fn))
    expect(sequence).toEqual(['deleteSchedule', 'deleteSubscription', 'archiveBoard', 'deleteConversation'])
    expect(calls.filter((c) => c.fn === 'deleteConversation')).toHaveLength(1)
  })

  it('leaves an adopted channel alone when it is not in the bindings', async () => {
    await uninstallSystemPack({
      workspaceId: 'w1',
      actorUserId: 'u1',
      bindings: { projects: {}, channels: {}, boards: {}, schedules: {}, triggers: {} },
    })
    expect(calls).toEqual([])
  })
})
