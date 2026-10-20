/**
 * Headless verification of the approval panel's command preview
 * (issue #1664): a long gated command must not grow the panel past the
 * terminal height — the panel is an in-flow, flexShrink:0 block, so every row
 * it asks for is taken from the frame and the rows below it (the option rows)
 * are dropped. Checks that at 40 rows:
 *
 *   - a 300-line command keeps both option rows painted inside the viewport;
 *   - the preview is capped and advertises the hidden tail;
 *   - Ctrl+O expands it up to the screen budget without pushing the options
 *     out again, and the hint flips to the collapse affordance;
 *   - a short command renders exactly as before, with no hint row.
 *
 * Run against the compiled lib: `node scripts/verify-approval-command-preview.tsx`
 * (the repo's verify runner passes it through tsx).
 */
import './lib/fake-home.mjs'
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import { render, AlternateScreen } from '../lib/types/ui.js'
import { ApprovalPanel } from '../lib/types/components/approvals/ApprovalPanel.js'
import instances from '../lib/types/ink/instances.js'
import { settle, viewportLines } from './lib/term-test.mjs'

const { Terminal } = xterm

const ROWS = 40
const COLS = 100

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function makeStreams() {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  let painted = Promise.resolve()
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      painted = painted.then(() => new Promise(resolve => terminal.write(String(chunk), resolve)))
      cb()
    },
  })
  stdout.columns = COLS
  stdout.rows = ROWS
  stdout.isTTY = true
  stdout.frames = []
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin, terminal, flush: () => painted }
}

/** The painted viewport as trimmed lines. */
function screenLines(terminal) {
  return viewportLines(terminal).map(line => line.trimEnd())
}

function makeCommand(scriptLines) {
  return Array.from({ length: scriptLines }, (_, i) => `line ${String(i + 1).padStart(3)}: ${'x'.repeat(50)}`).join('\n')
}

/** Mount the panel the way Chat's bottom chrome does: in-flow, no height cap. */
async function mount(command) {
  const { stdout, stderr, stdin, terminal, flush } = makeStreams()
  const previousInk = instances.get(process.stdout)
  const approval = {
    key: `verify-${command.length}`,
    toolName: 'bash',
    command,
    reason: 'workspace-write → danger-full-access',
  }
  const tree = React.createElement(
    AlternateScreen,
    null,
    React.createElement(ApprovalPanel, { approval, background: false, onDecide: () => {} }),
  )
  const made = await render(tree, { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false, alternateScreen: true })
  const ink = instances.get(stdout)
  instances.set(process.stdout, ink)
  if (ink !== undefined) ink.setAltScreenActive?.(true, true)
  await flush()

  const cleanup = async () => {
    try { made?.unmount?.() } catch {}
    await flush()
    terminal.dispose()
    if (previousInk !== undefined) instances.set(process.stdout, previousInk)
    else instances.delete(process.stdout)
  }
  return { stdin, terminal, flush, cleanup }
}

async function runLong() {
  console.log(`\n40x${COLS} · 300-line command`)
  const { stdin, terminal, flush, cleanup } = await mount(makeCommand(300))
  await flush()
  const collapsed = screenLines(terminal)
  const joined = collapsed.join('\n')

  check('option rows are painted inside the viewport', /\bYes, allow once\b/u.test(joined) && /\b2\. No\b/u.test(joined))
  check('the question row is painted', /Allow this operation\?/u.test(joined), '')
  check('preview is capped (≤12 command rows)', collapsed.filter(line => /line\s+\d+: x+/u.test(line)).length <= 12)
  check('the hidden tail is advertised', /more lines not shown/u.test(joined))
  check('the expand affordance is offered', /to expand/u.test(joined))
  check('the last command line is not painted', !joined.includes('line 300:'))

  stdin.write('\x0f') // Ctrl+O
  await settle(() => screenLines(terminal).join('\n').includes('to collapse'))
  const expanded = screenLines(terminal)
  const expandedJoined = expanded.join('\n')
  const expandedRows = expanded.filter(line => /line\s+\d+: x+/u.test(line)).length

  check('Ctrl+O shows more command rows', expandedRows > 12, `${expandedRows} rows`)
  check('Ctrl+O keeps the option rows visible', /\bYes, allow once\b/u.test(expandedJoined) && /\b2\. No\b/u.test(expandedJoined))
  check('expanded preview still stops before the screen edge', expandedRows < ROWS - 4, `${expandedRows} rows`)
  check('hint flips to collapse', /to collapse/u.test(expandedJoined))

  await cleanup()
}

async function runShort() {
  console.log(`\n40x${COLS} · 3-line command`)
  const { terminal, flush, cleanup } = await mount(makeCommand(3))
  await flush()
  const lines = screenLines(terminal)
  const joined = lines.join('\n')

  check('all three command rows paint', ['line   1:', 'line   2:', 'line   3:'].every(prefix => joined.includes(prefix)))
  check('options stay visible', /\bYes, allow once\b/u.test(joined) && /\b2\. No\b/u.test(joined))
  check('no preview hint row for a short command', !/to expand|to collapse/u.test(joined))

  await cleanup()
}

await runShort()
await runLong()

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
