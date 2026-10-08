import { expect, test } from 'claude-code/testing'

import { NotebookState } from '../hooks/core/notebook'
import { KernelHold } from '../hooks/core/hold'
import { herdrCalls, isStaleState, modeFor, stateText } from '../hooks/register'

const STATE = (rev: string) => `<marimo_notebook_state rev="${rev}" path="/n.py" url="u" session="s">\n…\n</marimo_notebook_state>`

test('a superseded state block is left out; the latest and other text pass', async ($, on) => {
  // The engine beneath answers with the text as it was.
  on('prompt.attachment', ($: any, e: any) => ({ text: e.text }))
  const plugin = { kind: 'plugin', event: 'prompt.submit' } as const
  // Nothing attached yet in this process: any earlier block is stale (an older process's).
  const old = await $.prompt.attachment({ type: 'hook_additional_context', text: STATE('abc-3'), origin: plugin } as any)
  expect(old.text).toBe(null)
  const other = await $.prompt.attachment({ type: 'hook_additional_context', text: 'unrelated context', origin: plugin } as any)
  expect(other.text).toBe('unrelated context')
  // The engine's own text is never touched, even if it quotes a block.
  const engine = await $.prompt.attachment({ type: 'file', text: STATE('abc-3'), origin: { kind: 'engine' } } as any)
  expect(engine.text).toBe(STATE('abc-3'))
})

test('staleness compares revisions', () => {
  expect(isStaleState(STATE('n-1'), 'n-2')).toBe(true)
  expect(isStaleState(STATE('n-2'), 'n-2')).toBe(false)
  expect(isStaleState('no block here', 'n-2')).toBe(false)
})

test('the block carries its revision', () => {
  const notebook = new NotebookState()
  notebook.apply('kernel-ready', { cell_ids: ['a'], codes: ['x = 1'], names: ['_'], configs: [] })
  const text = stateText([{ notebook, attachment: { url: 'http://127.0.0.1:2718', sessionId: 's1', path: '/w/nb.py' } }], 'n-7')
  expect(text.startsWith('<marimo_notebook_state rev="n-7" notebooks="1">')).toBe(true)
  expect(text).toContain('=== /w/nb.py (current; http://127.0.0.1:2718, session s1) ===')
  expect(text).toContain('not updated during the turn')
})

test('MARIMO_NOTEBOOK pins or turns off', () => {
  expect(modeFor(undefined)).toEqual({ kind: 'auto' })
  expect(modeFor('/a/b.py')).toEqual({ kind: 'pinned', paths: ['/a/b.py'] })
  expect(modeFor('/a/b.py,/c.py')).toEqual({ kind: 'pinned', paths: ['/a/b.py', '/c.py'] })
  expect(modeFor('off')).toEqual({ kind: 'off' })
})

test('the herdr token while a cell Claude started outlives its turn', () => {
  const notebook = new NotebookState()
  notebook.apply('kernel-ready', { cell_ids: ['a'], codes: ['x = 1'], names: ['_'], configs: [] })
  notebook.apply('cell-op', { cell_id: 'a', status: 'running', timestamp: 1 })
  const followed = [{ attachment: { url: 'u', sessionId: 's', path: '/w/fit.py' }, notebook, connection: 'connected' as const, current: true, touchedAt: 1500 }]
  const hold = new KernelHold()
  hold.begin(1000)
  const held = hold.end(followed, 2000)
  expect(held).toEqual({ kind: 'held', value: 'fit.py: cell a' })
  expect(herdrCalls(held, 'w1:p1', false)).toEqual([
    ['herdr', 'pane', 'report-metadata', 'w1:p1', '--source', 'marimo', '--agent', 'claude', '--token', 'marimo=fit.py: cell a', '--ttl-ms', '86400000'],
  ])
  notebook.apply('cell-op', { cell_id: 'a', status: 'idle', timestamp: 5 })
  const finished = hold.update(followed, 62_000)
  expect(finished).toEqual({ kind: 'finished', title: 'fit.py finished', body: 'ran 1m00s' })
  expect(herdrCalls(finished, 'w1:p1', true)).toEqual([
    ['herdr', 'pane', 'report-metadata', 'w1:p1', '--source', 'marimo', '--agent', 'claude', '--clear-token', 'marimo'],
  ])
  expect(herdrCalls({ kind: 'released' }, 'w1:p1', false)).toEqual([])
})
