// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `grep` — exact / regex search across the workspace, read-only.
 *
 * Backed by ripgrep (`resolveRgPath()`), spawned with an argument array — the
 * pattern is never shell-interpreted. When no ripgrep binary can be spawned it
 * falls back to a bounded pure-JS walk with the same output shape.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, relative, sep } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import ignore, { type Ignore } from 'ignore'
import { isBinaryFilePath } from '@shogo/shared-runtime'
import { spawn } from '@shogo/shared-runtime/child-process'
import { assertWithinWorkspace } from './permission-engine'
import { resolveRgPath } from './rg-resolve'

export type GrepOutputMode = 'content' | 'files' | 'count'

export interface GrepParams {
  pattern: string
  fixed_strings?: boolean
  path?: string
  glob?: string | string[]
  case_insensitive?: boolean
  context_lines?: number
  output_mode?: GrepOutputMode
  max_results?: number
}

interface ContextLine {
  line: number
  text: string
}
export interface GrepMatch {
  file: string
  line: number
  text: string
  before?: ContextLine[]
  after?: ContextLine[]
}

export type GrepResult =
  | {
      engine: 'ripgrep' | 'js-fallback'
      mode: GrepOutputMode
      matches?: GrepMatch[]
      files?: string[]
      counts?: Array<{ file: string; count: number }>
      total_matches: number
      truncated: boolean
      timed_out?: boolean
      warnings?: string
    }
  | { error: string }

export const GREP_DEFAULT_MAX_RESULTS = 200
export const GREP_MAX_RESULTS_LIMIT = 1000
export const GREP_TIMEOUT_MS = 20_000
const MAX_LINE_CHARS = 400
const FALLBACK_MAX_FILES = 20_000
const ALWAYS_EXCLUDED_DIRS = new Set(['.git', 'node_modules'])
/** Runtime logs echo the conversation; skipped unless the search targets `.shogo/` explicitly. */
const RUNTIME_LOG_DIR = '.shogo/logs'
const skipsRuntimeLogs = (target: string) => !(target === '.shogo' || target.startsWith('.shogo/'))

/** Test-only seams: swap the ripgrep binary to exercise the JS fallback. */
export const _grepToolSeamForTests = {
  rgPath: (): string => resolveRgPath(),
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const toPosix = (p: string) => p.split(sep).join('/').replace(/\\/g, '/')
const trimLine = (text: string) => {
  const t = text.replace(/\r?\n$/, '')
  return t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS)}…` : t
}

function normalize(params: GrepParams) {
  return {
    pattern: params.pattern,
    fixed: params.fixed_strings === true,
    path: params.path && params.path.trim() ? params.path.trim() : '.',
    globs: (Array.isArray(params.glob) ? params.glob : params.glob ? [params.glob] : []).filter((g) => typeof g === 'string' && g.trim()),
    caseInsensitive: params.case_insensitive === true,
    context: clamp(Math.floor(params.context_lines ?? 0), 0, 5),
    mode: (['content', 'files', 'count'] as const).includes(params.output_mode as GrepOutputMode)
      ? (params.output_mode as GrepOutputMode)
      : 'content',
    maxResults: clamp(Math.floor(params.max_results ?? GREP_DEFAULT_MAX_RESULTS), 1, GREP_MAX_RESULTS_LIMIT),
  }
}

type Normalized = ReturnType<typeof normalize>

/** ripgrep runs in the workspace root, so its paths are already workspace-relative. */
function workspacePath(reported: string): string {
  return toPosix(reported).replace(/^\.\//, '')
}

function rgArgs(opts: Normalized, target: string): string[] {
  const args = ['--color', 'never', '--max-columns', String(MAX_LINE_CHARS), '--max-columns-preview', '--hidden']
  args.push('--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!**/node_modules/**')
  if (skipsRuntimeLogs(target)) args.push('--glob', `!${RUNTIME_LOG_DIR}/**`)
  for (const g of opts.globs) args.push('--glob', g)
  if (opts.fixed) args.push('--fixed-strings')
  if (opts.caseInsensitive) args.push('--ignore-case')
  if (opts.mode === 'files') args.push('--files-with-matches')
  else if (opts.mode === 'count') args.push('--count-matches', '--with-filename')
  else {
    args.push('--json')
    if (opts.context > 0) args.push('--context', String(opts.context))
  }
  args.push('--', opts.pattern, target)
  return args
}

async function runRipgrep(rg: string, workspaceDir: string, absRoot: string, opts: Normalized): Promise<GrepResult | 'spawn-failed'> {
  const target = toPosix(relative(workspaceDir, absRoot)) || '.'
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(rg, rgArgs(opts, target), { cwd: workspaceDir, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolvePromise('spawn-failed')
      return
    }
    const matches: GrepMatch[] = []
    const files: string[] = []
    const counts: Array<{ file: string; count: number }> = []
    let totalMatches = 0
    let truncated = false
    let timedOut = false
    let stderr = ''
    let buffer = ''
    let settled = false
    let pending: Array<ContextLine & { file: string }> = []

    const stop = () => {
      truncated = true
      child.kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      truncated = true
      child.kill()
    }, GREP_TIMEOUT_MS)

    const handleLine = (line: string) => {
      if (!line) return
      if (opts.mode === 'files') {
        if (files.length >= opts.maxResults) return stop()
        files.push(workspacePath(line))
        totalMatches++
        return
      }
      if (opts.mode === 'count') {
        const at = line.lastIndexOf(':')
        if (at <= 0) return
        const count = Number(line.slice(at + 1))
        if (!Number.isFinite(count)) return
        if (counts.length >= opts.maxResults) return stop()
        counts.push({ file: workspacePath(line.slice(0, at)), count })
        totalMatches += count
        return
      }
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      const data = msg?.data
      const file = typeof data?.path?.text === 'string' ? workspacePath(data.path.text) : ''
      const text = trimLine(typeof data?.lines?.text === 'string' ? data.lines.text : '')
      const lineNumber = typeof data?.line_number === 'number' ? data.line_number : 0
      if (msg.type === 'match') {
        totalMatches += Array.isArray(data?.submatches) && data.submatches.length > 0 ? data.submatches.length : 1
        if (matches.length >= opts.maxResults) return stop()
        const before = pending.filter((c) => c.file === file && c.line >= lineNumber - opts.context && c.line < lineNumber)
        pending = []
        matches.push({ file, line: lineNumber, text, ...(before.length ? { before: before.map(({ line: l, text: t }) => ({ line: l, text: t })) } : {}) })
      } else if (msg.type === 'context') {
        const last = matches[matches.length - 1]
        if (last && last.file === file && lineNumber > last.line && lineNumber <= last.line + opts.context) {
          ;(last.after ??= []).push({ line: lineNumber, text })
        } else {
          pending.push({ file, line: lineNumber, text })
        }
      }
    }

    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        handleLine(buffer.slice(0, nl).replace(/\r$/, ''))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      if (stderr.length < 8_000) stderr += chunk
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolvePromise(err.code === 'ENOENT' || err.code === 'EACCES' ? 'spawn-failed' : { error: err.message })
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (buffer) handleLine(buffer)
      const found = matches.length + files.length + counts.length
      // 1 = no matches; 2 = an error (possibly alongside results, e.g. unreadable files).
      if (code === 2 && found === 0 && !truncated) {
        resolvePromise({ error: stderr.trim() || 'ripgrep failed' })
        return
      }
      resolvePromise({
        engine: 'ripgrep',
        mode: opts.mode,
        ...(opts.mode === 'content' ? { matches } : opts.mode === 'files' ? { files } : { counts }),
        total_matches: totalMatches,
        truncated,
        ...(timedOut ? { timed_out: true } : {}),
        ...(code === 2 && stderr.trim() ? { warnings: stderr.trim().slice(0, 2_000) } : {}),
      })
    })
  })
}

function globMatcher(globs: string[]): (relPath: string) => boolean {
  if (globs.length === 0) return () => true
  const toMatcher = (g: string) => {
    const glob = new Bun.Glob(g.includes('/') ? g : `**/${g}`)
    return (p: string) => glob.match(p)
  }
  const include = globs.filter((g) => !g.startsWith('!')).map(toMatcher)
  const exclude = globs.filter((g) => g.startsWith('!')).map((g) => toMatcher(g.slice(1)))
  return (p) => (include.length === 0 || include.some((m) => m(p))) && !exclude.some((m) => m(p))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Bounded pure-JS search used when no ripgrep binary can be spawned. */
function runFallback(workspaceDir: string, absRoot: string, opts: Normalized): GrepResult {
  let regex: RegExp
  try {
    regex = new RegExp(opts.fixed ? escapeRegExp(opts.pattern) : opts.pattern, opts.caseInsensitive ? 'gi' : 'g')
  } catch (err) {
    return { error: `Invalid regular expression: ${(err as Error).message}` }
  }
  const matchesGlob = globMatcher(opts.globs)
  const skipLogs = skipsRuntimeLogs(toPosix(relative(workspaceDir, absRoot)))
  const ignorers: Array<{ base: string; ig: Ignore }> = []
  const loadIgnore = (dir: string) => {
    const file = join(dir, '.gitignore')
    if (!existsSync(file)) return
    try {
      ignorers.push({ base: dir, ig: ignore().add(readFileSync(file, 'utf8')) })
    } catch {
      /* unreadable .gitignore */
    }
  }
  const ignored = (abs: string, isDir: boolean) =>
    ignorers.some(({ base, ig }) => {
      const rel = toPosix(relative(base, abs))
      return !!rel && !rel.startsWith('..') && ig.ignores(isDir ? `${rel}/` : rel)
    })

  const matches: GrepMatch[] = []
  const files: string[] = []
  const counts: Array<{ file: string; count: number }> = []
  let totalMatches = 0
  let truncated = false
  let scanned = 0

  const searchFile = (abs: string) => {
    if (truncated) return
    const rel = toPosix(relative(workspaceDir, abs))
    if (!matchesGlob(rel) || isBinaryFilePath(abs)) return
    if (++scanned > FALLBACK_MAX_FILES) {
      truncated = true
      return
    }
    let content: string
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      return
    }
    if (content.includes('\u0000')) return
    const lines = content.split(/\r?\n/)
    let fileCount = 0
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0
      const hits = lines[i].match(regex)
      if (!hits) continue
      fileCount += hits.length
      totalMatches += hits.length
      if (opts.mode !== 'content') continue
      if (matches.length >= opts.maxResults) {
        truncated = true
        return
      }
      const ctx = (from: number, to: number) =>
        lines.slice(Math.max(0, from), Math.max(0, to)).map((text, k) => ({ line: Math.max(0, from) + k + 1, text: trimLine(text) }))
      const before = opts.context ? ctx(i - opts.context, i) : []
      const after = opts.context ? ctx(i + 1, Math.min(lines.length, i + 1 + opts.context)) : []
      matches.push({ file: rel, line: i + 1, text: trimLine(lines[i]), ...(before.length ? { before } : {}), ...(after.length ? { after } : {}) })
    }
    if (fileCount === 0) return
    if (opts.mode === 'files') {
      if (files.length >= opts.maxResults) truncated = true
      else files.push(rel)
    } else if (opts.mode === 'count') {
      if (counts.length >= opts.maxResults) truncated = true
      else counts.push({ file: rel, count: fileCount })
    }
  }

  const walk = (dir: string) => {
    if (truncated) return
    loadIgnore(dir)
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (ALWAYS_EXCLUDED_DIRS.has(entry.name) || ignored(abs, true)) continue
        if (skipLogs && toPosix(relative(workspaceDir, abs)) === RUNTIME_LOG_DIR) continue
        walk(abs)
      } else if (entry.isFile() && !ignored(abs, false)) {
        searchFile(abs)
      }
    }
  }

  let isDir = false
  try {
    isDir = statSync(absRoot).isDirectory()
  } catch {
    return { error: `Path not found: ${toPosix(relative(workspaceDir, absRoot)) || '.'}` }
  }
  if (isDir) {
    loadIgnore(workspaceDir)
    walk(absRoot)
  } else {
    searchFile(absRoot)
  }
  return {
    engine: 'js-fallback',
    mode: opts.mode,
    ...(opts.mode === 'content' ? { matches } : opts.mode === 'files' ? { files } : { counts }),
    total_matches: totalMatches,
    truncated,
  }
}

export async function runGrep(workspaceDir: string, params: GrepParams): Promise<GrepResult> {
  if (typeof params?.pattern !== 'string' || params.pattern.length === 0) return { error: 'pattern is required' }
  const opts = normalize(params)
  let absRoot: string
  try {
    absRoot = assertWithinWorkspace(workspaceDir, opts.path)
  } catch (err) {
    return { error: (err as Error).message }
  }
  if (!existsSync(absRoot)) return { error: `Path not found: ${opts.path}` }
  const viaRg = await runRipgrep(_grepToolSeamForTests.rgPath(), workspaceDir, absRoot, opts)
  if (viaRg !== 'spawn-failed') return viaRg
  return runFallback(workspaceDir, absRoot, opts)
}

function toolResult(data: GrepResult): AgentToolResult<GrepResult> {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], details: data }
}

export function createGrepTool(ctx: { workspaceDir: string }): AgentTool {
  return {
    name: 'grep',
    label: 'Grep',
    description:
      'Exact/regex search across the workspace (ripgrep). Use to find every usage of an identifier, literal, config key, or error message before changing code. Respects .gitignore; skips .git and node_modules. output_mode "files" lists matching files, "count" gives per-file counts.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regular expression (Rust regex syntax), or a literal with fixed_strings: true.' }),
      fixed_strings: Type.Optional(Type.Boolean({ description: 'Treat pattern as a literal string.' })),
      path: Type.Optional(Type.String({ description: 'File or directory to search, relative to the workspace root. Default ".".' })),
      glob: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description: 'Include glob(s) such as "*.ts" or "src/**"; prefix with ! to exclude.',
        }),
      ),
      case_insensitive: Type.Optional(Type.Boolean()),
      context_lines: Type.Optional(Type.Number({ description: 'Lines of context around each match (0-5, default 0).' })),
      output_mode: Type.Optional(
        Type.Union([Type.Literal('content'), Type.Literal('files'), Type.Literal('count')], { description: 'Default "content".' }),
      ),
      max_results: Type.Optional(Type.Number({ description: `Max matches/files returned (1-${GREP_MAX_RESULTS_LIMIT}, default ${GREP_DEFAULT_MAX_RESULTS}).` })),
    }),
    execute: async (_toolCallId, params) => toolResult(await runGrep(ctx.workspaceDir, params as GrepParams)),
  }
}
