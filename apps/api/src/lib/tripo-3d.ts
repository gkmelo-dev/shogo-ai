// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tripo3D V3 client for the AI proxy's 3D routes.
 *
 * Every call is asynchronous: submit a generation and Tripo answers with a
 * task id, then poll until the task reports `success`. The model file
 * (`output.model_url`) points at signed storage that expires after ~5
 * minutes, so it is returned to the caller as-is and never cached here.
 *
 * V3, not V2: `platform.tripo3d.ai/docs` still documents `/v2/openapi/task`
 * and Tripo retires V2 on 2026-10-31. `developers.tripo3d.ai/en/docs/*` is
 * the authoritative surface.
 *
 * Image-to-model takes a public URL or a `file_token` from the upload
 * endpoint — never a data URI — so the proxy uploads inline images here and
 * substitutes the token.
 */

/** Tripo V3 API base. `/v3/tasks/:id` is a path param, not a query param. */
export const TRIPO_API_BASE = 'https://openapi.tripo3d.ai/v3'

/** 1 credit = $1.00 / 100 (developers.tripo3d.ai pricing). */
export const TRIPO_CREDITS_PER_USD = 100

export interface TripoModel {
  id: string
  name: string
  /** Version-pinned value the API's `model` parameter actually accepts. */
  apiModel: string
  /** H = high-fidelity series (v3.x), P = low-poly game-asset series (p1). */
  series: 'H' | 'P'
  textToModel: boolean
  imageToModel: boolean
}

/**
 * Model ids the proxy will run. The public docs list these as "model IDs"
 * (`tripo-v3.1`, `tripo-p1`), but the API's `model` parameter rejects them —
 * it wants the version string (verified live 2026-10-18: `invalid model
 * 'tripo-v3.1', allowed values: P1-20260311, P2-20260801, v2.5-20250123,
 * v3.0-20250812, v3.1-20260211`). Shogo's ids stay readable; `apiModel` is
 * what goes on the wire.
 */
export const TRIPO_MODELS: Record<string, TripoModel> = {
  'tripo-v3.1': { id: 'tripo-v3.1', name: 'Tripo v3.1', apiModel: 'v3.1-20260211', series: 'H', textToModel: true, imageToModel: true },
  'tripo-v3.0': { id: 'tripo-v3.0', name: 'Tripo v3.0', apiModel: 'v3.0-20250812', series: 'H', textToModel: true, imageToModel: true },
  'tripo-v2.5': { id: 'tripo-v2.5', name: 'Tripo v2.5', apiModel: 'v2.5-20250123', series: 'H', textToModel: true, imageToModel: true },
  'tripo-p1': { id: 'tripo-p1', name: 'Tripo P1', apiModel: 'P1-20260311', series: 'P', textToModel: true, imageToModel: true },
}

export const DEFAULT_TRIPO_MODEL = 'tripo-v3.1'

export function getTripoModel(modelId: string): TripoModel | undefined {
  return TRIPO_MODELS[modelId]
}

// ---------------------------------------------------------------------------
// Task endpoints
// ---------------------------------------------------------------------------

export const TRIPO_TASK_PATHS = {
  textToModel: '/generation/text-to-model',
  imageToModel: '/generation/image-to-model',
} as const

export type TripoTaskPath = (typeof TRIPO_TASK_PATHS)[keyof typeof TRIPO_TASK_PATHS]

interface TripoEnvelope<T> {
  code: number
  message?: string
  suggestion?: string
  data?: T
}

function tripoHeaders(apiKey: string, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
  if (contentType) headers['Content-Type'] = contentType
  return headers
}

/** A Tripo API failure, carrying the upstream HTTP status for the route's mapping. */
export class TripoApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'TripoApiError'
    this.status = status
  }
}

/** `{ message, suggestion }` from a non-zero envelope or an HTTP error body. */
function tripoErrorMessage(status: number, body: unknown): string {
  const envelope = (body ?? {}) as TripoEnvelope<unknown>
  const parts = [envelope.message, envelope.suggestion].filter((p): p is string => !!p)
  if (parts.length > 0) return parts.join(' — ')
  return `Tripo request failed (${status})`
}

async function tripoRequest<T>(
  apiKey: string,
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${TRIPO_API_BASE}${path}`, {
    ...init,
    headers: { ...tripoHeaders(apiKey), ...(init.headers as Record<string, string> | undefined) },
    signal,
  })
  const body = await response.json().catch(() => null) as TripoEnvelope<T> | null
  if (!response.ok || !body || body.code !== 0) {
    throw new TripoApiError(tripoErrorMessage(response.status, body), response.status)
  }
  return (body.data ?? {}) as T
}

/** Submit a generation task and return its id. */
export async function tripoCreateTask(
  apiKey: string,
  path: TripoTaskPath,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const data = await tripoRequest<{ task_id?: string }>(apiKey, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, signal)
  if (!data.task_id) throw new Error('Tripo returned no task id')
  return data.task_id
}

export type TripoTaskStatus = 'queued' | 'running' | 'success' | 'failed'

export interface TripoTask {
  status: TripoTaskStatus
  progress?: number
  output?: { model_url?: string; rendered_image_url?: string; [key: string]: unknown }
  creditsConsumed?: number
  errorCode?: number
  errorMessage?: string
}

/** Poll one task. Tripo reports `cancelled` too; it surfaces as `failed`. */
export async function tripoGetTask(
  apiKey: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<TripoTask> {
  const data = await tripoRequest<{
    status?: string
    progress?: number
    output?: TripoTask['output']
    credits_consumed?: number
    error_code?: number
    error_message?: string
  }>(apiKey, `/tasks/${encodeURIComponent(taskId)}`, { method: 'GET' }, signal)

  const raw = data.status ?? 'queued'
  const status: TripoTaskStatus =
    raw === 'success' || raw === 'failed' ? raw : raw === 'cancelled' ? 'failed' : raw === 'running' ? 'running' : 'queued'

  return {
    status,
    progress: typeof data.progress === 'number' ? data.progress : undefined,
    output: data.output,
    creditsConsumed: typeof data.credits_consumed === 'number' ? data.credits_consumed : undefined,
    errorCode: data.error_code,
    ...(status === 'failed' && raw === 'cancelled' ? { errorMessage: 'Task was cancelled' } : {}),
    ...(data.error_message ? { errorMessage: data.error_message } : {}),
  }
}

/**
 * Upload an image and return its `file_token`. Multipart field name is `file`
 * (JPEG/PNG, 20 MB max); image-to-model accepts the token in `input`.
 */
export async function tripoUploadFile(
  apiKey: string,
  bytes: Uint8Array,
  contentType: string,
  signal?: AbortSignal,
): Promise<string> {
  const extension = contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/webp' ? 'webp' : 'png'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }), `input.${extension}`)

  const response = await fetch(`${TRIPO_API_BASE}/files`, {
    method: 'POST',
    headers: tripoHeaders(apiKey),
    body: form,
    signal,
  })
  const body = await response.json().catch(() => null) as TripoEnvelope<{ file_token?: string }> | null
  if (!response.ok || !body || body.code !== 0) {
    throw new TripoApiError(tripoErrorMessage(response.status, body), response.status)
  }
  const token = body.data?.file_token
  if (!token) throw new Error('Tripo returned no file token')
  return token
}

/** Decode a `data:` URI into bytes plus its content type. */
export function parseDataUri(dataUri: string): { bytes: Uint8Array; contentType: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUri)
  if (!match) throw new Error('Malformed data URI')
  const contentType = match[1] || 'application/octet-stream'
  const bytes = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]))
  return { bytes: new Uint8Array(bytes), contentType }
}

export function isHttpsUrl(value: string): boolean {
  return /^https:\/\/\S+$/i.test(value)
}
