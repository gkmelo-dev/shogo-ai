// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tech-stack switching, in one place.
 *
 * Three callers used to do their own version of this — the Capabilities panel
 * (`POST /agent/workspace/reset-stack`), the GitHub import path (a repo's files
 * replace the starter, so the stack is re-detected) and the Git checkout path.
 * They drifted. Everything that applies a stack change to a workspace on disk
 * now goes through `applyTechStackChange()`:
 *
 *   1. (optional) wipe the previous stack's files — `resetFiles: true` only;
 *   2. seed the new stack's starter (missing files only) + `.tech-stack`;
 *   3. update the env the runtime reads the stack from, because
 *      `resolveWorkspaceTechStackId()` prefers `TECH_STACK_ID` /
 *      `WORKSPACE_TECH_STACKS` over the `.tech-stack` marker — a marker-only
 *      switch is a no-op in a cloud pod;
 *   4. restart that project's preview so the new stack's build is what serves.
 *
 * The preview restart is injected: this module is a leaf (project-tools imports
 * it), while the preview managers live in `server.ts`. `server.ts` registers
 * `restartPreviewForStack` here at boot.
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  getTechStackPath,
  loadTechStackMeta,
  readTechStackMarker,
  runtimeTemplateTopLevelEntries,
  seedRuntimeTemplate,
  seedTechStack,
  wipeProjectFiles,
  writeTechStackDoc,
} from './workspace-defaults'

/** Whether `projectDir` is the runtime's own workspace root or a member folder. */
export type TechStackScope = 'root' | 'member'

export interface PreviewRestartRequest {
  projectDir: string
  /** Member project id; the root's id is only informational. */
  projectId: string
  scope: TechStackScope
  stackId: string
}

type PreviewRestarter = (req: PreviewRestartRequest) => void

let previewRestarter: PreviewRestarter | null = null

/**
 * Register how a stack change restarts a preview. Called once by `server.ts`
 * at boot; `null` unregisters (tests).
 */
export function setTechStackPreviewRestarter(fn: PreviewRestarter | null): void {
  previewRestarter = fn
}

export interface ApplyTechStackChangeInput {
  projectDir: string
  /** Project id of the workspace being changed. */
  projectId: string
  stackId: string
  /**
   * `root` when `projectDir` is the runtime's `WORKSPACE_DIR`; `member` for an
   * attached project's own folder. Defaults to comparing against
   * `process.env.WORKSPACE_DIR`.
   */
  scope?: TechStackScope
  /**
   * Delete the current project code before seeding (the destructive reset the
   * Capabilities panel offers). Leaves `.shogo/`, `memory/`, `.git/` and
   * `.canvas-state.json` alone — see `WIPE_PRESERVE_TOP_LEVEL`.
   */
  resetFiles?: boolean
}

export interface ApplyTechStackChangeResult {
  ok: boolean
  stackId: string
  /** Top-level starter entries written. */
  seeded: boolean
  /** Top-level entries removed by `resetFiles`; `null` when nothing was wiped. */
  wiped: number | null
  /**
   * Existing top-level entries the new stack's seeding would have written and
   * therefore left alone — its own `starter/` files plus, for Vite-family
   * stacks, the files the bundled runtime-template provides. These are the ones
   * the caller has to migrate (or re-run with `resetFiles: true`).
   */
  kept: string[]
  /** Whether the runtime env the stack resolves from was updated. */
  envUpdated: boolean
  previewRestarted: boolean
  error?: string
}

function scopeOf(projectDir: string, explicit?: TechStackScope): TechStackScope {
  if (explicit) return explicit
  const root = process.env.WORKSPACE_DIR || process.env.AGENT_DIR
  return root && projectDir !== root ? 'member' : 'root'
}

/** Top-level entries a stack's starter would write into a workspace. */
function starterEntries(stackId: string): string[] {
  const stackPath = getTechStackPath(stackId)
  if (!stackPath) return []
  const starterDir = join(stackPath, 'starter')
  if (!existsSync(starterDir)) return []
  try {
    return readdirSync(starterDir)
  } catch {
    return []
  }
}

/**
 * Every top-level entry seeding `stackId` into a workspace would write.
 *
 * A stack declares its files in one of two places — its own `starter/`, or (for
 * Vite-family stacks, which declare `runtime.devServer: 'vite'`) the bundled
 * runtime-template. Both have to be counted: `react-app` has no `starter/` at
 * all, so reading only `starter/` reported `kept: []` for the most common switch
 * there is.
 */
export function seedEntries(stackId: string): string[] {
  const entries = new Set(starterEntries(stackId))
  if (loadTechStackMeta(stackId)?.runtime?.devServer === 'vite') {
    for (const entry of runtimeTemplateTopLevelEntries()) entries.add(entry)
  }
  return [...entries].sort()
}

/**
 * Point `TECH_STACK_ID` (root) / `WORKSPACE_TECH_STACKS[projectId]` (member) at
 * the new stack, so the next `resolveWorkspaceTechStackId()` agrees with the
 * marker we (or the GitHub import) wrote. Returns true when a value actually
 * changed.
 */
export function syncTechStackEnv(
  projectId: string,
  stackId: string,
  scope: TechStackScope,
): boolean {
  if (scope === 'root') {
    if (process.env.TECH_STACK_ID === stackId) return false
    // Only overwrite an existing var: a desktop single-project runtime has no
    // TECH_STACK_ID at all and resolves from `.tech-stack` alone.
    if (!process.env.TECH_STACK_ID) return false
    process.env.TECH_STACK_ID = stackId
    return true
  }
  let stacks: Record<string, string> = {}
  try {
    const parsed = JSON.parse(process.env.WORKSPACE_TECH_STACKS || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      stacks = parsed as Record<string, string>
    }
  } catch {
    stacks = {}
  }
  if (stacks[projectId] === stackId) return false
  process.env.WORKSPACE_TECH_STACKS = JSON.stringify({ ...stacks, [projectId]: stackId })
  return true
}

/**
 * Apply a stack change to a workspace that is reachable on this runtime.
 * Never throws: an unknown stack or an unwritable folder comes back as
 * `{ ok: false, error }` so the caller can report it instead of pretending.
 */
export function applyTechStackChange(input: ApplyTechStackChangeInput): ApplyTechStackChangeResult {
  const stackId = input.stackId?.trim()
  const projectId = input.projectId || basename(input.projectDir)
  const scope = scopeOf(input.projectDir, input.scope)
  const base: ApplyTechStackChangeResult = {
    ok: false,
    stackId,
    seeded: false,
    wiped: null,
    kept: [],
    envUpdated: false,
    previewRestarted: false,
  }

  if (!stackId) return { ...base, error: 'stackId is required' }
  if (!getTechStackPath(stackId)) return { ...base, error: `Unknown tech stack: ${stackId}` }
  if (!existsSync(input.projectDir)) {
    return { ...base, error: `Project folder does not exist: ${input.projectDir}` }
  }

  const entries = seedEntries(stackId)
  // Marker read BEFORE seeding — `seedTechStack()` rewrites it.
  const previousStackId = readTechStackMarker(input.projectDir)
  const kept = input.resetFiles
    ? []
    : entries.filter((entry) => existsSync(join(input.projectDir, entry)))

  let wiped: number | null = null
  if (input.resetFiles) wiped = wipeProjectFiles(input.projectDir)

  const seeded = seedTechStack(input.projectDir, stackId)
  if (!seeded) return { ...base, wiped, kept, error: `Failed to seed tech stack ${stackId}` }

  // `.shogo/` survives `wipeProjectFiles()`, and `seedTechStack()` only fills
  // STACK.md when it is missing — so on a switch it would keep describing the
  // stack the marker just left. Replace it, but leave `.shogo/AGENTS.md` (agent
  // identity) and the rest of `.shogo/` alone.
  if (previousStackId !== stackId) {
    writeTechStackDoc(input.projectDir, stackId, { overwrite: true })
  }

  // Vite-family stacks borrow the bundled runtime template (vite + react +
  // tailwind + the Hono/Prisma sidecar); whether a stack is one is declared in
  // its own stack.json rather than hard-coded here.
  if (loadTechStackMeta(stackId)?.runtime?.devServer === 'vite') {
    seedRuntimeTemplate(input.projectDir)
  }

  const envUpdated = syncTechStackEnv(projectId, stackId, scope)

  let previewRestarted = false
  if (previewRestarter) {
    try {
      previewRestarter({ projectDir: input.projectDir, projectId, scope, stackId })
      previewRestarted = true
    } catch (err: any) {
      console.warn(`[tech-stack-switch] preview restart failed: ${err?.message ?? err}`)
    }
  }

  console.log(
    `[tech-stack-switch] ${projectId}: ${stackId} (scope=${scope}, ` +
      `resetFiles=${input.resetFiles === true}, wiped=${wiped ?? 0}, kept=${kept.length})`,
  )

  return { ...base, ok: true, seeded, wiped, kept, envUpdated, previewRestarted }
}
