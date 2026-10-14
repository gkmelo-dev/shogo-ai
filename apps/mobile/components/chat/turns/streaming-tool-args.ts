// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Streaming file-tool arguments grow on every chunk (a `write_file` can stream
 * hundreds of KB). Widgets for a still-streaming call render a size and line
 * count only, and compare props with these O(keys) helpers instead of
 * stringifying the whole argument object per chunk.
 */

export function countLines(text: string): number {
  if (!text) return 0
  let lines = 1
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++
  return lines
}

/**
 * Cheap identity for streaming args: string values by length, other
 * primitives by value, nested objects by key only. Streamed arguments only
 * grow, so a changed length is a changed value.
 */
export function streamingArgsKey(args: Record<string, unknown> | undefined | null): string {
  if (!args) return ""
  let key = ""
  for (const name of Object.keys(args)) {
    const value = args[name]
    if (typeof value === "string") key += `${name}:s${value.length};`
    else if (value === null || typeof value !== "object") key += `${name}:${String(value)};`
    else key += `${name}:o;`
  }
  return key
}
