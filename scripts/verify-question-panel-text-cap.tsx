/**
 * Headless verification of the questionnaire panel's text budget: the question
 * body and its detail block are model-authored and the protocol bounds
 * neither, so both are pre-wrapped and capped (issue #1664, same class as the
 * approval panel's command preview). At 40 rows this checks that:
 *
 *   - a 40-line question keeps the option rows painted inside the viewport;
 *   - the question is capped and advertises the hidden tail;
 *   - the author's own line breaks survive the wrapping;
 *   - a short question renders as before, with no hint row.
 *
 * Run against the compiled lib: `npx tsx scripts/verify-question-panel-text-cap.tsx`
 */
import './lib/fake-home.mjs'
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import { render, AlternateScreen, Box } from '../lib/types/ui.js'
import { AskUserQuestionPanel } from '../lib/types/components/questions/AskUserQuestionPanel.js'
import instances from '../lib/types/ink/instances.js'
import { viewportLines } from './lib/term-test.mjs'

const { Terminal } = xterm

const ROWS = 40
const COLS = 100

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function makeStreams() {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  let painted = Promise.resolve()
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      frames.push(String(chunk))
      painted = painted.then(() => new Promise<void>(resolve => terminal.write(String(chunk), () => resolve())))
      cb()
    },
  }) as NodeJS.WriteStream & { frames: string[] }
  const frames: string[] = []
  stdout.frames = frames
  stdout.columns = COLS
  stdout.rows = ROWS
  stdout.isTTY = true
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

function screenText(terminal: InstanceType<typeof Terminal>): string {
  return viewportLines(terminal).map(line => line.trimEnd()).join('\n')
}

async function mount(question: string, detail?: string) {
  const { stdout, stderr, stdin, terminal, flush } = makeStreams()
  const previousInk = instances.get(process.stdout)
  const tree = React.createElement(
    AlternateScreen,
    null,
    React.createElement(
      Box,
      { flexDirection: 'column', height: ROWS },
      React.createElement(Box, { flexDirection: 'column', flexGrow: 1 }),
      React.createElement(
        Box,
        { flexDirection: 'column', flexShrink: 0 },
        React.createElement(AskUserQuestionPanel, {
          question: {
            question,
            ...(detail === undefined ? {} : { detail }),
            options: [
              { label: 'Option Alpha', description: 'first choice' },
              { label: 'Option Beta' },
              { label: 'Option Gamma' },
            ],
          },
          position: 1,
          total: 1,
          answered: false,
          onAnswer: () => {},
          onCancel: () => {},
          onEscape: () => {},
          onBack: () => {},
          onForward: () => {},
        } as never),
      ),
    ),
  )
  const made = await render(tree, { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false } as never)
  const ink = instances.get(stdout)
  instances.set(process.stdout, ink)
  if (ink !== undefined) ink.setAltScreenActive?.(true, true)
  await flush()
  return {
    terminal,
    cleanup: async () => {
      try { made?.unmount?.() } catch {}
      await flush()
      terminal.dispose()
      if (previousInk !== undefined) instances.set(process.stdout, previousInk)
      else instances.delete(process.stdout)
    },
  }
}

async function runLong(): Promise<void> {
  console.log(`\n${ROWS}x${COLS} · 40-line question`)
  const question = Array.from({ length: 40 }, (_, i) => `question line ${i + 1}: ${'q'.repeat(60)}`).join('\n')
  const { terminal, cleanup } = await mount(question)
  const text = screenText(terminal)

  check('option rows are painted inside the viewport', /\bOption Alpha\b/u.test(text) && /\bOption Gamma\b/u.test(text))
  check('question rows are capped (≤ 6 + hint)', (text.match(/question line \d+:/gu) ?? []).length <= 6)
  check('the hidden tail is advertised', /more lines not shown/u.test(text))
  check('the last question line is not painted', !text.includes('question line 40:'))
  check('author line breaks are preserved', /question line 1: q+/u.test(text) && /question line 2: q+/u.test(text))
  await cleanup()
}

async function runShort(): Promise<void> {
  console.log(`\n${ROWS}x${COLS} · short question`)
  const { terminal, cleanup } = await mount('Pick one')
  const text = screenText(terminal)

  check('the question paints', /Pick one/u.test(text))
  check('options stay visible', /\bOption Alpha\b/u.test(text) && /\bOption Gamma\b/u.test(text))
  check('no hint row for a short question', !/more lines not shown/u.test(text))
  await cleanup()
}

await runShort()
await runLong()

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
