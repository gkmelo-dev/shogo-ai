// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `applyTechStackChange()` — the one implementation behind
 * `project_configure`'s `techStackId`/`resetFiles` and
 * `POST /agent/workspace/reset-stack`.
 *
 *   bun test packages/agent-runtime/src/__tests__/tech-stack-switch.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyTechStackChange,
  seedEntries,
  setTechStackPreviewRestarter,
  syncTechStackEnv,
  type PreviewRestartRequest,
} from '../tech-stack-switch'

const dirs: string[] = []
let restarts: PreviewRestartRequest[] = []
const savedEnv = {
  TECH_STACK_ID: process.env.TECH_STACK_ID,
  WORKSPACE_TECH_STACKS: process.env.WORKSPACE_TECH_STACKS,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
}

/** A react-app-ish project: the files a Vite starter owns. */
function reactProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-stack-switch-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'App.tsx'), 'export const App = () => null\n')
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}\n')
  writeFileSync(join(dir, 'index.html'), '<div id="root"></div>\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"p","scripts":{"build":"vite build"}}')
  writeFileSync(join(dir, '.tech-stack'), 'react-app')
  mkdirSync(join(dir, '.shogo'), { recursive: true })
  writeFileSync(join(dir, '.shogo', 'AGENTS.md'), '# agent identity\n')
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'notes.md'), 'a remembered fact\n')
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return dir
}

beforeEach(() => {
  restarts = []
  setTechStackPreviewRestarter((req) => void restarts.push(req))
})

afterEach(() => {
  setTechStackPreviewRestarter(null)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  process.env.TECH_STACK_ID = savedEnv.TECH_STACK_ID
  process.env.WORKSPACE_TECH_STACKS = savedEnv.WORKSPACE_TECH_STACKS
  process.env.WORKSPACE_DIR = savedEnv.WORKSPACE_DIR
})

describe('applyTechStackChange (non-destructive)', () => {
  test('seeds the new stack, keeps colliding files, and reports them', () => {
    const dir = reactProject()

    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })

    expect(result.ok).toBe(true)
    expect(result.seeded).toBe(true)
    expect(result.wiped).toBeNull()
    // New starter files land.
    expect(existsSync(join(dir, 'remotion.config.ts'))).toBe(true)
    expect(readFileSync(join(dir, '.tech-stack'), 'utf-8').trim()).toBe('video-editor')
    // The whole `src/` tree already existed, so the starter's src/ is skipped —
    // that collision is what `kept` is for.
    expect(existsSync(join(dir, 'src', 'videos', 'Main.tsx'))).toBe(false)
    expect(readFileSync(join(dir, 'src', 'App.tsx'), 'utf-8')).toBe('export const App = () => null\n')
    expect(result.kept).toContain('src')
    expect(result.kept).toContain('vite.config.ts')
    expect(result.kept).not.toContain('remotion.config.ts')
  })

  test('restarts the preview exactly once', () => {
    const dir = reactProject()
    applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })
    expect(restarts).toHaveLength(1)
    expect(restarts[0]).toMatchObject({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })
  })

  test('an unknown stack changes nothing', () => {
    const dir = reactProject()
    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'not-a-stack', scope: 'root' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown tech stack')
    expect(readFileSync(join(dir, '.tech-stack'), 'utf-8').trim()).toBe('react-app')
    expect(restarts).toHaveLength(0)
  })
})

describe('applyTechStackChange (resetFiles)', () => {
  test('replaces the project code but keeps identity, memory and git', () => {
    const dir = reactProject()

    const result = applyTechStackChange({
      projectDir: dir,
      projectId: 'p-1',
      stackId: 'video-editor',
      scope: 'root',
      resetFiles: true,
    })

    expect(result.ok).toBe(true)
    expect(result.wiped).toBeGreaterThan(0)
    expect(result.kept).toEqual([])
    // Old stack's code is gone, new stack's is there.
    expect(existsSync(join(dir, 'src', 'App.tsx'))).toBe(false)
    expect(readFileSync(join(dir, 'src', 'videos', 'Main.tsx'), 'utf-8')).toContain('export const Main')
    expect(existsSync(join(dir, 'remotion.config.ts'))).toBe(true)
    // Preserved by WIPE_PRESERVE_TOP_LEVEL.
    expect(readFileSync(join(dir, '.shogo', 'AGENTS.md'), 'utf-8')).toBe('# agent identity\n')
    expect(readFileSync(join(dir, 'memory', 'notes.md'), 'utf-8')).toBe('a remembered fact\n')
    expect(readFileSync(join(dir, '.git', 'HEAD'), 'utf-8')).toBe('ref: refs/heads/main\n')
  })

  test('resetFiles alone re-seeds the current stack', () => {
    const dir = reactProject()
    writeFileSync(join(dir, 'src', 'App.tsx'), 'broken\n')

    const result = applyTechStackChange({
      projectDir: dir,
      projectId: 'p-1',
      stackId: 'video-editor',
      scope: 'root',
      resetFiles: true,
    })

    expect(result.ok).toBe(true)
    expect(existsSync(join(dir, 'src', 'App.tsx'))).toBe(false)
  })
})

describe('applyTechStackChange (stack doc)', () => {
  /** A real video-editor project: its own starter, marker and STACK.md. */
  function videoProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-stack-doc-'))
    dirs.push(dir)
    writeFileSync(join(dir, '.tech-stack'), 'video-editor')
    const seeded = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })
    expect(seeded.ok).toBe(true)
    writeFileSync(join(dir, '.shogo', 'AGENTS.md'), '# video agent identity\n')
    return dir
  }

  test('a non-destructive switch replaces .shogo/STACK.md and keeps AGENTS.md', () => {
    const dir = videoProject()
    expect(readFileSync(join(dir, '.shogo', 'STACK.md'), 'utf-8')).toContain('Video Editor')

    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'react-app', scope: 'root' })

    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, '.shogo', 'STACK.md'), 'utf-8')).toContain('# Tech Stack — React App')
    expect(readFileSync(join(dir, '.shogo', 'AGENTS.md'), 'utf-8')).toBe('# video agent identity\n')
    expect(readFileSync(join(dir, '.tech-stack'), 'utf-8').trim()).toBe('react-app')
  })

  test('resetFiles replaces it too — .shogo/ survives the wipe, so nothing else would', () => {
    const dir = videoProject()

    const result = applyTechStackChange({
      projectDir: dir,
      projectId: 'p-1',
      stackId: 'react-app',
      scope: 'root',
      resetFiles: true,
    })

    expect(result.ok).toBe(true)
    expect(result.wiped).toBeGreaterThan(0)
    expect(existsSync(join(dir, 'src', 'videos', 'Main.tsx'))).toBe(false)
    const doc = readFileSync(join(dir, '.shogo', 'STACK.md'), 'utf-8')
    expect(doc).toContain('# Tech Stack — React App')
    expect(doc).not.toContain('Video Editor')
  })

  test('re-seeding the same stack leaves a hand-edited STACK.md alone', () => {
    const dir = videoProject()
    writeFileSync(join(dir, '.shogo', 'STACK.md'), '# our own notes\n')

    applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root', resetFiles: true })

    expect(readFileSync(join(dir, '.shogo', 'STACK.md'), 'utf-8')).toBe('# our own notes\n')
  })
})

describe('applyTechStackChange (kept for starter-less stacks)', () => {
  test('react-app reports the bundled runtime-template files it left alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-stack-kept-'))
    dirs.push(dir)
    writeFileSync(join(dir, '.tech-stack'), 'video-editor')
    applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })

    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'react-app', scope: 'root' })

    expect(result.ok).toBe(true)
    // react-app has no starter/ of its own — these come from the runtime-template.
    expect(result.kept).toContain('package.json')
    expect(result.kept).toContain('index.html')
    expect(result.kept).toContain('src')
    // Files the target stack does not write are not "kept".
    expect(result.kept).not.toContain('remotion.config.ts')
    expect(result.kept).not.toContain('README.md')
  })

  test('a stack that ships no files reports no collisions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-stack-none-'))
    dirs.push(dir)
    writeFileSync(join(dir, '.tech-stack'), 'video-editor')
    applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })

    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'none', scope: 'root' })

    expect(result.ok).toBe(true)
    expect(seedEntries('none')).toEqual([])
    expect(result.kept).toEqual([])
    // Nothing was overwritten — the project keeps its code.
    expect(existsSync(join(dir, 'src', 'videos', 'Main.tsx'))).toBe(true)
  })
})

describe('syncTechStackEnv', () => {
  test('root: moves TECH_STACK_ID to the new stack', () => {
    process.env.TECH_STACK_ID = 'react-app'
    expect(syncTechStackEnv('p-1', 'video-editor', 'root')).toBe(true)
    expect(process.env.TECH_STACK_ID).toBe('video-editor')
    // Idempotent.
    expect(syncTechStackEnv('p-1', 'video-editor', 'root')).toBe(false)
  })

  test('root without TECH_STACK_ID leaves it unset (desktop resolves from the marker)', () => {
    delete process.env.TECH_STACK_ID
    expect(syncTechStackEnv('p-1', 'video-editor', 'root')).toBe(false)
    expect(process.env.TECH_STACK_ID).toBeUndefined()
  })

  test('member: updates only that project in WORKSPACE_TECH_STACKS', () => {
    process.env.WORKSPACE_TECH_STACKS = JSON.stringify({ 'p-1': 'react-app', 'p-2': 'python-data' })
    expect(syncTechStackEnv('p-1', 'video-editor', 'member')).toBe(true)
    expect(JSON.parse(process.env.WORKSPACE_TECH_STACKS!)).toEqual({
      'p-1': 'video-editor',
      'p-2': 'python-data',
    })
  })

  test('member: survives a malformed map', () => {
    process.env.WORKSPACE_TECH_STACKS = 'not json'
    expect(syncTechStackEnv('p-1', 'video-editor', 'member')).toBe(true)
    expect(JSON.parse(process.env.WORKSPACE_TECH_STACKS!)).toEqual({ 'p-1': 'video-editor' })
  })

  test('applyTechStackChange updates the env for the project it changed', () => {
    const dir = reactProject()
    process.env.WORKSPACE_TECH_STACKS = JSON.stringify({ 'p-1': 'react-app' })

    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'member' })

    expect(result.envUpdated).toBe(true)
    expect(JSON.parse(process.env.WORKSPACE_TECH_STACKS!)).toEqual({ 'p-1': 'video-editor' })
  })
})

describe('applyTechStackChange without a registered preview restarter', () => {
  test('still seeds and reports previewRestarted: false', () => {
    setTechStackPreviewRestarter(null)
    const dir = reactProject()
    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })
    expect(result.ok).toBe(true)
    expect(result.previewRestarted).toBe(false)
  })
})
