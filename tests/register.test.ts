import { expect, test } from 'claude-code/testing'

import { NotebookState } from '../hooks/core/notebook'
import { isStaleState, modeFor, stateText } from '../hooks/register'

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
  const watcher = { notebook, attachment: { url: 'http://127.0.0.1:2718', sessionId: 's1', path: '/w/nb.py' }, others: () => [] } as any
  const text = stateText(watcher, 0, 'n-7')
  expect(text.startsWith('<marimo_notebook_state rev="n-7" path="/w/nb.py"')).toBe(true)
  expect(text).toContain('replaced with a fresh copy at every prompt')
})

test('MARIMO_NOTEBOOK pins or turns off', () => {
  expect(modeFor(undefined)).toEqual({ kind: 'auto' })
  expect(modeFor('/a/b.py')).toEqual({ kind: 'pinned', path: '/a/b.py' })
  expect(modeFor('off')).toEqual({ kind: 'off' })
})
