// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Forward renderer diagnostics into main.log.
 *
 * main.ts patches the main process's console into main.log, but a renderer's
 * console output only lives in DevTools, so a crash in the chat view (e.g.
 * React #185) left nothing on disk. This attaches to a webContents and writes
 * its console warnings/errors and process failures through `writeLog`.
 *
 * Electron-free (structural types) so it is unit-testable with a fake emitter.
 */

export type RendererLogLevel = 'WARN' | 'ERROR'
export type WriteLog = (level: string, ...args: unknown[]) => void

export interface WebContentsLike {
  id: number
  on(event: string, listener: (...args: any[]) => void): unknown
  getURL?: () => string
}

/** Max forwarded lines per webContents per window; the rest are counted. */
export const RENDERER_LOG_LIMIT = 200
export const RENDERER_LOG_WINDOW_MS = 60_000
const MAX_MESSAGE_CHARS = 4_000

interface ConsoleMessage {
  level: 'debug' | 'info' | 'warning' | 'error'
  message: string
  lineNumber?: number
  sourceId?: string
}

const LEGACY_LEVELS = ['debug', 'info', 'warning', 'error'] as const

/**
 * Electron ≥ 35 passes one event object carrying `level`/`message`; older
 * versions passed `(event, level: number, message, line, sourceId)`.
 */
export function parseConsoleMessage(args: unknown[]): ConsoleMessage | null {
  const [event, level, message, lineNumber, sourceId] = args as [any, unknown, unknown, unknown, unknown]
  if (event && typeof event === 'object' && typeof event.level === 'string' && typeof event.message === 'string') {
    return {
      level: event.level,
      message: event.message,
      lineNumber: typeof event.lineNumber === 'number' ? event.lineNumber : undefined,
      sourceId: typeof event.sourceId === 'string' ? event.sourceId : undefined,
    }
  }
  if (typeof level === 'number' && typeof message === 'string') {
    return {
      level: LEGACY_LEVELS[Math.max(0, Math.min(3, level))],
      message,
      lineNumber: typeof lineNumber === 'number' ? lineNumber : undefined,
      sourceId: typeof sourceId === 'string' ? sourceId : undefined,
    }
  }
  return null
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}… [${text.length} chars]` : text
}

export function formatConsoleMessage(webContentsId: number, msg: ConsoleMessage): string {
  const where = msg.sourceId ? ` (${msg.sourceId}${msg.lineNumber ? `:${msg.lineNumber}` : ''})` : ''
  return `[renderer:${webContentsId}] console.${msg.level === 'warning' ? 'warn' : msg.level}: ${truncate(msg.message)}${where}`
}

export function attachRendererLogForwarding(
  contents: WebContentsLike,
  writeLog: WriteLog,
  { now = Date.now, limit = RENDERER_LOG_LIMIT, windowMs = RENDERER_LOG_WINDOW_MS } = {},
): void {
  let windowStart = now()
  let count = 0
  let suppressed = 0

  const emit = (level: RendererLogLevel, line: string, { always = false } = {}) => {
    const t = now()
    if (t - windowStart >= windowMs) {
      if (suppressed > 0) {
        writeLog('WARN', `[renderer:${contents.id}] ${suppressed} console lines suppressed (over ${limit}/min)`)
      }
      windowStart = t
      count = 0
      suppressed = 0
    }
    if (!always && count >= limit) {
      suppressed++
      return
    }
    count++
    writeLog(level, line)
  }

  contents.on('console-message', (...args: unknown[]) => {
    const msg = parseConsoleMessage(args)
    if (!msg || (msg.level !== 'warning' && msg.level !== 'error')) return
    emit(msg.level === 'error' ? 'ERROR' : 'WARN', formatConsoleMessage(contents.id, msg))
  })

  contents.on('render-process-gone', (_event: unknown, details: { reason?: string; exitCode?: number } = {}) => {
    const url = contents.getURL?.() ?? ''
    emit(
      'ERROR',
      `[renderer:${contents.id}] render process gone: reason=${details.reason ?? 'unknown'} exitCode=${details.exitCode ?? '?'}${url ? ` url=${url}` : ''}`,
      { always: true },
    )
  })

  contents.on('unresponsive', () => {
    emit('WARN', `[renderer:${contents.id}] renderer unresponsive`, { always: true })
  })
  contents.on('responsive', () => {
    emit('WARN', `[renderer:${contents.id}] renderer responsive again`, { always: true })
  })

  contents.on('preload-error', (_event: unknown, preloadPath: string, error: unknown) => {
    const detail = error instanceof Error ? error.stack || error.message : String(error)
    emit('ERROR', `[renderer:${contents.id}] preload error in ${preloadPath}: ${truncate(detail)}`, { always: true })
  })
}
