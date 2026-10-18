// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * 3D generation: a text prompt or a single still image becomes a GLB model,
 * through the AI proxy (`/ai/v1/3d/*`), which holds the vendor key and bills
 * per task. Opt-in behind `threeDGenEnabled` — every task costs real money.
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

/** Poll cadence and the blocking budget for `wait: true`. Tripo asks for ≤1 request/second. */
export const THREE_D_POLL = { intervalMs: 2_500, timeoutMs: 5 * 60_000 }

type ThreeDJobState = 'queued' | 'running' | 'success' | 'failed'

interface ThreeDStatusResponse {
  id: string
  status: ThreeDJobState
  progress?: number
  model_url?: string
  credits_consumed?: number
  billed_usd?: number
  error?: string
}

interface ProxyConfig {
  /** `${apiBase}/api/ai` — routes are appended as `/v1/...`. */
  base: string
  token: string
}

interface GlbTarget {
  absolute: string
  workspacePath: string
}

interface TrackedThreeDJob {
  id: string
  prompt?: string
  model: string
  input: 'text' | 'image'
  target: GlbTarget
  status: ThreeDJobState
  progress?: number
  path?: string
  bytes?: number
  creditsConsumed?: number
  billedUsd?: number
  error?: string
  /** Settles when the background follower finishes (saved, failed or gave up). */
  done?: Promise<void>
}

/** Jobs submitted from this runtime, so a later `generate_3d_model({ job_id })` knows where to save. */
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

/** `a red fox sitting in a forest` → `a-red-fox-sitting`, for the default filename. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (slug.split('-').slice(0, 4).join('-') || 'model').slice(0, 48)
}

/**
 * Where the GLB lands. `path` may point anywhere in the workspace (validated
 * by `assertWithinWorkspace`); without it the file goes to `models/` under the
 * caller's filename. Always a `.glb`.
 */
function resolveGlbTarget(ctx: ToolContext, opts: { path?: string; filename: string }): GlbTarget {
  let absolute: string
  if (opts.path) {
    absolute = assertWithinWorkspace(ctx.workspaceDir, opts.path)
    if (absolute === resolve(ctx.workspaceDir)) throw new Error('path must name a file, not the workspace root.')
    if (!extname(absolute)) absolute = `${absolute}.glb`
  } else {
    const safe = opts.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    absolute = resolve(ctx.workspaceDir, 'models', safe.endsWith('.glb') ? safe : `${safe}.glb`)
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

/** Short, actionable message instead of a raw proxy error body. */
function errorFromBody(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body)
    const message = parsed?.error?.message ?? parsed?.error ?? parsed?.message
    if (typeof message === 'string' && message.trim()) return message
  } catch {
    // Not JSON — fall through.
  }
  if (status === 402) return 'This project is out of usage credit, so no 3D model was generated. Add credit and try again.'
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

async function fetchThreeDStatus(proxy: ProxyConfig, id: string, signal?: AbortSignal): Promise<ThreeDStatusResponse> {
  const response = await fetch(`${proxy.base}/v1/3d/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${proxy.token}` },
    signal,
  })
  if (!response.ok) throw new Error(errorFromBody(response.status, await response.text()))
  return (await response.json()) as ThreeDStatusResponse
}

/**
 * Download and write the GLB. `model_url` is a signed vendor URL that expires
 * after ~5 minutes, so this runs the moment the job reports success.
 */
async function saveGlb(job: TrackedThreeDJob, status: ThreeDStatusResponse, signal?: AbortSignal): Promise<void> {
  if (!status.model_url) throw new Error('The proxy reported success but returned no model_url.')
  const response = await fetch(status.model_url, { signal })
  if (!response.ok) throw new Error(`Model download failed (${response.status}); the URL expires after about 5 minutes.`)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(job.target.absolute, buffer)
  job.status = 'success'
  job.path = job.target.workspacePath
  job.bytes = buffer.length
  job.progress = 100
  job.creditsConsumed = status.credits_consumed
  job.billedUsd = status.billed_usd
}

/**
 * Poll until the job settles, saving the file on completion. Returns false
 * when `deadline` passes first (the job is still running upstream).
 */
async function followThreeDJob(proxy: ProxyConfig, job: TrackedThreeDJob, deadline: number, signal?: AbortSignal): Promise<boolean> {
  while (true) {
    const status = await fetchThreeDStatus(proxy, job.id, signal)
    if (status.status === 'success') {
      await saveGlb(job, status, signal)
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
      console.error(`[generate_3d_model] background job ${job.id} failed:`, job.error)
    })
}

/** One line the agent can quote to the user about what the task cost. */
function costLine(job: TrackedThreeDJob): string | undefined {
  if (job.billedUsd !== undefined) {
    const credits = job.creditsConsumed !== undefined ? ` (${job.creditsConsumed} Tripo credits)` : ''
    return `Billed $${job.billedUsd.toFixed(2)}${credits}.`
  }
  if (job.creditsConsumed !== undefined) {
    return `${job.creditsConsumed} Tripo credits consumed (100 credits = $1.00 of provider usage, billed at cost plus Shogo's markup).`
  }
  return undefined
}

function jobResult(job: TrackedThreeDJob, extra: Record<string, unknown> = {}) {
  return textResult({
    id: job.id,
    status: job.status,
    path: job.path,
    paths: job.path ? [job.path] : undefined,
    model: job.model,
    input: job.input,
    prompt: job.prompt,
    progress: job.progress,
    credits_consumed: job.creditsConsumed,
    billed_usd: job.billedUsd,
    bytes: job.bytes,
    error: job.error,
    cost: costLine(job),
    ...extra,
  })
}

export function createGenerate3DModelTool(ctx: ToolContext): AgentTool {
  return {
    name: 'generate_3d_model',
    description:
      'Generate a 3D model (GLB) from a text prompt, or from a single still image ("image to 3D"). ' +
      'Saves to models/ by default; pass path to save anywhere in the workspace. ' +
      'Billed per task — roughly $0.12-$0.60 depending on model and texture quality — so call list_media_models first to choose a model and budget. ' +
      'Text-to-3D takes under a minute, sometimes two. Pass wait: false to queue several, then call generate_3d_model({ job_id }) to check each one.',
    label: 'Generate 3D Model',
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({ description: 'What to build: subject, shape, style (e.g. "a low-poly red fox, game asset")' }),
      ),
      image: Type.Optional(
        Type.String({
          description: 'Workspace image path for image-to-3D (e.g. "refs/chair.png"). Pass prompt OR image, not both.',
        }),
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
        model?: string
        texture?: boolean
        texture_quality?: 'standard' | 'detailed' | 'extreme'
        face_limit?: number
        path?: string
        wait?: boolean
        job_id?: string
      }
      const proxy = proxyConfig(ctx)
      if (!proxy) return textResult({ error: '3D generation is not available: AI proxy not configured.' })

      if (p.job_id) return checkThreeDJob(ctx, proxy, p.job_id, p, signal)

      const hasPrompt = typeof p.prompt === 'string' && p.prompt.trim().length > 0
      const hasImage = typeof p.image === 'string' && p.image.length > 0
      if (hasPrompt && hasImage) {
        return textResult({ error: 'Pass either prompt or image, not both: a prompt builds from text, an image builds from a still.' })
      }
      if (!hasPrompt && !hasImage) {
        return textResult({
          error: 'prompt is required to generate a 3D model. Pass image instead for image-to-3D, or job_id to check an earlier job.',
        })
      }

      let image: string | undefined
      if (hasImage) {
        try {
          const loaded = loadWorkspaceImageDataUri(ctx, p.image!)
          if ('error' in loaded) return textResult({ error: loaded.error })
          image = loaded.dataUri
        } catch (err: any) {
          return textResult({ error: err.message })
        }
      }

      let submitted: { id: string; status?: ThreeDJobState; model: string; estimated_usd?: number }
      try {
        const response = await fetch(`${proxy.base}/v1/3d/generations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
          body: JSON.stringify({
            prompt: hasPrompt ? p.prompt : undefined,
            image,
            model: p.model,
            texture: p.texture,
            texture_quality: p.texture_quality,
            face_limit: p.face_limit,
          }),
          signal,
        })
        if (!response.ok) {
          return textResult({ error: errorFromBody(response.status, await response.text()) })
        }
        submitted = (await response.json()) as typeof submitted
      } catch (err: any) {
        return textResult({ error: `3D generation error: ${err.message}` })
      }

      let target: GlbTarget
      try {
        const stem = `${slugify(p.prompt || (p.image ? p.image.split('/').pop() || 'model' : 'model'))}-${submitted.id.replace(/^gen3d_/, '')}`
        target = resolveGlbTarget(ctx, { path: p.path, filename: stem })
      } catch (err: any) {
        return textResult({ error: err.message })
      }

      const job: TrackedThreeDJob = {
        id: submitted.id,
        prompt: p.prompt,
        model: submitted.model || p.model || THREE_D_DEFAULT_MODEL,
        input: hasImage ? 'image' : 'text',
        target,
        status: 'queued',
      }
      trackedThreeDJobs.set(job.id, job)
      const planned = target.workspacePath

      if (p.wait === false) {
        followInBackground(proxy, job)
        return jobResult(job, {
          job_id: job.id,
          planned_path: planned,
          estimated_usd: submitted.estimated_usd,
          message: `Queued. The GLB will be saved to ${planned} when it finishes; call generate_3d_model({ job_id: "${job.id}" }) to check.`,
        })
      }

      try {
        const settled = await followThreeDJob(proxy, job, Date.now() + THREE_D_POLL.timeoutMs, signal)
        if (!settled) {
          followInBackground(proxy, job)
          return jobResult(job, {
            job_id: job.id,
            planned_path: planned,
            estimated_usd: submitted.estimated_usd,
            message: `Still generating after ${Math.round(THREE_D_POLL.timeoutMs / 60_000)} minutes. It will be saved to ${planned} when it finishes; call generate_3d_model({ job_id: "${job.id}" }) to check.`,
          })
        }
        return jobResult(job, { estimated_usd: submitted.estimated_usd })
      } catch (err: any) {
        // The task keeps running upstream; keep following it so the file still lands.
        followInBackground(proxy, job)
        if (signal?.aborted) {
          return jobResult(job, {
            job_id: job.id,
            planned_path: planned,
            message: `Stopped waiting. The model is still generating and will be saved to ${planned}.`,
          })
        }
        return jobResult(job, { error: `3D generation error: ${err.message}`, job_id: job.id })
      }
    },
  }
}

async function checkThreeDJob(
  ctx: ToolContext,
  proxy: ProxyConfig,
  id: string,
  p: { path?: string; wait?: boolean },
  signal?: AbortSignal,
) {
  try {
    let job = trackedThreeDJobs.get(id)
    if (!job) {
      // Submitted elsewhere (another process, or before a restart): save where
      // the caller says, falling back to models/.
      job = {
        id,
        model: THREE_D_DEFAULT_MODEL,
        input: 'text',
        target: resolveGlbTarget(ctx, { path: p.path, filename: `model-${id.replace(/^gen3d_/, '')}` }),
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
      await saveGlb(job, status, signal)
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

/** 3D tools registered alongside the image/video tools (gating: `filterDisabledCapabilityTools`). */
export function createThreeDTools(ctx: ToolContext): AgentTool[] {
  return [createGenerate3DModelTool(ctx)]
}

/** Test seam. */
export const _testing = { trackedThreeDJobs }
