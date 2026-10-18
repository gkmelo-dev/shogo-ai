// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo 3d` — the same Tripo task set the agent's 3D tools expose, from a
 * shell. Every call goes through the AI proxy (`/api/ai/v1/3d/*`), which holds
 * the vendor key and meters the usage; the CLI only ever sees the
 * project-scoped proxy token in `AI_PROXY_TOKEN`.
 *
 *   shogo 3d models
 *   shogo 3d generate --prompt "a low-poly fox" [--out models/fox.glb]
 *   shogo 3d generate --image refs/chair.png
 *   shogo 3d generate --views front=a.png,left=b.png
 *   shogo 3d edit --op rig --input gen3d_abc --rig-type quadruped
 *   shogo 3d status gen3d_abc
 *
 * Dependency-injected (`fetch`, `env`, `stdout`) so the whole command is
 * unit-testable without a network or a runtime.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, extname, resolve } from 'path'

export interface ThreeDCliDeps {
  fetch: typeof fetch
  env: NodeJS.ProcessEnv
  cwd: string
  stdout: (line: string) => void
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_POLL_MS = 2_500
const DEFAULT_TIMEOUT_MS = 15 * 60_000

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

const EDIT_OPS = new Set([
  'texture',
  'convert',
  'retopology',
  'segment',
  'rig',
  'retarget',
  'complete',
  'rig_check',
  'import',
])

const FORMAT_EXT: Record<string, string> = {
  gltf: '.glb',
  glb: '.glb',
  fbx: '.fbx',
  usdz: '.usdz',
  obj: '.obj',
  stl: '.stl',
  '3mf': '.3mf',
}

interface ParsedFlags {
  values: Record<string, string>
  booleans: Record<string, boolean>
}

/** `--k v`, `--k=v`, `--no-k`, and positional args (returned in `values._`). */
function parseFlags(argv: string[], booleanFlags: Set<string>): ParsedFlags {
  const values: Record<string, string> = {}
  const booleans: Record<string, boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    if (body.startsWith('no-')) {
      booleans[body.slice(3)] = false
      continue
    }
    const eq = body.indexOf('=')
    if (eq !== -1) {
      values[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    if (booleanFlags.has(body)) {
      booleans[body] = true
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      values[body] = next
      i++
    } else {
      booleans[body] = true
    }
  }
  if (positional.length) values._ = positional.join(' ')
  return { values, booleans }
}

function proxyConfig(env: NodeJS.ProcessEnv): { base: string; token: string } | string {
  const url = env.AI_PROXY_URL || env.SHOGO_AI_PROXY_URL
  const token = env.AI_PROXY_TOKEN
  if (!url) {
    return 'AI_PROXY_URL is not set. `shogo 3d` only works inside a Shogo runtime (run `shogo dev` there first).'
  }
  if (!token) {
    return 'AI_PROXY_TOKEN is not set, so the proxy cannot authenticate this project. Run `shogo dev` to mint one, or set it yourself.'
  }
  return { base: url.replace(/\/v1\/?$/, ''), token }
}

/** Readable error out of a proxy error body (the proxy already writes prose). */
function messageFrom(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body)
    const message = parsed?.error?.message ?? parsed?.error ?? parsed?.message
    if (typeof message === 'string' && message.trim()) return message
  } catch {
    /* not JSON */
  }
  if (status === 402) return 'This project is out of usage credit. Add credit and try again.'
  if (status === 413) return 'That file is too large (max 25MB). Upload it yourself and pass a URL, or reuse a job id.'
  if (status === 503) return '3D generation is not configured on this server (no Tripo key).'
  return `3D request failed (HTTP ${status}).`
}

function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (slug.split('-').slice(0, 4).join('-') || 'model').slice(0, 48)
}

function dataUriFor(cwd: string, workspacePath: string): string {
  const absolute = resolve(cwd, workspacePath)
  if (!existsSync(absolute)) throw new Error(`File not found: ${workspacePath}`)
  const mime = IMAGE_MIME[extname(absolute).toLowerCase()] || 'image/png'
  return `data:${mime};base64,${readFileSync(absolute).toString('base64')}`
}

interface OperationResult {
  id: string
  status: 'queued' | 'running' | 'success' | 'failed'
  model_url?: string
  model_urls?: string[]
  parts?: string[]
  riggable?: boolean
  rig_type?: string
  progress?: number
  credits_consumed?: number
  billed_usd?: number
  error?: string
}

async function pollUntilDone(
  deps: ThreeDCliDeps,
  proxy: { base: string; token: string },
  id: string,
  opts: { wait: boolean; timeoutMs: number },
): Promise<OperationResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = Date.now() + opts.timeoutMs
  let last = ''
  while (true) {
    const response = await deps.fetch(`${proxy.base}/v1/3d/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${proxy.token}` },
    })
    if (!response.ok) throw new Error(messageFrom(response.status, await response.text()))
    const result = (await response.json()) as OperationResult
    if (result.status === 'success' || result.status === 'failed') return result
    if (result.status !== last) {
      last = result.status
      const pct = result.progress !== undefined ? ` ${result.progress}%` : ''
      if (opts.wait) deps.stdout(`  ${result.status}${pct}`)
    }
    if (!opts.wait || Date.now() + DEFAULT_POLL_MS > deadline) return result
    await sleep(DEFAULT_POLL_MS)
  }
}

async function downloadAll(
  deps: ThreeDCliDeps,
  result: OperationResult,
  out: string | undefined,
  fallbackName: string,
): Promise<string[]> {
  const urls = result.model_urls?.length ? result.model_urls : result.model_url ? [result.model_url] : []
  if (!urls.length) return []
  const target = out ? resolve(deps.cwd, out) : resolve(deps.cwd, 'models', fallbackName)
  mkdirSync(dirname(target), { recursive: true })
  const written: string[] = []
  for (const [index, url] of urls.entries()) {
    const path = index === 0 ? target : target.replace(/(\.[^.]+)$/, `-${index + 1}$1`)
    const response = await deps.fetch(url)
    if (!response.ok) throw new Error(`Download failed (${response.status}); the model URL expires after about five minutes.`)
    writeFileSync(path, Buffer.from(await response.arrayBuffer()))
    written.push(path)
  }
  return written
}

/** POST a task and (optionally) wait, download and report. */
async function runOperation(
  deps: ThreeDCliDeps,
  proxy: { base: string; token: string },
  body: Record<string, unknown>,
  opts: { out?: string; fallbackName: string; wait: boolean; timeoutMs: number },
): Promise<number> {
  const response = await deps.fetch(`${proxy.base}/v1/3d/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    deps.stdout(`error: ${messageFrom(response.status, await response.text())}`)
    return 1
  }
  const submitted = (await response.json()) as { id: string; estimated_usd?: number }
  deps.stdout(`task ${submitted.id}${submitted.estimated_usd !== undefined ? ` (~$${submitted.estimated_usd.toFixed(2)})` : ''}`)

  const result = await pollUntilDone(deps, proxy, submitted.id, opts)
  if (result.status === 'failed') {
    deps.stdout(`error: ${result.error ?? 'the task failed'}`)
    return 1
  }
  const cost = result.credits_consumed !== undefined ? ` — ${result.credits_consumed} credits` : ''
  if (result.status !== 'success') {
    deps.stdout(`still ${result.status}; check again with: shogo 3d status ${submitted.id}`)
    return 0
  }
  const saved = await downloadAll(deps, result, opts.out, opts.fallbackName)
  for (const path of saved) deps.stdout(`saved ${path}`)
  if (result.parts?.length) deps.stdout(`parts: ${result.parts.join(', ')}`)
  if (result.riggable !== undefined) {
    deps.stdout(`riggable: ${result.riggable ? `yes (${result.rig_type ?? 'type unknown'})` : 'no'}`)
  }
  deps.stdout(`done${cost}`)
  return 0
}

export async function runThreeDCommand(argv: string[], deps: ThreeDCliDeps): Promise<number> {
  const [sub = 'help', ...rest] = argv
  const config = proxyConfig(deps.env)

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    deps.stdout(`shogo 3d <command>

Commands:
  generate            Text, a single image, or orthographic views → a new model
    --prompt <text>     text-to-3D
    --image <path>      image-to-3D (workspace path)
    --views <list>      multiview-to-3D: front=a.png,left=b.png,back=c.png,right=d.png
    --model <id>        tripo-v3.1 (default) | tripo-p1 …
    --format <fmt>      glb (default) | fbx | usdz
    --texture / --no-texture
    --texture-quality   standard | detailed | extreme
    --face-limit <n>
    --out <path>        default models/<slug>-<task>.glb
    --no-wait           return the job id immediately
  edit                Refine an existing model (see --op)
    --op <op>           texture | convert | retopology | segment | rig | retarget |
                        complete | rig_check | import
    --input <ref>       job id (gen3d_…), workspace path, or https URL
    --texture-prompt <text>     texture
    --texture-quality <q>       texture
    --pbr                       texture
    --format <fmt>              convert (GLTF | FBX | USDZ | OBJ | STL | 3MF)
    --face-limit <n> / --quad   retopology
    --rig-type <type>           rig (biped | quadruped | hexapod | octopod | avian | serpentine | aquatic)
    --animation <ids>           retarget (preset:walk, or up to five, comma-separated)
    --part-names <a,b>          complete
    --out <path> / --no-wait
  status <job_id>     Show a task's state without waiting
  models              List generation models and per-operation prices

Environment:
  AI_PROXY_URL    ${deps.env.AI_PROXY_URL ? '(set)' : '(missing)'}
  AI_PROXY_TOKEN  ${deps.env.AI_PROXY_TOKEN ? '(set)' : '(missing)'}`)
    return 0
  }

  if (typeof config === 'string') {
    deps.stdout(`error: ${config}`)
    return 1
  }

  if (sub === 'models') {
    const response = await deps.fetch(`${config.base}/v1/3d/models`, {
      headers: { Authorization: `Bearer ${config.token}` },
    })
    if (!response.ok) {
      deps.stdout(`error: ${messageFrom(response.status, await response.text())}`)
      return 1
    }
    const data = (await response.json()) as {
      models?: Array<{ id: string; name?: string; price?: { usd?: number; untextured_usd?: number } }>
      operations?: Array<{ op: string; credits?: number; usd?: number; free?: boolean; sync?: boolean }>
    }
    if (!data.models?.length) {
      deps.stdout('No 3D models available: this server has no Tripo key, so nothing can run.')
      return 0
    }
    deps.stdout('Models:')
    for (const model of data.models) {
      const price = model.price?.usd !== undefined ? `$${model.price.usd.toFixed(2)}` : ''
      deps.stdout(`  ${model.id.padEnd(26)} ${price}${model.name ? `  ${model.name}` : ''}`)
    }
    if (data.operations?.length) {
      deps.stdout('Operations:')
      for (const op of data.operations) {
        const price = op.free ? 'free' : op.usd !== undefined ? `$${op.usd.toFixed(2)}` : `${op.credits ?? '?'} credits`
        deps.stdout(`  ${op.op.padEnd(16)} ${price}`)
      }
    }
    return 0
  }

  if (sub === 'status') {
    const id = rest[0]
    if (!id) {
      deps.stdout('error: usage: shogo 3d status <job_id>')
      return 1
    }
    const response = await deps.fetch(`${config.base}/v1/3d/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${config.token}` },
    })
    if (!response.ok) {
      deps.stdout(`error: ${messageFrom(response.status, await response.text())}`)
      return 1
    }
    deps.stdout(JSON.stringify(await response.json(), null, 2))
    return 0
  }

  if (sub === 'generate') {
    const flags = parseFlags(rest, new Set(['texture', 'pbr', 'quad', 'wait']))
    const prompt = flags.values.prompt
    const image = flags.values.image
    const views = flags.values.views
    const inputs = [prompt, image, views].filter(Boolean).length
    if (inputs === 0) {
      deps.stdout('error: pass --prompt, --image or --views.')
      return 1
    }
    if (inputs > 1) {
      deps.stdout('error: pass one of --prompt, --image or --views, not several.')
      return 1
    }

    let body: Record<string, unknown>
    let name: string
    try {
      if (views) {
        const parsed: Record<string, string> = {}
        for (const pair of views.split(',')) {
          const [side, path] = pair.split('=').map((s) => s?.trim())
          if (!side || !path) throw new Error(`--views expects front=a.png,left=b.png — got "${pair}"`)
          parsed[side] = dataUriFor(deps.cwd, path)
        }
        if (Object.keys(parsed).length < 2) throw new Error('--views needs at least two views of the same object.')
        body = { op: 'multiview_to_model', images: Object.values(parsed) }
        name = 'multiview'
      } else if (image) {
        body = { op: 'image_to_model', image: dataUriFor(deps.cwd, image) }
        name = slugify(image.split('/').pop() || 'model')
      } else {
        body = { op: 'text_to_model', prompt }
        name = slugify(prompt!)
      }
    } catch (err: any) {
      deps.stdout(`error: ${err.message}`)
      return 1
    }

    const format = (flags.values.format || 'glb').toLowerCase()
    const ext = FORMAT_EXT[format] ?? '.glb'
    Object.assign(body, {
      model: flags.values.model,
      format,
      texture: flags.booleans.texture,
      texture_quality: flags.values['texture-quality'],
      face_limit: flags.values['face-limit'] ? Number(flags.values['face-limit']) : undefined,
    })

    return runOperation(deps, config, body, {
      out: flags.values.out,
      fallbackName: `${name}${ext}`,
      wait: flags.booleans.wait !== false,
      timeoutMs: flags.values.timeout ? Number(flags.values.timeout) : DEFAULT_TIMEOUT_MS,
    })
  }

  if (sub === 'edit') {
    const flags = parseFlags(rest, new Set(['pbr', 'quad', 'wait', 'export-with-geometry']))
    const op = flags.values.op
    const input = flags.values.input
    if (!op || !EDIT_OPS.has(op)) {
      deps.stdout(`error: --op must be one of ${[...EDIT_OPS].join(', ')}.`)
      return 1
    }
    if (!input) {
      deps.stdout('error: --input is required (a gen3d_ job id, a workspace path, or a URL).')
      return 1
    }

    let ref = input
    if (!input.startsWith('gen3d_') && !/^https?:\/\//i.test(input)) {
      // A local model has to become a file_token first.
      const absolute = resolve(deps.cwd, input)
      if (!existsSync(absolute)) {
        deps.stdout(`error: file not found: ${input}`)
        return 1
      }
      const bytes = readFileSync(absolute)
      if (bytes.length > 25 * 1024 * 1024) {
        deps.stdout(
          `error: ${input} is ${(bytes.length / 1024 / 1024).toFixed(1)}MB, over the 25MB upload limit. ` +
            'Pass the job id from a previous generate instead.',
        )
        return 1
      }
      const upload = await deps.fetch(`${config.base}/v1/3d/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
        body: JSON.stringify({
          filename: input.split('/').pop() || 'model.glb',
          content_base64: bytes.toString('base64'),
        }),
      })
      if (!upload.ok) {
        deps.stdout(`error: ${messageFrom(upload.status, await upload.text())}`)
        return 1
      }
      const uploaded = (await upload.json()) as { file_token?: string }
      if (!uploaded.file_token) {
        deps.stdout('error: the proxy did not return a file_token for the upload.')
        return 1
      }
      ref = uploaded.file_token
    }

    const body: Record<string, unknown> = {
      op,
      input: ref,
      texture_prompt: flags.values['texture-prompt'] ? { text: flags.values['texture-prompt'] } : undefined,
      texture_quality: flags.values['texture-quality'],
      pbr: flags.booleans.pbr,
      format: flags.values.format,
      face_limit: flags.values['face-limit'] ? Number(flags.values['face-limit']) : undefined,
      quad: flags.booleans.quad,
      rig_type: flags.values['rig-type'],
      animation: flags.values.animation
        ? flags.values.animation.split(',').map((a) => a.trim()).filter(Boolean)
        : undefined,
      part_names: flags.values['part-names'] ? flags.values['part-names'].split(',').map((s) => s.trim()) : undefined,
      model: flags.values.model,
      out_format: flags.values['out-format'],
      export_with_geometry: flags.booleans['export-with-geometry'],
    }

    const ext = op === 'convert' ? FORMAT_EXT[(flags.values.format || 'GLTF').toLowerCase()] ?? '.glb' : '.glb'
    return runOperation(deps, config, body, {
      out: flags.values.out,
      fallbackName: `${op}-${slugify(input)}${ext}`,
      wait: flags.booleans.wait !== false,
      timeoutMs: flags.values.timeout ? Number(flags.values.timeout) : DEFAULT_TIMEOUT_MS,
    })
  }

  deps.stdout(`error: unknown 3d command "${sub}". Run \`shogo 3d help\`.`)
  return 1
}
