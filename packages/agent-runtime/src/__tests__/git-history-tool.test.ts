// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createGitHistoryTool, GIT_HISTORY_MAX_OUTPUT, isSafeRef, runGitHistory } from '../git-history-tool'

const hasGit = spawnSync('git', ['--version']).status === 0
if (!hasGit) console.warn('[git-history-tool.test] git is not on PATH — skipping')
const describeGit = hasGit ? describe : describe.skip

let ws: string
const savedLocalMode = process.env.SHOGO_LOCAL_MODE

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}
function commit(cwd: string, message: string) {
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message)
}

beforeAll(() => {
  delete process.env.SHOGO_LOCAL_MODE
  ws = mkdtempSync(join(tmpdir(), 'git-history-'))
  if (!hasGit) return
  git(ws, 'init', '-q')
  mkdirSync(join(ws, 'src'))
  writeFileSync(join(ws, 'src', 'llm.ts'), 'export const MODEL = "x"\n')
  commit(ws, 'initial config')
  writeFileSync(join(ws, 'src', 'llm.ts'), 'export const MODEL = "x"\nexport const MAX_INPUT_TOKENS = 4096\n')
  commit(ws, 'hardcode the token limit')
  // A nested repo, as in a merged-root workspace.
  mkdirSync(join(ws, 'nested'))
  git(join(ws, 'nested'), 'init', '-q')
  writeFileSync(join(ws, 'nested', 'a.txt'), 'nested\n')
  commit(join(ws, 'nested'), 'nested repo commit')
  mkdirSync(join(ws, 'not-a-repo-parent'))
})
afterAll(() => {
  rmSync(ws, { recursive: true, force: true })
  if (savedLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = savedLocalMode
})

const ok = (r: ReturnType<typeof runGitHistory>) => {
  if ('error' in r) throw new Error(r.error)
  return r
}

describeGit('git_history', () => {
  test('log with max_count', () => {
    const r = ok(runGitHistory(ws, { action: 'log', max_count: 1 }))
    expect(r.output.trim().split('\n')).toHaveLength(1)
    expect(r.output).toContain('hardcode the token limit')
  })

  test('log search (pickaxe) finds the commit that introduced a literal', () => {
    const r = ok(runGitHistory(ws, { action: 'log', search: 'MAX_INPUT_TOKENS = 4096' }))
    expect(r.output).toContain('hardcode the token limit')
    expect(r.output).not.toContain('initial config')
  })

  test('blame with a range', () => {
    const r = ok(runGitHistory(ws, { action: 'blame', path: 'src/llm.ts', start_line: 2, end_line: 2 }))
    expect(r.output).toContain('MAX_INPUT_TOKENS')
    expect(r.output.trim().split('\n')).toHaveLength(1)
  })

  test('blame without a range covers the file', () => {
    const r = ok(runGitHistory(ws, { action: 'blame', path: 'src/llm.ts' }))
    expect(r.output.trim().split('\n')).toHaveLength(2)
  })

  test('blame needs a file', () => {
    expect(runGitHistory(ws, { action: 'blame' })).toEqual({ error: 'blame needs a file path' })
  })

  test('show requires a ref', () => {
    expect(runGitHistory(ws, { action: 'show' })).toEqual({ error: 'show needs a ref (commit)' })
    const r = ok(runGitHistory(ws, { action: 'show', ref: 'HEAD' }))
    expect(r.output).toContain('hardcode the token limit')
    expect(r.output).toContain('+export const MAX_INPUT_TOKENS = 4096')
  })

  test('diff against a ref', () => {
    const r = ok(runGitHistory(ws, { action: 'diff', ref: 'HEAD~1', path: 'src/llm.ts' }))
    expect(r.output).toContain('+export const MAX_INPUT_TOKENS = 4096')
  })

  test('malicious refs are rejected before git runs', () => {
    for (const ref of ['--output=/tmp/x', '$(id)', 'HEAD;rm -rf', '`id`', 'a b']) {
      expect(runGitHistory(ws, { action: 'show', ref })).toEqual({ error: `Invalid ref: ${ref}` })
    }
    expect(isSafeRef('main..HEAD')).toBe(true)
    expect(isSafeRef('HEAD~2')).toBe(true)
    expect(isSafeRef('-x')).toBe(false)
  })

  test('an option-like search string is treated as text, not a git option', () => {
    const out = join(ws, 'pwned.txt')
    const r = ok(runGitHistory(ws, { action: 'log', search: `--output=${out}` }))
    expect(r.output).toBe('')
    expect(existsSync(out)).toBe(false)
  })

  test('paths outside the workspace are rejected', () => {
    const r = runGitHistory(ws, { action: 'log', path: '../../etc' })
    expect('error' in r && r.error).toMatch(/outside workspace/)
  })

  test('a non-repo directory reports no history instead of failing', () => {
    const outside = mkdtempSync(join(tmpdir(), 'git-history-norepo-'))
    try {
      const r = runGitHistory(outside, { action: 'log' })
      expect('error' in r).toBe(false)
      expect(r).toMatchObject({ repository: false, cwd: '.' })
      expect('note' in r && r.note).toMatch(/not inside a git repository/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('a nested repo is resolved from the path', () => {
    const r = ok(runGitHistory(ws, { action: 'log', path: 'nested/a.txt' }))
    expect(r.cwd).toBe('nested')
    expect(r.output).toContain('nested repo commit')
    expect(r.output).not.toContain('hardcode the token limit')
  })

  test('long output is truncated', () => {
    writeFileSync(join(ws, 'src', 'big.txt'), `${'y'.repeat(200)}\n`.repeat(400))
    commit(ws, 'big file')
    const r = ok(runGitHistory(ws, { action: 'show', ref: 'HEAD' }))
    expect(r.truncated).toBe(true)
    expect(r.output.length).toBe(GIT_HISTORY_MAX_OUTPUT)
  })

  test('invalid actions are rejected', () => {
    expect(runGitHistory(ws, { action: 'push' as any })).toEqual({ error: 'action must be one of log, blame, show, diff' })
  })

  test('the tool wraps runGitHistory', async () => {
    const tool = createGitHistoryTool({ workspaceDir: ws })
    expect(tool.name).toBe('git_history')
    const res: any = await tool.execute('t1', { action: 'log', max_count: 1 } as any)
    expect(res.details.output).toContain('big file')
  })
})
