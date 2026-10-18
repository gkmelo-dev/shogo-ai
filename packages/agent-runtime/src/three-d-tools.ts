// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * 3D models through the AI proxy (`/ai/v1/3d/*`), which holds the vendor key
 * and bills per task. Two tools:
 *
 *  - `generate_3d_model` — text / single image / four views → a new model.
 *  - `edit_3d_model`     — refine an existing model: texture, convert, retopo,
 *                          segment, rig, retarget, complete, rig_check, import.
 *
 * Opt-in behind `threeDGenEnabled` — every paid task costs real money.
 *
 * Same submit → poll → save shape as `generate_video`, including the
 * `wait: false` + `job_id` hand-off. The helpers below are local on purpose:
 * `media-tools.ts` imports this module for `createMediaTools`, so importing
 * back from it would make the two cycle.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, extname, relative, resolve, sep } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './gateway-tools'
import { textResult } from './gateway-tools'
import { assertWithinWorkspace } from './permission-engine'

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export const THREE_D_DEFAULT_MODEL = 'tripo-v3.1'

/** Rig model versions — not generation ids; the animations API rejects those. */
export const THREE_D_DEFAULT_RIG_MODEL = 'v2.5-20260210'

/**
 * Poll cadence and the blocking budget for `wait: true`. Tripo asks for ≤1
 * request/second. Ten minutes covers the slowest op measured live
 * (`complete`, 306s) with room for a rig + retarget chain.
 */
export const THREE_D_POLL = { intervalMs: 2_500, timeoutMs: 10 * 60_000 }

export type ThreeDOp =
  | 'text_to_model'
  | 'image_to_model'
  | 'multiview_to_model'
  | 'texture'
  | 'convert'
  | 'retopology'
  | 'segment'
  | 'rig'
  | 'retarget'
  | 'complete'
  | 'rig_check'
  | 'import'

/** Ops whose result is files (everything else reports metadata only). */
const OPS_WITHOUT_FILE: ReadonlySet<ThreeDOp> = new Set<ThreeDOp>(['segment', 'complete', 'rig_check'])

/** Formats `convert` can emit, with the file extension each one saves as. */
export const THREE_D_FORMAT_EXT: Record<string, string> = {
  GLTF: '.glb',
  GLB: '.glb',
  FBX: '.fbx',
  USDZ: '.usdz',
  OBJ: '.obj',
  STL: '.stl',
  '3MF': '.3mf',
}

/** Formats accepted by `rig`, `retarget` and the generate ops. */
const THREE_D_RIG_FORMATS = ['glb', 'fbx', 'usdz'] as const

type ThreeDJobState = 'queued' | 'running' | 'success' | 'failed'

interface ThreeDStatusResponse {
  id: string
  op?: ThreeDOp
  status: ThreeDJobState
  progress?: number
  model_url?: string
  model_urls?: string[]
  parts?: string[]
  riggable?: boolean
  rig_type?: string
  credits_consumed?: number
  billed_usd?: number
  error?: string
}

interface ProxyConfig {
  /** `${apiBase}/api/ai` — routes are appended as `/v1/...`. */
  base: string
  token: string
}

interface OutputTarget {
  absolute: string
  workspacePath: string
}

interface TrackedThreeDJob {
  id: string
  op: ThreeDOp
  prompt?: string
  model: string
  input: 'text' | 'image' | 'multiview' | 'model'
  target: OutputTarget
  /** Saved file extension, or null when the op returns metadata only. */
  ext: string | null
  status: ThreeDJobState
  progress?: number
  path?: string
  paths?: string[]
  /** Segment part handles, or the rig type from `rig_check`. */
  parts?: string[]
  riggable?: boolean
  rigType?: string
  bytes?: number
  creditsConsumed?: number
  billedUsd?: number
  error?: string
  /** Settles when the background follower finishes (saved, failed or gave up). */
  done?: Promise<void>
}

/** Jobs submitted from this runtime, so a later call with `job_id` knows where to save. */
const trackedThreeDJobs = new Map<string, TrackedThreeDJob>()

function proxyConfig(ctx: ToolContext): ProxyConfig | null {
  const url = ctx.aiProxyUrl || process.env.AI_PROXY_URL
  const token = ctx.aiProxyToken || process.env.AI_PROXY_TOKEN
  if (!url || !token) return null
  return { base: url.replace(/\/v1\/?$/, ''), token }
}

function toWorkspaceRelative(workspaceDir: string, absolutePath: string): string {
  return relative(resolve(workspaceDir), absolutePath).split(sep).join('/')
}

function normalizeExt(value?: string): string {
  if (!value) return '.glb'
  return value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`
}

/** `a red fox sitting in a forest` → `a-red-fox-sitting`, for the default filename. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (slug.split('-').slice(0, 4).join('-') || 'model').slice(0, 48)
}

/**
 * Where the output lands. `path` may point anywhere in the workspace (validated
 * by `assertWithinWorkspace`); without it the file goes to `models/` under the
 * caller's filename. The extension follows the format the op produces.
 */
function resolveOutputTarget(
  ctx: ToolContext,
  opts: { path?: string; filename: string; ext: string },
): OutputTarget {
  let absolute: string
  if (opts.path) {
    absolute = assertWithinWorkspace(ctx.workspaceDir, opts.path)
    if (absolute === resolve(ctx.workspaceDir)) throw new Error('path must name a file, not the workspace root.')
    if (!extname(absolute)) absolute = `${absolute}${opts.ext}`
  } else {
    const safe = opts.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    absolute = resolve(
      ctx.workspaceDir,
      'models',
      extname(safe) ? safe : `${safe}${opts.ext}`,
    )
  }
  mkdirSync(dirname(absolute), { recursive: true })
  return { absolute, workspacePath: toWorkspaceRelative(ctx.workspaceDir, absolute) }
}

/** The proxy accepts a data URI for image-to-model and uploads it upstream itself. */
function loadWorkspaceImageDataUri(ctx: ToolContext, workspacePath: string): { dataUri: string } | { error: string } {
  const resolved = assertWithinWorkspace(ctx.workspaceDir, workspacePath)
  if (!existsSync(resolved)) return { error: `Image not found: ${workspacePath}` }
  const mimeType = IMAGE_MIME_BY_EXT[extname(resolved).toLowerCase()] || 'image/png'
  return { dataUri: `data:${mimeType};base64,${readFileSync(resolved).toString('base64')}` }
}

/**
 * Short, actionable message instead of a raw proxy error body. The proxy's
 * `error` field is already user-facing prose, so it wins over these fallbacks.
 */
function errorFromBody(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body)
    const message = parsed?.error?.message ?? parsed?.error ?? parsed?.message
    if (typeof message === 'string' && message.trim()) return message
  } catch {
    // Not JSON — fall through.
  }
  if (status === 402) return 'This project is out of usage credit, so nothing was generated. Add credit and try again.'
  if (status === 413) return 'That file is too large to upload (max 25MB). Pass a job_id from an earlier generate_3d_model call instead.'
  if (status === 503) return '3D generation is not configured on this server yet (no Tripo key).'
  return `3D generation failed (HTTP ${status}).`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** POST a task to the proxy. Shared by both tools. */
async function submitThreeD(
  proxy: ProxyConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ id: string; status?: ThreeDJobState; model?: string; op?: ThreeDOp; estimated_usd?: number } | { error: string }> {
  try {
    const response = await fetch(`${proxy.base}/v1/3d/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) return { error: errorFromBody(response.status, await response.text()) }
    return (await response.json()) as { id: string; model?: string; op?: ThreeDOp; estimated_usd?: number }
  } catch (err: any) {
    return { error: `3D generation error: ${err.message}` }
  }
}

/**
 * Upload a workspace model for `import`. The proxy caps JSON bodies at 25MB —
 * past that the caller should pass a `job_id` or a public URL instead.
 */
async function uploadModelFile(
  ctx: ToolContext,
  proxy: ProxyConfig,
  workspacePath: string,
  signal?: AbortSignal,
): Promise<{ file_token: string } | { error: string }> {
  const resolved = assertWithinWorkspace(ctx.workspaceDir, workspacePath)
  if (!existsSync(resolved)) return { error: `Model not found: ${workspacePath}` }
  const bytes = readFileSync(resolved)
  if (bytes.length > 25 * 1024 * 1024) {
    return {
      error:
        `${workspacePath} is ${(bytes.length / 1024 / 1024).toFixed(1)}MB, over the 25MB upload limit. ` +
        'Pass the job_id returned by generate_3d_model instead (e.g. "gen3d_abc123"), or a public URL.',
    }
  }
  try {
    const response = await fetch(`${proxy.base}/v1/3d/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({
        filename: workspacePath.split('/').pop() || 'model.glb',
        content_base64: bytes.toString('base64'),
      }),
      signal,
    })
    if (!response.ok) return { error: errorFromBody(response.status, await response.text()) }
    const body = (await response.json()) as { file_token?: string }
    if (!body.file_token) return { error: 'The proxy did not return a file_token for the upload.' }
    return { file_token: body.file_token }
  } catch (err: any) {
    return { error: `Model upload failed: ${err.message}` }
  }
}

async function fetchThreeDStatus(proxy: ProxyConfig, id: string, signal?: AbortSignal): Promise<ThreeDStatusResponse> {
  const response = await fetch(`${proxy.base}/v1/3d/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${proxy.token}` },
    signal,
  })
  if (!response.ok) throw new Error(errorFromBody(response.status, await response.text()))
  return (await response.json()) as ThreeDStatusResponse
}

function withSuffix(absolute: string, suffix: string): string {
  const ext = extname(absolute)
  return `${absolute.slice(0, absolute.length - ext.length)}${suffix}${ext}`
}

/**
 * Download and write the result. `model_url` is a signed vendor URL that
 * expires after ~5 minutes, so this runs the moment the job reports success.
 * Retarget can return several animations (`model_urls`); each gets its own file.
 */
async function saveOutputs(job: TrackedThreeDJob, status: ThreeDStatusResponse, signal?: AbortSignal): Promise<void> {
  job.creditsConsumed = status.credits_consumed
  job.billedUsd = status.billed_usd
  job.progress = 100
  if (status.riggable !== undefined) job.riggable = status.riggable
  if (status.rig_type) job.rigType = status.rig_type
  if (status.parts?.length) job.parts = status.parts

  if (job.ext === null) {
    job.status = 'success'
    return
  }

  const urls = status.model_urls?.length ? status.model_urls : status.model_url ? [status.model_url] : []
  if (!urls.length) throw new Error('The proxy reported success but returned no model URL.')

  const paths: string[] = []
  let bytes = 0
  for (const [index, url] of urls.entries()) {
    const absolute = index === 0 ? job.target.absolute : withSuffix(job.target.absolute, `-${index + 1}`)
    const response = await fetch(url, { signal })
    if (!response.ok) {
      throw new Error(`Model download failed (${response.status}); the URL expires after about 5 minutes.`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    writeFileSync(absolute, buffer)
    bytes += buffer.length
    paths.push(
      absolute === job.target.absolute
        ? job.target.workspacePath
        : toWorkspaceRelative(resolve(job.target.absolute, '..'), absolute),
    )
  }
  job.status = 'success'
  job.path = paths[0]
  job.paths = paths
  job.bytes = bytes
}

/**
 * Poll until the job settles, saving the file on completion. Returns false
 * when `deadline` passes first (the job is still running upstream).
 */
async function followThreeDJob(proxy: ProxyConfig, job: TrackedThreeDJob, deadline: number, signal?: AbortSignal): Promise<boolean> {
  while (true) {
    const status = await fetchThreeDStatus(proxy, job.id, signal)
    if (status.status === 'success') {
      await saveOutputs(job, status, signal)
      return true
    }
    if (status.status === 'failed') {
      job.status = 'failed'
      job.error = status.error || '3D generation failed'
      if (status.credits_consumed !== undefined) job.creditsConsumed = status.credits_consumed
      return true
    }
    job.status = status.status
    job.progress = status.progress
    if (Date.now() + THREE_D_POLL.intervalMs > deadline) return false
    await sleep(THREE_D_POLL.intervalMs, signal)
  }
}

/** Keep following a job after the tool call returns, so the file (and the charge) still lands. */
function followInBackground(proxy: ProxyConfig, job: TrackedThreeDJob): void {
  if (job.done) return
  const deadline = Date.now() + 60 * 60_000
  job.done = followThreeDJob(proxy, job, deadline)
    .then((settled) => {
      if (!settled) {
        job.status = 'failed'
        job.error = 'Gave up waiting for the model after an hour.'
      }
    })
    .catch((err) => {
      job.status = 'failed'
      job.error = err?.message || String(err)
      console.error(`[3d] background job ${job.id} failed:`, job.error)
    })
}

/** One line the agent can quote to the user about what the task cost. */
function costLine(job: TrackedThreeDJob): string | undefined {
  // rig_check and import cost nothing, so say so rather than "$0.00".
  if (job.creditsConsumed === 0) return 'This check is free (0 credits).'
  if (job.billedUsd !== undefined) {
    const credits = job.creditsConsumed !== undefined ? ` (${job.creditsConsumed} Tripo credits)` : ''
    return `Billed $${job.billedUsd.toFixed(2)}${credits}.`
  }
  if (job.creditsConsumed !== undefined) {
    if (job.creditsConsumed === 0) return 'This check is free (0 credits).'
    return `${job.creditsConsumed} Tripo credits consumed (100 credits = $1.00 of provider usage, billed at cost plus Shogo's markup).`
  }
  return undefined
}

function jobResult(job: TrackedThreeDJob, extra: Record<string, unknown> = {}) {
  return textResult({
    id: job.id,
    op: job.op,
    status: job.status,
    path: job.path,
    paths: job.paths ?? (job.path ? [job.path] : undefined),
    model: job.model,
    input: job.input,
    prompt: job.prompt,
    parts: job.parts,
    riggable: job.riggable,
    rig_type: job.rigType,
    progress: job.progress,
    credits_consumed: job.creditsConsumed,
    billed_usd: job.billedUsd,
    bytes: job.bytes,
    error: job.error,
    cost: costLine(job),
    ...extra,
  })
}

/** Save immediately (or hand off to the background follower) and shape the reply. */
async function settleJob(
  proxy: ProxyConfig,
  job: TrackedThreeDJob,
  opts: { wait?: boolean; toolName: string; signal?: AbortSignal; estimatedUsd?: number; message?: string },
) {
  const planned = job.target.workspacePath
  const checkHint = `${opts.toolName}({ job_id: "${job.id}" })`

  if (opts.wait === false) {
    followInBackground(proxy, job)
    return jobResult(job, {
      job_id: job.id,
      planned_path: planned,
      estimated_usd: opts.estimatedUsd,
      message: `Queued. ${opts.message ?? 'The model will be saved'} to ${planned} when it finishes; call ${checkHint} to check.`,
    })
  }

  try {
    const settled = await followThreeDJob(proxy, job, Date.now() + THREE_D_POLL.timeoutMs, opts.signal)
    if (!settled) {
      followInBackground(proxy, job)
      return jobResult(job, {
        job_id: job.id,
        planned_path: planned,
        estimated_usd: opts.estimatedUsd,
        message: `Still running after ${Math.round(THREE_D_POLL.timeoutMs / 60_000)} minutes. It will be saved to ${planned} when it finishes; call ${checkHint} to check.`,
      })
    }
    return jobResult(job, { estimated_usd: opts.estimatedUsd })
  } catch (err: any) {
    // The task keeps running upstream; keep following it so the file still lands.
    followInBackground(proxy, job)
    if (opts.signal?.aborted) {
      return jobResult(job, {
        job_id: job.id,
        planned_path: planned,
        message: `Stopped waiting. The job is still running and will be saved to ${planned}.`,
      })
    }
    return jobResult(job, { error: `3D generation error: ${err.message}`, job_id: job.id })
  }
}

async function checkThreeDJob(
  ctx: ToolContext,
  proxy: ProxyConfig,
  id: string,
  p: { path?: string; wait?: boolean },
  toolName: string,
  signal?: AbortSignal,
) {
  try {
    let job = trackedThreeDJobs.get(id)
    if (!job) {
      // Submitted elsewhere (another process, or before a restart): save where
      // the caller says, falling back to models/. Assume a GLB unless the
      // caller's path says otherwise.
      job = {
        id,
        op: 'text_to_model',
        model: THREE_D_DEFAULT_MODEL,
        input: 'text',
        ext: p.path ? normalizeExt(extname(p.path) || undefined) : '.glb',
        target: resolveOutputTarget(ctx, {
          path: p.path,
          filename: `model-${id.replace(/^gen3d_/, '')}`,
          ext: '.glb',
        }),
        status: 'queued',
      }
      trackedThreeDJobs.set(id, job)
    }
    if (job.status === 'success' || job.status === 'failed') return jobResult(job)

    if (p.wait === true) {
      const settled = await followThreeDJob(proxy, job, Date.now() + THREE_D_POLL.timeoutMs, signal)
      if (!settled) followInBackground(proxy, job)
      return jobResult(job)
    }

    const status = await fetchThreeDStatus(proxy, id, signal)
    job.progress = status.progress
    if (status.status === 'success') {
      await saveOutputs(job, status, signal)
    } else if (status.status === 'failed') {
      job.status = 'failed'
      job.error = status.error || '3D generation failed'
      if (status.credits_consumed !== undefined) job.creditsConsumed = status.credits_consumed
    } else {
      job.status = status.status
      // The background follower finishes the download even if the job outlasts this turn.
      followInBackground(proxy, job)
    }
    return jobResult(job)
  } catch (err: any) {
    return textResult({ id, error: `3D status check failed: ${err.message}` })
  }
}

export function createGenerate3DModelTool(ctx: ToolContext): AgentTool {
  return {
    name: 'generate_3d_model',
    description:
      'Generate a 3D model from a text prompt, a single still image, or four views of an object. ' +
      'Saves to models/ by default; pass path to save anywhere in the workspace. ' +
      'Billed per task — roughly $0.12-$0.60 depending on model and texture quality — so call list_media_models first to choose a model and budget. ' +
      'Takes under a minute, sometimes two. Pass wait: false to queue several, then call generate_3d_model({ job_id }) to check each one. ' +
      'To refine the result (texture, rig, retopology, export as FBX/USDZ), use edit_3d_model with the returned job id.',
    label: 'Generate 3D Model',
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({ description: 'What to build: subject, shape, style (e.g. "a low-poly red fox, game asset")' }),
      ),
      image: Type.Optional(
        Type.String({
          description: 'Workspace image path for image-to-3D (e.g. "refs/chair.png"). Pass prompt, image OR views — not more than one.',
        }),
      ),
      views: Type.Optional(
        Type.Object(
          {
            front: Type.Optional(Type.String({ description: 'Workspace path of the front view' })),
            left: Type.Optional(Type.String({ description: 'Workspace path of the left view' })),
            back: Type.Optional(Type.String({ description: 'Workspace path of the back view' })),
            right: Type.Optional(Type.String({ description: 'Workspace path of the right view' })),
          },
          { description: 'Multiview-to-3D: two to four orthographic views of the same object give the most faithful mesh.' },
        ),
      ),
      model: Type.Optional(
        Type.String({
          description: `3D model id (default "${THREE_D_DEFAULT_MODEL}"). Call list_media_models for ids and per-task prices: H-series ("tripo-v3.1") is cheaper, P-series ("tripo-p…") costs more and holds more detail.`,
        }),
      ),
      texture: Type.Optional(Type.Boolean({ description: 'Generate a texture for the mesh (default: model-dependent). Costs extra.' })),
      texture_quality: Type.Optional(
        Type.Union([Type.Literal('standard'), Type.Literal('detailed'), Type.Literal('extreme')], {
          description: 'Texture detail when texture is on; each step costs more credits.',
        }),
      ),
      face_limit: Type.Optional(
        Type.Integer({ minimum: 1000, maximum: 200000, description: 'Maximum triangle count for the mesh (lower = lighter file)' }),
      ),
      format: Type.Optional(
        Type.Union(THREE_D_RIG_FORMATS.map((f) => Type.Literal(f)), {
          description: 'Output file format (default "glb"; "fbx" and "usdz" are for engines and AR).',
        }),
      ),
      path: Type.Optional(
        Type.String({ description: 'Output path anywhere in the workspace (e.g. "public/assets/fox.glb"). "models/" is the default.' }),
      ),
      wait: Type.Optional(
        Type.Boolean({ description: 'Wait for the model to finish (default true). false returns a job_id immediately.' }),
      ),
      job_id: Type.Optional(
        Type.String({ description: 'Check (and save, once finished) a job started earlier with wait: false' }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const p = params as {
        prompt?: string
        image?: string
        views?: { front?: string; left?: string; back?: string; right?: string }
        model?: string
        texture?: boolean
        texture_quality?: 'standard' | 'detailed' | 'extreme'
        face_limit?: number
        format?: string
        path?: string
        wait?: boolean
        job_id?: string
      }
      const proxy = proxyConfig(ctx)
      if (!proxy) return textResult({ error: '3D generation is not available: AI proxy not configured.' })

      if (p.job_id) return checkThreeDJob(ctx, proxy, p.job_id, p, 'generate_3d_model', signal)

      const viewPaths = p.views ? Object.values(p.views).filter((v): v is string => !!v) : []
      const hasPrompt = typeof p.prompt === 'string' && p.prompt.trim().length > 0
      const hasImage = typeof p.image === 'string' && p.image.length > 0
      const hasViews = viewPaths.length > 0
      const inputs = [hasPrompt, hasImage, hasViews].filter(Boolean).length
      if (inputs > 1) {
        return textResult({
          error: 'Pass one input only: prompt for text-to-3D, image for a single still, or views for multiview-to-3D.',
        })
      }
      if (inputs === 0) {
        return textResult({
          error: 'prompt is required to generate a 3D model. Pass image or views instead, or job_id to check an earlier job.',
        })
      }
      if (hasViews && viewPaths.length < 2) {
        return textResult({ error: 'Multiview needs at least two views (front/left/back/right) of the same object.' })
      }

      let image: string | undefined
      let images: string[] | undefined
      try {
        if (hasImage) {
          const loaded = loadWorkspaceImageDataUri(ctx, p.image!)
          if ('error' in loaded) return textResult({ error: loaded.error })
          image = loaded.dataUri
        }
        if (hasViews) {
          images = viewPaths.map((view) => {
            const loaded = loadWorkspaceImageDataUri(ctx, view)
            if ('error' in loaded) throw new Error(loaded.error)
            return loaded.dataUri
          })
        }
      } catch (err: any) {
        return textResult({ error: err.message })
      }

      const op: ThreeDOp = hasViews ? 'multiview_to_model' : hasImage ? 'image_to_model' : 'text_to_model'
      const submitted = await submitThreeD(
        proxy,
        {
          op,
          prompt: hasPrompt ? p.prompt : undefined,
          image,
          images,
          model: p.model,
          texture: p.texture,
          texture_quality: p.texture_quality,
          face_limit: p.face_limit,
          format: p.format,
        },
        signal,
      )
      if ('error' in submitted) return textResult({ error: submitted.error })

      let target: OutputTarget
      try {
        const stem = `${slugify(p.prompt || (p.image ? p.image.split('/').pop() || 'model' : 'model'))}-${submitted.id.replace(/^gen3d_/, '')}`
        target = resolveOutputTarget(ctx, { path: p.path, filename: stem, ext: '.glb' })
      } catch (err: any) {
        return textResult({ error: err.message })
      }

      const job: TrackedThreeDJob = {
        id: submitted.id,
        op,
        prompt: p.prompt,
        model: submitted.model || p.model || THREE_D_DEFAULT_MODEL,
        input: hasViews ? 'multiview' : hasImage ? 'image' : 'text',
        target,
        ext: '.glb',
        status: 'queued',
      }
      trackedThreeDJobs.set(job.id, job)
      return settleJob(proxy, job, {
        wait: p.wait,
        toolName: 'generate_3d_model',
        signal,
        estimatedUsd: submitted.estimated_usd,
      })
    },
  }
}

/** Ops that take a model and return a refined one. */
const EDIT_OPS = [
  'texture',
  'convert',
  'retopology',
  'segment',
  'rig',
  'retarget',
  'complete',
  'rig_check',
  'import',
] as const

export type ThreeDEditOp = (typeof EDIT_OPS)[number]

export function createEdit3DModelTool(ctx: ToolContext): AgentTool {
  return {
    name: 'edit_3d_model',
    description:
      'Refine an existing 3D model: re-texture, convert the format (FBX/USDZ/OBJ/STL), retopologise, split into parts, ' +
      'rig for animation, retarget an animation onto a rigged model, check whether a model can be rigged, or import your own. ' +
      'Pass the job id from generate_3d_model as `input` (e.g. "gen3d_abc123"), or a workspace .glb path, or a public URL. ' +
      'Each op has its own price (rig_check and import are free, rig is ~$0.25, segment/complete ~$0.40-$0.50) — ' +
      'pass op: "rig_check" first when you are unsure, and call list_media_models for the full per-op price list.',
    label: 'Edit 3D Model',
    parameters: Type.Object({
      op: Type.Union(
        EDIT_OPS.map((op) => Type.Literal(op)),
        {
          description:
            'texture (repaint the surface), convert (change file format), retopology (cleaner, lighter mesh), ' +
            'segment (split into named parts), rig (add a skeleton), retarget (apply an animation to a rigged model), ' +
            'complete (finish a part into a whole model), rig_check (free: can this be rigged?), import (free: bring in your own model).',
        },
      ),
      input: Type.Optional(
        Type.String({
          description:
            'The model to work on: a job id from generate_3d_model ("gen3d_…"), a workspace path (".glb", up to 25MB), or an https URL. ' +
            'Required for every op except import, which takes a workspace path or URL.',
        }),
      ),
      texture_prompt: Type.Optional(Type.String({ description: 'texture: what the surface should look like (e.g. "weathered orange fur")' })),
      texture_quality: Type.Optional(
        Type.Union([Type.Literal('standard'), Type.Literal('detailed'), Type.Literal('extreme')], {
          description: 'texture: detail level; each step costs more credits.',
        }),
      ),
      pbr: Type.Optional(Type.Boolean({ description: 'texture: produce PBR maps (metallic/roughness), not just base colour.' })),
      format: Type.Optional(
        Type.String({ description: 'convert: target format — GLTF, FBX, USDZ, OBJ, STL or 3MF (default GLTF).' }),
      ),
      face_limit: Type.Optional(
        Type.Integer({ minimum: 500, maximum: 200000, description: 'retopology: target triangle count (lower = lighter file).' }),
      ),
      quad: Type.Optional(Type.Boolean({ description: 'retopology: quad mesh instead of triangles (better for sculpting).' })),
      rig_type: Type.Optional(
        Type.Union(
          [
            Type.Literal('biped'),
            Type.Literal('quadruped'),
            Type.Literal('hexapod'),
            Type.Literal('octopod'),
            Type.Literal('avian'),
            Type.Literal('serpentine'),
            Type.Literal('aquatic'),
          ],
          { description: 'rig: skeleton type. Use rig_check first — it reports which type fits the model.' },
        ),
      ),
      animation: Type.Optional(
        Type.String({
          description: 'retarget: one animation id or preset (e.g. "preset:walk", "preset:run"), or up to five separated by commas.',
        }),
      ),
      part_names: Type.Optional(
        Type.Array(Type.String(), { description: 'complete: which segment parts to finish (default: all parts).' }),
      ),
      model: Type.Optional(
        Type.String({ description: `rig/retarget: rig model version (default "${THREE_D_DEFAULT_RIG_MODEL}").` }),
      ),
      out_format: Type.Optional(
        Type.String({ description: 'rig/retarget: output format — glb (default), fbx or usdz.' }),
      ),
      export_with_geometry: Type.Optional(
        Type.Boolean({ description: 'retarget: include the mesh with the animation (default true).' }),
      ),
      path: Type.Optional(
        Type.String({ description: 'Output path anywhere in the workspace. Default: models/<op>-<inputs>-<id>.<ext>' }),
      ),
      wait: Type.Optional(
        Type.Boolean({ description: 'Wait for the task to finish (default true). false returns a job_id immediately.' }),
      ),
      job_id: Type.Optional(
        Type.String({ description: 'Check (and save, once finished) an edit job started earlier with wait: false' }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const p = params as {
        op: ThreeDEditOp
        input?: string
        texture_prompt?: string
        texture_quality?: 'standard' | 'detailed' | 'extreme'
        pbr?: boolean
        format?: string
        face_limit?: number
        quad?: boolean
        rig_type?: string
        animation?: string
        part_names?: string[]
        model?: string
        out_format?: string
        export_with_geometry?: boolean
        path?: string
        wait?: boolean
        job_id?: string
      }
      const proxy = proxyConfig(ctx)
      if (!proxy) return textResult({ error: '3D generation is not available: AI proxy not configured.' })

      if (p.job_id) return checkThreeDJob(ctx, proxy, p.job_id, p, 'edit_3d_model', signal)

      if (!p.input || !p.input.trim()) {
        return textResult({
          error: `input is required for op "${p.op}": pass the job id from generate_3d_model, a workspace .glb path, or a URL.`,
        })
      }

      // Workspace paths are uploaded and swapped for the token the API wants;
      // job ids and URLs go through so the proxy can resolve them.
      let input = p.input.trim()
      if (!/^gen3d_/.test(input) && !/^https?:\/\//i.test(input)) {
        const uploaded = await uploadModelFile(ctx, proxy, input, signal)
        if ('error' in uploaded) return textResult({ error: uploaded.error })
        input = uploaded.file_token
      }

      const submitted = await submitThreeD(
        proxy,
        {
          op: p.op,
          input,
          texture_prompt: p.texture_prompt ? { text: p.texture_prompt } : undefined,
          texture_quality: p.texture_quality,
          pbr: p.pbr,
          format: p.format,
          face_limit: p.face_limit,
          quad: p.quad,
          rig_type: p.rig_type,
          animation: p.animation ? p.animation.split(',').map((a) => a.trim()).filter(Boolean) : undefined,
          part_names: p.part_names,
          model: p.model,
          out_format: p.out_format,
          export_with_geometry: p.export_with_geometry,
        },
        signal,
      )
      if ('error' in submitted) return textResult({ error: submitted.error })

      const ext =
        p.op === 'convert'
          ? THREE_D_FORMAT_EXT[(p.format || 'GLTF').toUpperCase()] ?? '.glb'
          : OPS_WITHOUT_FILE.has(p.op as ThreeDOp)
            ? null
            : normalizeExt(p.out_format || '.glb')

      let target: OutputTarget
      try {
        const stem = `${p.op}-${slugify(p.texture_prompt || p.input)}-${submitted.id.replace(/^gen3d_/, '')}`
        target = resolveOutputTarget(ctx, { path: p.path, filename: stem, ext: ext ?? '.glb' })
      } catch (err: any) {
        return textResult({ error: err.message })
      }

      const job: TrackedThreeDJob = {
        id: submitted.id,
        op: p.op as ThreeDOp,
        prompt: p.texture_prompt,
        model: p.model || THREE_D_DEFAULT_RIG_MODEL,
        input: 'model',
        target,
        ext,
        status: 'queued',
      }
      trackedThreeDJobs.set(job.id, job)
      return settleJob(proxy, job, {
        wait: p.wait,
        toolName: 'edit_3d_model',
        signal,
        estimatedUsd: submitted.estimated_usd,
        message: ext === null ? 'The result' : 'The file will be saved',
      })
    },
  }
}

/** 3D tools registered alongside the image/video tools (gating: `filterDisabledCapabilityTools`). */
export function createThreeDTools(ctx: ToolContext): AgentTool[] {
  return [createGenerate3DModelTool(ctx), createEdit3DModelTool(ctx)]
}

/** Test seam. */
export const _testing = { trackedThreeDJobs }
