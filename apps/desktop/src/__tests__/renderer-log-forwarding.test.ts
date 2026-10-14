// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  attachRendererLogForwarding,
  formatConsoleMessage,
  parseConsoleMessage,
} from '../renderer-log-forwarding'

function fakeContents(id = 7) {
  const emitter = new EventEmitter() as EventEmitter & { id: number; getURL: () => string }
  emitter.id = id
  emitter.getURL = () => 'http://localhost:8081/projects/p1'
  return emitter
}

function capture() {
  const lines: Array<{ level: string; text: string }> = []
  return { lines, writeLog: (level: string, ...args: unknown[]) => lines.push({ level, text: args.join(' ') }) }
}

describe('parseConsoleMessage', () => {
  test('Electron >= 35 single event object', () => {
    expect(
      parseConsoleMessage([{ level: 'error', message: 'boom', lineNumber: 12, sourceId: 'index.js' }]),
    ).toEqual({ level: 'error', message: 'boom', lineNumber: 12, sourceId: 'index.js' })
  })
  test('legacy positional arguments', () => {
    expect(parseConsoleMessage([{}, 2, 'careful', 3, 'a.js'])).toEqual({
      level: 'warning',
      message: 'careful',
      lineNumber: 3,
      sourceId: 'a.js',
    })
  })
  test('unrecognised shapes are ignored', () => {
    expect(parseConsoleMessage([{}])).toBeNull()
    expect(parseConsoleMessage([])).toBeNull()
  })
})

describe('attachRendererLogForwarding', () => {
  test('forwards console warnings and errors, drops info/debug', () => {
    const c = fakeContents()
    const { lines, writeLog } = capture()
    attachRendererLogForwarding(c, writeLog)
    c.emit('console-message', { level: 'info', message: 'hello' })
    c.emit('console-message', { level: 'debug', message: 'noise' })
    c.emit('console-message', { level: 'warning', message: 'careful', sourceId: 'x.js', lineNumber: 4 })
    c.emit('console-message', {
      level: 'error',
      message: '[ChatPanel] Stream error: Error: Minified React error #185',
    })
    expect(lines).toEqual([
      { level: 'WARN', text: '[renderer:7] console.warn: careful (x.js:4)' },
      { level: 'ERROR', text: '[renderer:7] console.error: [ChatPanel] Stream error: Error: Minified React error #185' },
    ])
  })

  test('records render-process-gone, unresponsive and preload errors', () => {
    const c = fakeContents(3)
    const { lines, writeLog } = capture()
    attachRendererLogForwarding(c, writeLog)
    c.emit('render-process-gone', {}, { reason: 'oom', exitCode: -536870904 })
    c.emit('unresponsive')
    c.emit('responsive')
    c.emit('preload-error', {}, '/app/preload.js', new Error('bad preload'))
    expect(lines[0]).toEqual({
      level: 'ERROR',
      text: '[renderer:3] render process gone: reason=oom exitCode=-536870904 url=http://localhost:8081/projects/p1',
    })
    expect(lines[1]).toEqual({ level: 'WARN', text: '[renderer:3] renderer unresponsive' })
    expect(lines[2]).toEqual({ level: 'WARN', text: '[renderer:3] renderer responsive again' })
    expect(lines[3].level).toBe('ERROR')
    expect(lines[3].text).toContain('preload error in /app/preload.js: Error: bad preload')
  })

  test('rate-limits console floods per window and reports how many were dropped', () => {
    let t = 0
    const c = fakeContents()
    const { lines, writeLog } = capture()
    attachRendererLogForwarding(c, writeLog, { now: () => t, limit: 3, windowMs: 1000 })
    for (let i = 0; i < 10; i++) c.emit('console-message', { level: 'error', message: `e${i}` })
    expect(lines.map((l) => l.text)).toEqual([
      '[renderer:7] console.error: e0',
      '[renderer:7] console.error: e1',
      '[renderer:7] console.error: e2',
    ])
    // A crash is never dropped by the limit.
    c.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(lines.at(-1)?.text).toContain('render process gone')
    t = 1000
    c.emit('console-message', { level: 'error', message: 'later' })
    expect(lines.slice(-2).map((l) => l.text)).toEqual([
      '[renderer:7] 7 console lines suppressed (over 3/min)',
      '[renderer:7] console.error: later',
    ])
  })

  test('truncates very long messages', () => {
    const text = formatConsoleMessage(1, { level: 'error', message: 'x'.repeat(10_000) })
    expect(text.length).toBeLessThan(4_200)
    expect(text).toContain('[10000 chars]')
  })
})
