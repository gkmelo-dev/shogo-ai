// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tripo3D 3D generation: the submit route (text-to-model, image-to-model with
 * a data URI upload and with an https URL), the status route (charging from
 * `credits_consumed`, exactly once per job), the model listing and the
 * configured-key / usage-limit gates.
 *
 * No external network: `globalThis.fetch` is stubbed by URL. Nothing in this
 * file may reach openapi.tripo3d.ai.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-3d.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
process.env.TRIPO_API_KEY = 'tripo-test-key'

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', name: 'Test' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    usageEvent: { create: async () => ({}) },
  },
}))

const consumeCalls: any[] = []
let balanceOk = true
const billingStub = () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  hasBalance: async () => balanceOk,
  checkUsageBalance: async () => (balanceOk ? { ok: true } : { ok: false, reason: 'usage_limit_reached' }),
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'limit' }),
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async (args: any) => {
    consumeCalls.push(args)
    return { success: true, remainingIncludedUsd: 100 }
  },
  getSubscription: async () => null,
  getUsageWallet: async () => null,
  getUsageWindows: async () => null,
  ensureSystemWorkspace: async () => ({}),
  hasPaidSubscription: async () => true,
  canRunTechStackOnInstanceSize: async () => ({ ok: true }),
  syncFromStripe: async () => ({}),
  allocateMonthlyIncluded: async () => ({}),
})
mock.module('../services/billing.service', billingStub)
mock.module('../services/billing-runtime', billingStub)

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'test-user',
}))

// ─── fetch stub routed by URL ──────────────────────────────────────────────
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
const originalFetch = globalThis.fetch
let routes: Array<{ match: (url: string) => boolean; handler: Handler }> = []
let fetchLog: Array<{ url: string; init?: RequestInit }> = []

function on(match: string | RegExp, handler: Handler) {
  routes.push({
    match: (url) => (typeof match === 'string' ? url === match || url.startsWith(match) : match.test(url)),
    handler,
  })
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const TRIPO = 'https://openapi.tripo3d.ai/v3'
const TASK_ID = '11111111-1111-4111-8111-111111111111'
const TASK_URL = `${TRIPO}/tasks/${TASK_ID}`

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    fetchLog.push({ url, init })
    const route = routes.find((r) => r.match(url))
    if (!route) return json({ error: `unrouted ${url}` }, 599)
    return route.handler(url, init)
  }) as any
})
afterAll(() => {
  globalThis.fetch = originalFetch
})
beforeEach(() => {
  routes = []
  fetchLog = []
  consumeCalls.length = 0
  balanceOk = true
})

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { _testing: jobStore } = await import('../lib/3d-job-store')
const { estimateTripoTaskCost, calculate3dUsageCost } = await import('../lib/usage-cost')

const app = new Hono()
app.route('/api', aiProxyRoutes())
let TOKEN: string
let OTHER_WS_TOKEN: string
beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
  OTHER_WS_TOKEN = await generateProxyToken('proj-2', 'ws-2', 'user-2')
})

const call = (path: string, init: RequestInit = {}, token = TOKEN) =>
  app.fetch(new Request(`http://x/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as any) },
  }))

/** Billing is fire-and-forget; let the microtasks settle. */
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  jobStore.records.clear()
  jobStore.charged.clear()
})

function mockSubmit(taskId = TASK_ID) {
  let body: any
  on(`${TRIPO}/generation/text-to-model`, (_url, init) => {
    body = JSON.parse(String(init?.body))
    expect((init?.headers as any).Authorization).toBe('Bearer tripo-test-key')
    return json({ code: 0, data: { task_id: taskId } })
  })
  on(`${TRIPO}/generation/image-to-model`, (_url, init) => {
    body = JSON.parse(String(init?.body))
    expect((init?.headers as any).Authorization).toBe('Bearer tripo-test-key')
    return json({ code: 0, data: { task_id: taskId } })
  })
  return () => body
}

const submit = async (body: Record<string, unknown>) => {
  const res = await call('/ai/v1/3d/generations', { method: 'POST', body: JSON.stringify(body) })
  return { res, data: await res.json() as any }
}

const poll = (id: string, token = TOKEN) => call(`/ai/v1/3d/${id}`, {}, token)

// =========================================================================
// Submit
// =========================================================================

describe('POST /ai/v1/3d/generations', () => {
  test('text-to-model submits with the server key and returns a queued job with an estimate', async () => {
    const body = mockSubmit()
    const { res, data } = await submit({ prompt: 'a wooden treasure chest, low poly' })

    expect(res.status).toBe(200)
    expect(data.id).toStartWith('gen3d_')
    expect(data.status).toBe('queued')
    expect(data.model).toBe('tripo-v3.1')
    // H-series text-to-model with the default standard texture: 20 credits → $0.24
    expect(data.estimated_usd).toBeCloseTo(0.24, 4)
    // Shogo exposes `tripo-v3.1`; the API only accepts the version string.
    expect(body()).toMatchObject({ prompt: 'a wooden treasure chest, low poly', model: 'v3.1-20260211' })
    expect(fetchLog.map((f) => f.url)).toEqual([`${TRIPO}/generation/text-to-model`])
    expect(consumeCalls).toHaveLength(0)
  })

  test('forwards the generation options it was given and nothing else', async () => {
    const body = mockSubmit()
    await submit({ prompt: 'a chair', model: 'tripo-p1', texture: false, face_limit: 8000, quad: true })
    expect(body()).toEqual({ prompt: 'a chair', model: 'P1-20260311', texture: false, face_limit: 8000, quad: true })
  })

  test('image-to-model uploads a data URI and forwards the file_token', async () => {
    on(`${TRIPO}/files`, (_url, init) => {
      const form = init?.body as FormData
      expect(form).toBeInstanceOf(FormData)
      expect((form.get('file') as File).type).toBe('image/png')
      return json({ code: 0, data: { file_token: 'file_abc123' } })
    })
    const body = mockSubmit()

    const { res, data } = await submit({ image: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(res.status).toBe(200)
    expect(data.status).toBe('queued')
    expect(body()).toMatchObject({ input: 'file_abc123', model: 'v3.1-20260211' })
    expect(fetchLog.map((f) => f.url)).toEqual([`${TRIPO}/files`, `${TRIPO}/generation/image-to-model`])
  })

  test('an https image URL is forwarded untouched', async () => {
    const body = mockSubmit()
    const url = 'https://example.com/chair.png'
    const { res } = await submit({ image: url })
    expect(res.status).toBe(200)
    expect(body()).toMatchObject({ input: url })
    expect(fetchLog.some((f) => f.url === `${TRIPO}/files`)).toBe(false)
  })

  test('prompt and image together is rejected before any vendor call', async () => {
    const { res, data } = await submit({ prompt: 'a chair', image: 'https://example.com/chair.png' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('prompt_and_image')
    expect(fetchLog).toHaveLength(0)
  })

  test('neither prompt nor image is rejected', async () => {
    const { res, data } = await submit({ model: 'tripo-v3.1' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('missing_prompt')
  })

  test('an unsupported model is rejected', async () => {
    const { res, data } = await submit({ prompt: 'x', model: 'tripo-v9' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('model_not_found')
  })

  test('an unsupported texture_quality is rejected', async () => {
    const { res, data } = await submit({ prompt: 'x', texture_quality: 'ultra' })
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('invalid_texture_quality')
  })

  test('a vendor error envelope surfaces message and suggestion', async () => {
    on(`${TRIPO}/generation/text-to-model`, () =>
      json({ code: 1004, message: 'invalid prompt', suggestion: 'shorten it' }, 400))
    const { res, data } = await submit({ prompt: 'x' })
    expect(res.status).toBe(400)
    expect(data.error.message).toContain('invalid prompt')
    expect(data.error.message).toContain('shorten it')
  })

  test('no Tripo key answers 503 provider_not_configured', async () => {
    const saved = process.env.TRIPO_API_KEY
    delete process.env.TRIPO_API_KEY
    try {
      const { res, data } = await submit({ prompt: 'x' })
      expect(res.status).toBe(503)
      expect(data.error.code).toBe('provider_not_configured')
      expect(fetchLog).toHaveLength(0)
    } finally {
      process.env.TRIPO_API_KEY = saved
    }
  })

  test('exhausted balance answers 402 with the standard usage-limit body and calls nothing', async () => {
    balanceOk = false
    const { res, data } = await submit({ prompt: 'x' })
    expect(res.status).toBe(402)
    expect(data.error).toMatchObject({ type: 'billing_error', code: 'usage_limit_reached' })
    expect(fetchLog).toHaveLength(0)
  })

  test('bad token answers 401 like the media routes', async () => {
    const res = await app.fetch(new Request('http://x/api/ai/v1/3d/generations', { method: 'POST' }))
    expect(res.status).toBe(401)
  })
})

// =========================================================================
// Status + billing
// =========================================================================

describe('GET /ai/v1/3d/:id', () => {
  async function queue() {
    mockSubmit()
    const { data } = await submit({ prompt: 'a lighthouse', model: 'tripo-p1' })
    return data.id as string
  }

  test('running reports progress and charges nothing', async () => {
    const id = await queue()
    on(TASK_URL, () => json({ code: 0, data: { status: 'running', progress: 42 } }))

    const res = await poll(id)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id, status: 'running', progress: 42 })
    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('success returns the model_url and charges credits/100 × markup once', async () => {
    const id = await queue()
    on(TASK_URL, () => json({
      code: 0,
      data: { status: 'success', progress: 100, output: { model_url: 'https://tripo-cdn.example/m.glb' }, credits_consumed: 40 },
    }))

    const res = await poll(id)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data).toMatchObject({
      id,
      status: 'success',
      model_url: 'https://tripo-cdn.example/m.glb',
      credits_consumed: 40,
    })

    await settle()
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].actionType).toBe('ai_3d_generation')
    expect(consumeCalls[0].rawUsd).toBeCloseTo(0.4, 6)
    expect(consumeCalls[0].billedUsd).toBeCloseTo(0.4 * 1.2, 6)
    expect(consumeCalls[0].actionMetadata).toMatchObject({
      model: 'tripo-p1',
      taskId: TASK_ID,
      creditsConsumed: 40,
      input: 'text',
    })
  })

  test('polling a finished job three times charges exactly once, across requests', async () => {
    const id = await queue()
    on(TASK_URL, () => json({
      code: 0,
      data: { status: 'success', progress: 100, output: { model_url: 'https://tripo-cdn.example/m.glb' }, credits_consumed: 20 },
    }))

    for (let i = 0; i < 3; i++) {
      const data = await (await poll(id)).json() as any
      expect(data.status).toBe('success')
    }
    await settle()
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].rawUsd).toBeCloseTo(0.2, 6)
  })

  test('a failed task surfaces the error and is not charged', async () => {
    const id = await queue()
    on(TASK_URL, () => json({
      code: 0,
      data: { status: 'failed', progress: 0, error_code: 2000, error_message: 'content policy' },
    }))

    const res = await poll(id)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id, status: 'failed', error: 'content policy' })
    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('a cancelled task reports failed and is not charged', async () => {
    const id = await queue()
    on(TASK_URL, () => json({ code: 0, data: { status: 'cancelled' } }))
    const data = await (await poll(id)).json() as any
    expect(data.status).toBe('failed')
    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('an unknown job is a 404', async () => {
    const res = await poll('gen3d_does-not-exist')
    expect(res.status).toBe(404)
    expect((await res.json() as any).error.code).toBe('job_not_found')
  })

  test("another workspace cannot read a job", async () => {
    const id = await queue()
    const res = await poll(id, OTHER_WS_TOKEN)
    expect(res.status).toBe(404)
  })

  test('no Tripo key answers 503 on the status route too', async () => {
    const id = await queue()
    const saved = process.env.TRIPO_API_KEY
    delete process.env.TRIPO_API_KEY
    try {
      const res = await poll(id)
      expect(res.status).toBe(503)
      expect((await res.json() as any).error.code).toBe('provider_not_configured')
    } finally {
      process.env.TRIPO_API_KEY = saved
    }
  })
})

// =========================================================================
// Model listing
// =========================================================================

describe('GET /ai/v1/3d/models', () => {
  test('lists the runnable models with marked-up prices', async () => {
    const res = await call('/ai/v1/3d/models')
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.currency).toBe('USD')
    expect(data.note).toContain('markup')
    const v31 = data.models.find((m: any) => m.id === 'tripo-v3.1')
    expect(v31).toMatchObject({ text_to_model: true, image_to_model: true, price: { unit: 'model' } })
    expect(v31.price.usd).toBeCloseTo(0.24, 4)
    const p1 = data.models.find((m: any) => m.id === 'tripo-p1')
    expect(p1.price.usd).toBeCloseTo(0.48, 4)
  })

  test('lists nothing when the key is absent', async () => {
    const saved = process.env.TRIPO_API_KEY
    delete process.env.TRIPO_API_KEY
    try {
      const data = await (await call('/ai/v1/3d/models')).json() as any
      expect(data.models).toEqual([])
    } finally {
      process.env.TRIPO_API_KEY = saved
    }
  })

  test('bad token answers 401', async () => {
    const res = await app.fetch(new Request('http://x/api/ai/v1/3d/models'))
    expect(res.status).toBe(401)
  })
})

// =========================================================================
// Pricing
// =========================================================================

describe('estimateTripoTaskCost', () => {
  const usd = (p: Parameters<typeof estimateTripoTaskCost>[0]) => estimateTripoTaskCost(p).billedUsd

  test('H-series text-to-model: 10 / 20 / 30 / 40 credits', () => {
    expect(usd({ model: 'tripo-v3.1', input: 'text', texture: false })).toBeCloseTo(0.1 * 1.2, 6)
    expect(usd({ model: 'tripo-v3.1', input: 'text', textureQuality: 'standard' })).toBeCloseTo(0.2 * 1.2, 6)
    expect(usd({ model: 'tripo-v3.1', input: 'text', textureQuality: 'detailed' })).toBeCloseTo(0.3 * 1.2, 6)
    expect(usd({ model: 'tripo-v3.1', input: 'text', textureQuality: 'extreme' })).toBeCloseTo(0.4 * 1.2, 6)
  })

  test('H-series image-to-model: 20 / 30 / 40 / 50 credits', () => {
    expect(usd({ model: 'tripo-v3.1', input: 'image', texture: false })).toBeCloseTo(0.2 * 1.2, 6)
    expect(usd({ model: 'tripo-v3.1', input: 'image', textureQuality: 'standard' })).toBeCloseTo(0.3 * 1.2, 6)
    expect(usd({ model: 'tripo-v3.1', input: 'image', textureQuality: 'detailed' })).toBeCloseTo(0.4 * 1.2, 6)
    expect(usd({ model: 'tripo-v3.1', input: 'image', textureQuality: 'extreme' })).toBeCloseTo(0.5 * 1.2, 6)
  })

  test('P-series adds 20 credits to every cell', () => {
    expect(usd({ model: 'tripo-p1', input: 'text', texture: false })).toBeCloseTo(0.3 * 1.2, 6)
    expect(usd({ model: 'tripo-p1', input: 'text', textureQuality: 'standard' })).toBeCloseTo(0.4 * 1.2, 6)
    expect(usd({ model: 'tripo-p1', input: 'text', textureQuality: 'detailed' })).toBeCloseTo(0.5 * 1.2, 6)
    expect(usd({ model: 'tripo-p1', input: 'text', textureQuality: 'extreme' })).toBeCloseTo(0.6 * 1.2, 6)
    expect(usd({ model: 'tripo-p1', input: 'image', texture: false })).toBeCloseTo(0.4 * 1.2, 6)
    expect(usd({ model: 'tripo-p1', input: 'image', textureQuality: 'standard' })).toBeCloseTo(0.5 * 1.2, 6)
    expect(usd({ model: 'tripo-p1', input: 'image', textureQuality: 'detailed' })).toBeCloseTo(0.6 * 1.2, 6)
    expect(usd({ model: 'tripo-p1', input: 'image', textureQuality: 'extreme' })).toBeCloseTo(0.7 * 1.2, 6)
  })

  test('texture defaults on, so an argument-less call prices the textured task', () => {
    expect(usd({ model: 'tripo-v3.1' })).toBeCloseTo(0.24, 6)
  })

  test('calculate3dUsageCost bills credits at $0.01 with the markup', () => {
    expect(calculate3dUsageCost(20)).toEqual({ rawUsd: 0.2, billedUsd: 0.2 * 1.2 })
    expect(calculate3dUsageCost(0)).toEqual({ rawUsd: 0, billedUsd: 0 })
  })
})
