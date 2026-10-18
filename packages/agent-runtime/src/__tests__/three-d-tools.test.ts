// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * 3D tools: generate (text / image / multiview) and edit (all nine V3
 * operations), including output naming per format, the free ops that return
 * metadata only, multi-file retarget results, and local-file uploads.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/three-d-tools.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { filterDisabledCapabilityTools, type ToolContext } from '../gateway-tools'
import { createThreeDTools, _testing } from '../three-d-tools'

const TEST_DIR = join(import.meta.dir, '.three-d-tmp')
const PROXY = 'http://proxy.test/api/ai'
const API = PROXY

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
const realFetch = globalThis.fetch
let routes: Array<{ prefix: string; handler: Handler }> = []
let calls: Array<{ url: string; init?: RequestInit }> = []

function on(prefix: string, handler: Handler) {
  const full = prefix.startsWith('http') ? prefix : `${API}${prefix}`
  routes.push({ prefix: full, handler })
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const bytes = (body: number[], status = 200) => new Response(new Uint8Array(body), { status })

function ctx(config: Record<string, unknown> = {}): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: { channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' }, ...config } as any,
    projectId: 'test',
    aiProxyUrl: PROXY,
    aiProxyToken: 'pt',
  }
}

function tool(name: string, config: Record<string, unknown> = {}) {
  const found = createThreeDTools(ctx(config)).find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} missing`)
  return found
}

function body(call: { init?: RequestInit }): any {
  return JSON.parse(String(call.init?.body ?? '{}'))
}

/** The proxy contract for a task: accept the post, then report success once. */
function taskRoute(id: string, output: Record<string, unknown>, credits = 20) {
  const billed = credits === 0 ? 0 : 0.29
  let polls = 0
  on('/v1/3d/generations', async () => json({ id, status: 'queued', model: 'tripo-v3.1', estimated_usd: 0.24 }))
  on(`/v1/3d/${id}`, () => {
    polls++
    if (polls === 1) return json({ id, status: 'running', progress: 40 })
    return json({ id, status: 'success', progress: 100, credits_consumed: credits, billed_usd: billed, ...output })
  })
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  routes = []
  calls = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    calls.push({ url, init })
    for (const route of routes) {
      if (url.startsWith(route.prefix)) return route.handler(url, init)
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('generate_3d_model', () => {
  test('text-to-3D posts op text_to_model, saves the GLB and reports the charge', async () => {
    on('/v1/3d/generations', async () => json({ id: 'gen3d_a1', model: 'tripo-v3.1', estimated_usd: 0.24 }))
    taskRoute('gen3d_a1', { model_url: 'http://cdn.test/a1.glb' })
    on('http://cdn.test/a1.glb', () => bytes([1, 2, 3, 4]))

    const result: any = await tool('generate_3d_model').execute('t', { prompt: 'a low-poly red fox' }, undefined as any)

    const post = calls.find((c) => c.url.endsWith('/v1/3d/generations'))!
    expect(body(post).op).toBe('text_to_model')
    expect(body(post).prompt).toBe('a low-poly red fox')
    expect(result.details.status).toBe('success')
    expect(result.details.op).toBe('text_to_model')
    expect(readFileSync(join(TEST_DIR, result.details.path))).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(result.details.path.startsWith('models/')).toBe(true)
    expect(result.details.credits_consumed).toBe(20)
    expect(result.details.cost).toContain('$0.29')
  })

  test('image-to-3D sends a data URI, not the file', async () => {
    mkdirSync(join(TEST_DIR, 'refs'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'refs', 'chair.png'), Buffer.from([137, 80, 78, 71]))
    on('/v1/3d/generations', async () => json({ id: 'gen3d_b2', model: 'tripo-v3.1' }))
    taskRoute('gen3d_b2', { model_url: 'http://cdn.test/b2.glb' })
    on('http://cdn.test/b2.glb', () => bytes([9]))

    const result: any = await tool('generate_3d_model').execute('t', { image: 'refs/chair.png' }, undefined as any)

    const post = calls.find((c) => c.url.endsWith('/v1/3d/generations'))!
    expect(body(post).op).toBe('image_to_model')
    expect(body(post).image.startsWith('data:image/png;base64,')).toBe(true)
    expect(result.details.input).toBe('image')
  })

  test('four views become multiview_to_model with every image attached', async () => {
    for (const side of ['front', 'left', 'back', 'right']) {
      writeFileSync(join(TEST_DIR, `${side}.png`), Buffer.from([137, 80, 78, 71]))
    }
    on('/v1/3d/generations', async () => json({ id: 'gen3d_c3', model: 'tripo-v3.1' }))
    taskRoute('gen3d_c3', { model_url: 'http://cdn.test/c3.glb' })
    on('http://cdn.test/c3.glb', () => bytes([7]))

    const result: any = await tool('generate_3d_model').execute(
      't',
      { views: { front: 'front.png', left: 'left.png', back: 'back.png', right: 'right.png' } },
      undefined as any,
    )

    const post = calls.find((c) => c.url.endsWith('/v1/3d/generations'))!
    expect(body(post).op).toBe('multiview_to_model')
    expect(body(post).images).toHaveLength(4)
    expect(result.details.input).toBe('multiview')
  })

  test('a single view is refused: multiview needs at least two', async () => {
    writeFileSync(join(TEST_DIR, 'front.png'), Buffer.from([1]))
    const result: any = await tool('generate_3d_model').execute('t', { views: { front: 'front.png' } }, undefined as any)
    expect(result.details.error).toContain('at least two views')
    expect(calls).toHaveLength(0)
  })

  test('prompt and image together is an error, not a silent preference', async () => {
    writeFileSync(join(TEST_DIR, 'a.png'), Buffer.from([1]))
    const result: any = await tool('generate_3d_model').execute('t', { prompt: 'x', image: 'a.png' }, undefined as any)
    expect(result.details.error).toContain('one input only')
  })

  test('wait: false returns a job id and leaves the job tracked', async () => {
    on('/v1/3d/generations', async () => json({ id: 'gen3d_d4', model: 'tripo-v3.1' }))
    on('/v1/3d/gen3d_d4', () => json({ id: 'gen3d_d4', status: 'success', model_url: 'http://cdn.test/d4.glb' }))
    on('http://cdn.test/d4.glb', () => bytes([1]))

    const result: any = await tool('generate_3d_model').execute(
      't',
      { prompt: 'a teapot', wait: false },
      undefined as any,
    )
    expect(result.details.job_id).toBe('gen3d_d4')
    expect(result.details.status).toBe('queued')
    expect(result.details.message).toContain('generate_3d_model')
    expect(_testing.trackedThreeDJobs.has('gen3d_d4')).toBe(true)
  })
})

describe('edit_3d_model', () => {
  test('a gen3d job id is passed straight through as input', async () => {
    on('/v1/3d/generations', async () => json({ id: 'gen3d_e5', op: 'texture' }))
    taskRoute('gen3d_e5', { model_url: 'http://cdn.test/e5.glb' }, 10)
    on('http://cdn.test/e5.glb', () => bytes([5]))

    const result: any = await tool('edit_3d_model').execute(
      't',
      { op: 'texture', input: 'gen3d_abc123', texture_prompt: 'weathered orange fur' },
      undefined as any,
    )

    const post = calls.find((c) => c.url.endsWith('/v1/3d/generations'))!
    expect(body(post).op).toBe('texture')
    expect(body(post).input).toBe('gen3d_abc123')
    expect(body(post).texture_prompt).toEqual({ text: 'weathered orange fur' })
    expect(result.details.op).toBe('texture')
    expect(result.details.credits_consumed).toBe(10)
  })

  test('convert saves with the chosen format extension', async () => {
    on('/v1/3d/generations', async () => json({ id: 'gen3d_f6', op: 'convert' }))
    taskRoute('gen3d_f6', { model_url: 'http://cdn.test/f6.fbx' }, 10)
    on('http://cdn.test/f6.fbx', () => bytes([1, 2]))

    const result: any = await tool('edit_3d_model').execute(
      't',
      { op: 'convert', input: 'gen3d_abc123', format: 'FBX' },
      undefined as any,
    )
    expect(result.details.path.endsWith('.fbx')).toBe(true)
    expect(body(calls.find((c) => c.url.endsWith('/v1/3d/generations'))!).format).toBe('FBX')
  })

  test('rig_check is metadata only — no file, still reports riggability', async () => {
    on('/v1/3d/generations', async () => json({ id: 'gen3d_g7', op: 'rig_check' }))
    taskRoute('gen3d_g7', { riggable: true, rig_type: 'quadruped' }, 0)

    const result: any = await tool('edit_3d_model').execute(
      't',
      { op: 'rig_check', input: 'gen3d_abc123' },
      undefined as any,
    )
    expect(result.details.riggable).toBe(true)
    expect(result.details.rig_type).toBe('quadruped')
    expect(result.details.path).toBeUndefined()
    expect(result.details.credits_consumed).toBe(0)
    expect(result.details.cost).toContain('free')
  })

  test('retarget with several animations saves each file', async () => {
    on('/v1/3d/generations', async () => json({ id: 'gen3d_h8', op: 'retarget' }))
    taskRoute('gen3d_h8', {
      model_urls: ['http://cdn.test/walk.glb', 'http://cdn.test/run.glb'],
    }, 20)
    on('http://cdn.test/walk.glb', () => bytes([1]))
    on('http://cdn.test/run.glb', () => bytes([2]))

    const result: any = await tool('edit_3d_model').execute(
      't',
      { op: 'retarget', input: 'gen3d_rigged', animation: 'preset:walk,preset:run' },
      undefined as any,
    )
    expect(result.details.paths).toHaveLength(2)
    expect(result.details.paths[1].endsWith('-2.glb')).toBe(true)
    expect(
      body(calls.find((c) => c.url.endsWith('/v1/3d/generations'))!).animation,
    ).toEqual(['preset:walk', 'preset:run'])
  })

  test('a workspace .glb is uploaded first, then referenced by file_token', async () => {
    writeFileSync(join(TEST_DIR, 'chest.glb'), Buffer.from([103, 108, 84, 70]))
    on('/v1/3d/files', async () => json({ file_token: 'tok_123' }))
    on('/v1/3d/generations', async () => json({ id: 'gen3d_i9', op: 'retopology' }))
    taskRoute('gen3d_i9', { model_url: 'http://cdn.test/i9.glb' }, 30)
    on('http://cdn.test/i9.glb', () => bytes([3]))

    const result: any = await tool('edit_3d_model').execute(
      't',
      { op: 'retopology', input: 'chest.glb', face_limit: 4000, quad: true },
      undefined as any,
    )

    const upload = calls.find((c) => c.url.endsWith('/v1/3d/files'))!
    expect(JSON.parse(String(upload.init?.body)).filename).toBe('chest.glb')
    const post = calls.find((c) => c.url.endsWith('/v1/3d/generations'))!
    expect(body(post).input).toBe('tok_123')
    expect(body(post).face_limit).toBe(4000)
    expect(body(post).quad).toBe(true)
    expect(result.details.status).toBe('success')
  })

  test('a model over the 25MB upload cap explains the job-id alternative', async () => {
    writeFileSync(join(TEST_DIR, 'huge.glb'), Buffer.alloc(26 * 1024 * 1024))
    const result: any = await tool('edit_3d_model').execute('t', { op: 'rig', input: 'huge.glb' }, undefined as any)
    expect(result.details.error).toContain('25MB')
    expect(result.details.error).toContain('job_id')
    expect(calls).toHaveLength(0)
  })

  test('missing input names the problem', async () => {
    const result: any = await tool('edit_3d_model').execute('t', { op: 'rig' }, undefined as any)
    expect(result.details.error).toContain('input is required')
  })

  test('a proxy 402 surfaces as an out-of-credit message', async () => {
    on('/v1/3d/generations', () => json({ error: { message: 'Insufficient credit for this project.' } }, 402))
    const result: any = await tool('edit_3d_model').execute(
      't',
      { op: 'segment', input: 'gen3d_abc123' },
      undefined as any,
    )
    expect(result.details.error).toBe('Insufficient credit for this project.')
  })

  test('both 3D tools are gated by the opt-in threeDGenEnabled', async () => {
    const base = { channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } } as any
    const off = filterDisabledCapabilityTools(createThreeDTools(ctx()), base).map((t) => t.name)
    expect(off).not.toContain('generate_3d_model')
    expect(off).not.toContain('edit_3d_model')

    const on = filterDisabledCapabilityTools(createThreeDTools(ctx({ threeDGenEnabled: true })), {
      ...base,
      threeDGenEnabled: true,
    }).map((t) => t.name)
    expect(on).toContain('generate_3d_model')
    expect(on).toContain('edit_3d_model')
  })
})
