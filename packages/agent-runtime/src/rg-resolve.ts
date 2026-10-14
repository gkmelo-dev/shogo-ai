// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Resolves the ripgrep binary path.
 *
 * Order: `SHOGO_RG_PATH` (set by the desktop app, whose compiled runtime has
 * no node_modules to resolve @vscode/ripgrep from), then the @vscode/ripgrep
 * binary, then a bare 'rg' on PATH.
 */

import { existsSync } from 'fs'

let _resolved: string | undefined

/**
 * Test-only indirection seam — production code uses the defaults
 * (`require` + `existsSync` from 'fs'). Swap `.require` / `.existsSync`
 * inside a unit test to drive the @vscode/ripgrep-missing and the
 * bundled-binary-not-on-disk branches; call `.reset()` between tests to
 * clear the module-private cache.
 */
export const _rgResolveSeamForTests: {
  require: (name: string) => unknown
  existsSync: (p: string) => boolean
  reset: () => void
} = {
  require: (name: string) => require(name),
  existsSync,
  reset() {
    _resolved = undefined
  },
}

export function resolveRgPath(): string {
  if (_resolved !== undefined) return _resolved

  const configured = process.env.SHOGO_RG_PATH
  if (configured && _rgResolveSeamForTests.existsSync(configured)) {
    _resolved = configured
    return _resolved
  }

  try {
    const { rgPath } = _rgResolveSeamForTests.require('@vscode/ripgrep') as { rgPath: string }
    if (rgPath && _rgResolveSeamForTests.existsSync(rgPath)) {
      _resolved = rgPath
      return _resolved
    }
  } catch { /* package not installed — fall through */ }

  _resolved = 'rg'
  return _resolved
}
