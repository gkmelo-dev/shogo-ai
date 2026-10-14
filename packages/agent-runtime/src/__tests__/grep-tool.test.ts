// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _grepToolSeamForTests, createGrepTool, runGrep } from '../grep-tool'
import { resolveRgPath } from '../rg-resolve'

let ws: string
const savedLocalMode = process.env.SHOGO_LOCAL_MODE
const realRg = _grepToolSeamForTests.rgPath

beforeAll(() => {
  delete process.env.SHOGO_LOCAL_MODE
  ws = mkdtempSync(join(tmpdir(), 'grep-tool-'))
  const w = (rel: string, body: string) => {
    mkdirSync(join(ws, rel, '..'), { recursive: true })
    writeFileSync(join(ws, rel), body)
  }
  w('src/config/llm.ts', 'export const MAX_INPUT_TOKENS = 4096\nexport const MODEL = "x"\n')
  w('src/rag/pipeline.ts', [
    "import { MAX_INPUT_TOKENS } from '../config/llm'",
    'export function run(ctx: string) {',
    '  return truncateToTokens(ctx, MAX_INPUT_TOKENS)',
    '}',
    '',
  ].join('\n'))
  w('src/settings/store.ts', 'export const getSettings = () => ({ maxInputTokens: 32000 })\n')
  w('README.md', 'Max Input Tokens can be configured. (a+b)*c\n')
  w('node_modules/pkg/index.js', 'MAX_INPUT_TOKENS everywhere\n')
  w('dist/bundle.js', 'MAX_INPUT_TOKENS bundled\n')
  w('.gitignore', 'dist/\n')
  w('.shogo/logs/console.log', 'user said MAX_INPUT_TOKENS\n')
  // ripgrep only honours .gitignore inside a git repo.
  mkdirSync(join(ws, '.git'))
})
afterAll(() => {
  rmSync(ws, { recursive: true, force: true })
  if (savedLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = savedLocalMode
})
afterEach(() => {
  _grepToolSeamForTests.rgPath = realRg
})

const ok = (r: Awaited<ReturnType<typeof runGrep>>) => {
  if ('error' in r) throw new Error(r.error)
  return r
}

for (const engine of ['ripgrep', 'js-fallback'] as const) {
  describe(`grep (${engine})`, () => {
    const run = (params: Parameters<typeof runGrep>[1]) => {
      if (engine === 'js-fallback') _grepToolSeamForTests.rgPath = () => join(ws, 'no-such-rg-binary')
      return runGrep(ws, params)
    }

    test('content mode returns workspace-relative matches with line numbers', async () => {
      const r = ok(await run({ pattern: 'MAX_INPUT_TOKENS' }))
      expect(r.engine).toBe(engine)
      const hits = r.matches!.map((m) => `${m.file}:${m.line}`).sort()
      expect(hits).toEqual(['src/config/llm.ts:1', 'src/rag/pipeline.ts:1', 'src/rag/pipeline.ts:3'])
      expect(r.matches!.find((m) => m.line === 3)!.text).toBe('  return truncateToTokens(ctx, MAX_INPUT_TOKENS)')
      expect(r.truncated).toBe(false)
    })

    test('node_modules, .gitignore-d paths and runtime logs are skipped', async () => {
      const r = ok(await run({ pattern: 'MAX_INPUT_TOKENS', output_mode: 'files' }))
      expect(r.files!.sort()).toEqual(['src/config/llm.ts', 'src/rag/pipeline.ts'])
    })

    test('runtime logs are searched when targeted explicitly', async () => {
      const r = ok(await run({ pattern: 'MAX_INPUT_TOKENS', path: '.shogo', output_mode: 'files' }))
      expect(r.files).toEqual(['.shogo/logs/console.log'])
    })

    test('files and count modes', async () => {
      const files = ok(await run({ pattern: 'MAX_INPUT_TOKENS', output_mode: 'files' }))
      expect(files.files).toHaveLength(2)
      const counts = ok(await run({ pattern: 'MAX_INPUT_TOKENS', output_mode: 'count' }))
      expect(counts.counts!.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
        { file: 'src/config/llm.ts', count: 1 },
        { file: 'src/rag/pipeline.ts', count: 2 },
      ])
      expect(counts.total_matches).toBe(3)
    })

    test('glob, case_insensitive and fixed_strings (regex metacharacters)', async () => {
      const glob = ok(await run({ pattern: 'MAX_INPUT_TOKENS', glob: 'pipeline.ts' }))
      expect(new Set(glob.matches!.map((m) => m.file))).toEqual(new Set(['src/rag/pipeline.ts']))
      const ci = ok(await run({ pattern: 'max input tokens', case_insensitive: true }))
      expect(ci.matches!.map((m) => m.file)).toEqual(['README.md'])
      const fixed = ok(await run({ pattern: '(a+b)*c', fixed_strings: true }))
      expect(fixed.matches!.map((m) => m.file)).toEqual(['README.md'])
    })

    test('context_lines', async () => {
      const r = ok(await run({ pattern: 'truncateToTokens', context_lines: 1, path: 'src/rag' }))
      expect(r.matches).toHaveLength(1)
      expect(r.matches![0].before).toEqual([{ line: 2, text: 'export function run(ctx: string) {' }])
      expect(r.matches![0].after).toEqual([{ line: 4, text: '}' }])
    })

    test('max_results truncates', async () => {
      const r = ok(await run({ pattern: 'MAX_INPUT_TOKENS', max_results: 1 }))
      expect(r.matches).toHaveLength(1)
      expect(r.truncated).toBe(true)
    })

    test('no matches is an empty result, not an error', async () => {
      const r = ok(await run({ pattern: 'definitely_not_here_123' }))
      expect(r.matches).toEqual([])
      expect(r.total_matches).toBe(0)
    })

    test('the pattern is never shell-interpreted', async () => {
      const marker = join(ws, 'pwned')
      const r = await run({ pattern: '"; touch pwned; echo "', path: '.' })
      expect('error' in r ? r.error : 'ok').toBeDefined()
      expect(existsSync(marker)).toBe(false)
    })
  })
}

describe('grep (shared)', () => {
  test('paths outside the workspace are rejected', async () => {
    const r = await runGrep(ws, { pattern: 'x', path: '../..' })
    expect('error' in r && r.error).toMatch(/outside workspace/)
  })

  test('a missing path is an error', async () => {
    const r = await runGrep(ws, { pattern: 'x', path: 'nope/' })
    expect('error' in r && r.error).toMatch(/Path not found/)
  })

  test('an empty pattern is an error', async () => {
    expect(await runGrep(ws, { pattern: '' })).toEqual({ error: 'pattern is required' })
  })

  test('the JS fallback reports invalid regexes', async () => {
    _grepToolSeamForTests.rgPath = () => join(ws, 'no-such-rg-binary')
    const r = await runGrep(ws, { pattern: '(' })
    expect('error' in r && r.error).toMatch(/Invalid regular expression/)
  })

  test('the default engine is the bundled ripgrep', () => {
    expect(resolveRgPath()).toMatch(/rg(\.exe)?$/)
  })

  test('the tool wraps runGrep', async () => {
    const tool = createGrepTool({ workspaceDir: ws })
    expect(tool.name).toBe('grep')
    const res: any = await tool.execute('t1', { pattern: 'getSettings', output_mode: 'files' } as any)
    expect(res.details.files).toEqual(['src/settings/store.ts'])
  })
})
