// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `git_history` — read-only git archaeology: log (with pickaxe search),
 * blame, show and diff. Answers "why is this code the way it is" before an
 * agent changes it. No shell: git is spawned with an argument array, refs are
 * validated, and external diff drivers / textconv filters are disabled.
 */

import { dirname, relative, sep } from 'path'
import { readFileSync, statSync } from 'fs'
import { Type } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { spawnSync } from '@shogo/shared-runtime/child-process'
import { assertWithinWorkspace } from './permission-engine'

export type GitHistoryAction = 'log' | 'blame' | 'show' | 'diff'

export interface GitHistoryParams {
  action: GitHistoryAction
  path?: string
  ref?: string
  start_line?: number
  end_line?: number
  search?: string
  max_count?: number
}

export type GitHistoryResult =
  | { action: GitHistoryAction; cwd: string; output: string; truncated: boolean }
  | { repository: false; cwd: string; note: string }
  | { error: string }

export const GIT_HISTORY_MAX_OUTPUT = 40_000
export const GIT_HISTORY_MAX_BLAME_LINES = 400
const GIT_TIMEOUT_MS = 20_000
const REF_PATTERN = /^[A-Za-z0-9_./~^@{}-]+$/

/** Rejects anything git could read as an option or that isn't a plain revision expression. */
export function isSafeRef(ref: string): boolean {
  return REF_PATTERN.test(ref) && !ref.startsWith('-')
}

const toPosix = (p: string) => p.split(sep).join('/')
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException } {
  const res = spawnSync('git', ['-c', 'color.ui=never', '-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
  return {
    status: res.status,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
    error: res.error as NodeJS.ErrnoException | undefined,
  }
}

export function runGitHistory(workspaceDir: string, params: GitHistoryParams): GitHistoryResult {
  const action = params?.action
  if (!['log', 'blame', 'show', 'diff'].includes(action)) return { error: 'action must be one of log, blame, show, diff' }

  const ref = typeof params.ref === 'string' && params.ref.trim() ? params.ref.trim() : undefined
  if (ref && !isSafeRef(ref)) return { error: `Invalid ref: ${ref}` }

  let absPath: string | undefined
  let isDir = false
  if (typeof params.path === 'string' && params.path.trim()) {
    try {
      absPath = assertWithinWorkspace(workspaceDir, params.path.trim())
    } catch (err) {
      return { error: (err as Error).message }
    }
    try {
      isDir = statSync(absPath).isDirectory()
    } catch {
      isDir = false
    }
  }

  // Run where the path lives so nested repositories in a merged-root workspace resolve.
  let cwd = workspaceDir
  if (absPath) {
    const candidate = isDir ? absPath : dirname(absPath)
    try {
      if (statSync(candidate).isDirectory()) cwd = candidate
    } catch {
      /* path may only exist in history; stay at the workspace root */
    }
  }
  const cwdLabel = toPosix(relative(workspaceDir, cwd)) || '.'

  const probe = git(cwd, ['rev-parse', '--show-toplevel'])
  if (probe.error?.code === 'ENOENT') return { error: 'git is not installed' }
  // Not a tool failure: the workspace simply has no history to consult.
  if (probe.status !== 0) {
    return { repository: false, cwd: cwdLabel, note: `${cwdLabel} is not inside a git repository, so there is no history to check. Skip git_history here.` }
  }

  const pathArgs = absPath ? ['--', absPath] : []
  let args: string[]
  let blameCap = false
  switch (action) {
    case 'log': {
      const max = clamp(Math.floor(params.max_count ?? 20), 1, 100)
      const search = typeof params.search === 'string' && params.search ? params.search : undefined
      args = [
        'log',
        `--max-count=${max}`,
        '--date=short',
        '--format=%h %ad %an %s',
        '--no-textconv',
        // Stuck form: the search text can never be parsed as another option.
        ...(search ? [`-S${search}`] : []),
        ...(ref ? [ref] : []),
        ...(absPath ? ['--', absPath] : ['--']),
      ]
      break
    }
    case 'blame': {
      if (!absPath || isDir) return { error: 'blame needs a file path' }
      const start = Math.max(1, Math.floor(params.start_line ?? 1))
      let end: number
      if (params.end_line !== undefined) {
        end = Math.max(start, Math.floor(params.end_line))
      } else {
        let lineCount = start + GIT_HISTORY_MAX_BLAME_LINES - 1
        try {
          const text = readFileSync(absPath, 'utf8')
          lineCount = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0))
        } catch {
          /* only in history */
        }
        end = Math.max(start, lineCount)
      }
      if (end - start + 1 > GIT_HISTORY_MAX_BLAME_LINES) {
        end = start + GIT_HISTORY_MAX_BLAME_LINES - 1
        blameCap = true
      }
      args = ['blame', '--date=short', '--no-textconv', '-L', `${start},${end}`, ...(ref ? [ref] : []), '--', absPath]
      break
    }
    case 'show': {
      if (!ref) return { error: 'show needs a ref (commit)' }
      args = ['show', '--stat', '--patch', '--format=fuller', '--no-ext-diff', '--no-textconv', ref, ...pathArgs]
      break
    }
    case 'diff': {
      args = ['diff', '--no-ext-diff', '--no-textconv', ...(ref ? [ref] : []), '--', ...(absPath ? [absPath] : [])]
      break
    }
  }

  const res = git(cwd, args!)
  if (res.error && res.error.code !== 'ENOBUFS') return { error: res.error.message }
  if (res.status !== 0 && !res.stdout) return { error: res.stderr.trim() || `git ${action} failed` }

  let output = res.stdout
  let truncated = blameCap || !!res.error
  if (output.length > GIT_HISTORY_MAX_OUTPUT) {
    output = output.slice(0, GIT_HISTORY_MAX_OUTPUT)
    truncated = true
  }
  return { action, cwd: cwdLabel, output, truncated }
}

function toolResult(data: GitHistoryResult): AgentToolResult<GitHistoryResult> {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], details: data }
}

export function createGitHistoryTool(ctx: { workspaceDir: string }): AgentTool {
  return {
    name: 'git_history',
    label: 'Git History',
    description:
      'Read-only git history: "log" (optionally a path, a ref, and search to find the commit that introduced or removed a literal — git log -S), "blame" a file or line range, "show" a commit, or "diff" against a ref. Use it to learn why code is the way it is before changing it.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('log'), Type.Literal('blame'), Type.Literal('show'), Type.Literal('diff')]),
      path: Type.Optional(Type.String({ description: 'File or directory, relative to the workspace root.' })),
      ref: Type.Optional(Type.String({ description: 'Commit, branch, tag or range (e.g. HEAD~3, main..HEAD). Required for show.' })),
      start_line: Type.Optional(Type.Number({ description: 'blame: first line (1-based).' })),
      end_line: Type.Optional(Type.Number({ description: `blame: last line (max ${GIT_HISTORY_MAX_BLAME_LINES} lines per call).` })),
      search: Type.Optional(Type.String({ description: 'log: only commits that add or remove this literal (pickaxe).' })),
      max_count: Type.Optional(Type.Number({ description: 'log: number of commits (1-100, default 20).' })),
    }),
    execute: async (_toolCallId, params) => toolResult(runGitHistory(ctx.workspaceDir, params as GitHistoryParams)),
  }
}
