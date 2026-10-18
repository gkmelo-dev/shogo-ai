// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo 3d` — argument parsing, the per-operation payloads, format handling
 * and the download step, driven by an injected fetch (no network, no runtime).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runThreeDCommand, type ThreeDCliDeps } from '../three-d'

const CWD = join(import.meta.dir, '.three-d-cli-tmp')
const BASE = 'http://proxy.test/api/ai'

interface Recorded {
  url: string
  init?: RequestInit
}

let calls: Recorded[] = []
let responses: Array<{ prefix: string; handler: (url: string) => Response | Promise<Response> }> = []
let lines: string[] = []

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const binary = (bytes: number[]) => new Response(new Uint8Array(bytes))

function on(prefix: string, handler: (url: string) => Response | Promise<Response>) {
  responses.push({ prefix, handler })
}

function deps(env: NodeJS.ProcessEnv = { AI_PROXY_URL: `${BASE}/v1`, AI_PROXY_TOKEN: 'pt' }): ThreeDCliDeps {
  return {
    fetch: (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input)
      calls.push({ url, init })
      for (const route of responses) if (url.startsWith(route.prefix)) return route.handler(url)
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch,
    env,
    cwd: CWD,
    stdout: (line) => lines.push(line),
    sleep: async () => {},
  }
}

async function run(argv: string[], env?: NodeJS.ProcessEnv) {
  lines = []
  const code = await runThreeDCommand(argv, deps(env))
  return { code, out: lines.join('\n') }
}

function bodyOf(url: string) {
  const call = calls.find((c) => c.url === url)!
  return JSON.parse(String(call.init?.body ?? '{}'))
}

/** generations accepted, then the task reports success on the first poll. */
function task(id: string, output: Record<string, unknown>, credits = 20) {
  on(`${BASE}/v1/3d/generations`, () => json({ id, estimated_usd: 0.24 }))
  on(`${BASE}/v1/3d/${id}`, () => json({ id, status: 'success', credits_consumed: credits, ...output }))
}

beforeEach(() => {
  rmSync(CWD, { recursive: true, force: true })
  mkdirSync(CWD, { recursive: true })
  calls = []
  responses = []
  lines = []
})

afterEach(() => {
  rmSync(CWD, { recursive: true, force: true })
})

describe('shogo 3d', () => {
  test('help lists every operation and warns when the proxy env is missing', async () => {
    const { code, out } = await run(['help'], {})
    expect(code).toBe(0)
    expect(out).toContain('generate')
    expect(out).toContain('rig_check')
    expect(out).toContain('AI_PROXY_TOKEN  (missing)')
  })

  test('a missing proxy token is a clear error, not a crash', async () => {
    const { code, out } = await run(['models'], { AI_PROXY_URL: `${BASE}/v1` })
    expect(code).toBe(1)
    expect(out).toContain('AI_PROXY_TOKEN is not set')
  })

  test('generate --prompt posts text_to_model and saves the GLB', async () => {
    task('gen3d_u1', { model_url: 'http://cdn.test/u1.glb' })
    on('http://cdn.test/u1.glb', () => binary([1, 2, 3]))

    const { code, out } = await run(['generate', '--prompt', 'a low-poly red fox'])
    expect(code).toBe(0)
    const body = bodyOf(`${BASE}/v1/3d/generations`)
    expect(body.op).toBe('text_to_model')
    expect(body.prompt).toBe('a low-poly red fox')

    expect(out).toContain(`saved ${join(CWD, 'models')}`)
    const names = readdirSync(join(CWD, 'models'))
    expect(names).toHaveLength(1)
    expect(names[0]!.endsWith('.glb')).toBe(true)
    expect(readFileSync(join(CWD, 'models', names[0]!))).toEqual(Buffer.from([1, 2, 3]))
    expect(out).toContain('20 credits')
  })

  test('--out chooses the destination and --format picks the extension', async () => {
    task('gen3d_u2', { model_url: 'http://cdn.test/u2.fbx' })
    on('http://cdn.test/u2.fbx', () => binary([4]))

    const { code, out } = await run(['generate', '--prompt', 'a chair', '--format', 'fbx', '--out', 'assets/chair.fbx'])
    expect(code).toBe(0)
    expect(bodyOf(`${BASE}/v1/3d/generations`).format).toBe('fbx')
    expect(existsSync(join(CWD, 'assets/chair.fbx'))).toBe(true)
    expect(out).toContain('saved')
  })

  test('--views posts multiview_to_model with each image as a data URI', async () => {
    writeFileSync(join(CWD, 'front.png'), Buffer.from([137, 80, 78, 71]))
    writeFileSync(join(CWD, 'left.png'), Buffer.from([137, 80, 78, 71]))
    task('gen3d_u3', { model_url: 'http://cdn.test/u3.glb' })
    on('http://cdn.test/u3.glb', () => binary([5]))

    const { code } = await run(['generate', '--views', 'front=front.png,left=left.png'])
    expect(code).toBe(0)
    const body = bodyOf(`${BASE}/v1/3d/generations`)
    expect(body.op).toBe('multiview_to_model')
    expect(body.images).toHaveLength(2)
    expect(body.images[0].startsWith('data:image/png;base64,')).toBe(true)
  })

  test('two inputs at once is refused before any call', async () => {
    const { code, out } = await run(['generate', '--prompt', 'x', '--image', 'a.png'])
    expect(code).toBe(1)
    expect(out).toContain('one of --prompt, --image or --views')
    expect(calls).toHaveLength(0)
  })

  test('edit --op rig passes the rig type and waits for the result', async () => {
    task('gen3d_u4', { model_url: 'http://cdn.test/u4.glb' }, 25)
    on('http://cdn.test/u4.glb', () => binary([6]))

    const { code, out } = await run(['edit', '--op', 'rig', '--input', 'gen3d_abc', '--rig-type', 'quadruped'])
    expect(code).toBe(0)
    const body = bodyOf(`${BASE}/v1/3d/generations`)
    expect(body.op).toBe('rig')
    expect(body.input).toBe('gen3d_abc')
    expect(body.rig_type).toBe('quadruped')
    expect(out).toContain('25 credits')
  })

  test('edit --op rig_check reports riggability and saves nothing', async () => {
    on(`${BASE}/v1/3d/generations`, () => json({ id: 'gen3d_u5' }))
    on(`${BASE}/v1/3d/gen3d_u5`, () =>
      json({ id: 'gen3d_u5', status: 'success', credits_consumed: 0, riggable: true, rig_type: 'biped' }),
    )

    const { code, out } = await run(['edit', '--op', 'rig_check', '--input', 'gen3d_abc'])
    expect(code).toBe(0)
    expect(out).toContain('riggable: yes (biped)')
    expect(out).not.toContain('saved')
  })

  test('a local .glb is uploaded before the edit task is submitted', async () => {
    writeFileSync(join(CWD, 'mine.glb'), Buffer.from([103, 108, 84, 70]))
    on(`${BASE}/v1/3d/files`, () => json({ file_token: 'tok_9' }))
    task('gen3d_u6', { model_url: 'http://cdn.test/u6.glb' }, 30)
    on('http://cdn.test/u6.glb', () => binary([7]))

    const { code } = await run(['edit', '--op', 'retopology', '--input', 'mine.glb', '--face-limit', '4000'])
    expect(code).toBe(0)
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/3d/files'))!.init?.body)).filename).toBe('mine.glb')
    const body = bodyOf(`${BASE}/v1/3d/generations`)
    expect(body.input).toBe('tok_9')
    expect(body.face_limit).toBe(4000)
  })

  test('an unknown op fails before any network call', async () => {
    const { code, out } = await run(['edit', '--op', 'explode', '--input', 'gen3d_abc'])
    expect(code).toBe(1)
    expect(out).toContain('--op must be one of')
    expect(calls).toHaveLength(0)
  })

  test('a failed task reports the vendor error and exits non-zero', async () => {
    on(`${BASE}/v1/3d/generations`, () => json({ id: 'gen3d_u7' }))
    on(`${BASE}/v1/3d/gen3d_u7`, () => json({ id: 'gen3d_u7', status: 'failed', error: 'model rejected' }))

    const { code, out } = await run(['edit', '--op', 'rig', '--input', 'gen3d_abc'])
    expect(code).toBe(1)
    expect(out).toContain('model rejected')
  })

  test('--no-wait returns the job id so the shell is not blocked', async () => {
    on(`${BASE}/v1/3d/generations`, () => json({ id: 'gen3d_u8' }))
    on(`${BASE}/v1/3d/gen3d_u8`, () => json({ id: 'gen3d_u8', status: 'running', progress: 15 }))

    const { code, out } = await run(['generate', '--prompt', 'a mug', '--no-wait'])
    expect(code).toBe(0)
    expect(out).toContain('shogo 3d status gen3d_u8')
  })

  test('models lists prices, and says so when the server has no key', async () => {
    on(`${BASE}/v1/3d/models`, () => json({ models: [], operations: [] }))
    const empty = await run(['models'])
    expect(empty.code).toBe(0)
    expect(empty.out).toContain('No 3D models available')

    responses = []
    on(`${BASE}/v1/3d/models`, () =>
      json({
        models: [{ id: 'tripo-v3.1', price: { usd: 0.24 } }],
        operations: [
          { op: 'rig_check', free: true },
          { op: 'rig', usd: 0.29 },
        ],
      }),
    )
    const listed = await run(['models'])
    expect(listed.out).toContain('tripo-v3.1')
    expect(listed.out).toContain('rig_check')
    expect(listed.out).toContain('free')
  })
})
