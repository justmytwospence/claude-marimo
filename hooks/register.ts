// marimo: follows the live marimo notebook open under the project.
//
// - Status line under the prompt: `marimo: fit.py · running Data loading › Model fit (12s) · 1 error`.
// - Context: each prompt carries the notebook's current state beside it (prompt.submit's context).
//   Older copies are left out of every later request (prompt.attachment answers null for them),
//   so the conversation holds one copy, the latest, instead of one per prompt.
// - /marimo: status, show, auto, off, or a notebook path to follow.
//
// The port of pi-marimo; core/ is shared with it unchanged. The host reads on(...) and
// $.noun.method(...) from source, so every $ call is spelled in full in this file and the
// core reaches the host only through the Io built in claudeIo.
import type { EngineInterface, On } from 'claude-code'

import { type Cancellable, type Io, normalize, type StreamEnd } from './core/io.js'
import { snapshot, STATE_TAG, statusParts, statusText } from './core/render.js'
import { MarimoWatcher, type Mode } from './core/watcher.js'

const COMMAND = 'marimo'

/** What the hooks share across a session. */
interface State {
  watcher?: MarimoWatcher
  /** Browser edits after this change number are flagged as new in the next prompt's state. */
  seenSeq: number
  /** Revisions of the state this process attached are `<nonce>-<n>`; only the latest is kept. */
  nonce: string
  revision: number
  ticker?: { cancel: () => void }
  lastStatus?: string
}

export function register(on: On): void {
  const s: State = { seenSeq: 0, nonce: Math.random().toString(36).slice(2, 8), revision: 0 }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'marimo: status, show, auto, off, or a notebook path to follow',
      argumentHint: '[status|show|auto|off|<path>]',
      immediate: true,
    })
    const cwd = await $.session.cwd()
    const token = (await $.env.get('MARIMO_TOKEN'))?.trim() || undefined
    const pinned = (await $.env.get('MARIMO_NOTEBOOK'))?.trim()
    startWatcher($, s, cwd, token, pinned)
    return started
  })

  on('session.end', async ($, e, next) => {
    s.ticker?.cancel()
    s.ticker = undefined
    await s.watcher?.stop()
    s.watcher = undefined
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const watcher = s.watcher
    if (!watcher) return next(e)
    watcher.refresh()
    await watcher.settle(2000)
    if (!watcher.attachment || watcher.connection !== 'connected' || !watcher.notebook.ready) return next(e)
    s.revision++
    const text = stateText(watcher, s.seenSeq, `${s.nonce}-${s.revision}`)
    const result = await next({ ...e, context: [...(e.context ?? []), text] })
    // Ask every attachment again, so the copies this one supersedes are left out.
    $.ui.invalidate('prompt.attachment')
    return result
  })

  on('prompt.attachment', ($, e, next) => {
    if (e.origin.kind === 'plugin' && isStaleState(e.text, `${s.nonce}-${s.revision}`)) return { text: null }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (s.watcher) s.seenSeq = s.watcher.notebook.seq
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const watcher = s.watcher
    if (!watcher) return { text: 'marimo: not started' }
    const arg = e.args.trim()
    if (arg === 'auto' || arg === 'off') {
      watcher.setMode(modeFor(arg === 'off' ? 'off' : undefined))
      return { text: arg === 'off' ? 'marimo: off' : 'marimo: following the notebook used most recently under this directory' }
    }
    if (arg === 'show') {
      if (!watcher.attachment || watcher.connection !== 'connected') return { text: statusFor(watcher) ?? 'marimo: no notebook attached' }
      return { text: snapshot(watcher.notebook, watcher.attachment, { seenSeq: s.seenSeq, others: watcher.others(), refresh: 'prompt' }) }
    }
    if (arg && arg !== 'status') {
      watcher.setMode({ kind: 'pinned', path: normalize(arg, await $.session.cwd()) })
      return { text: `marimo: following ${arg}` }
    }
    const open = await watcher.list()
    return {
      text: [
        statusFor(watcher) ?? 'marimo: no notebook attached',
        `Mode: ${watcher.mode.kind}${watcher.mode.kind === 'pinned' ? ` (${watcher.mode.path})` : ''}.`,
        open.length ? `Open notebooks:\n${open.map((n) => `  ${n.path}  (${n.url}, session ${n.sessionId})`).join('\n')}` : 'No marimo notebooks are open.',
      ].join('\n'),
    }
  })

}

function startWatcher($: EngineInterface, s: State, cwd: string, token: string | undefined, pinned: string | undefined): void {
  s.watcher = new MarimoWatcher({ io: claudeIo($), cwd, token, onChange: () => showStatus($, s) })
  s.watcher.mode = modeFor(pinned)
  s.watcher.start()
}

/** Pin the status line; tick it every second while a cell runs. */
function showStatus($: EngineInterface, s: State): void {
  const watcher = s.watcher
  if (!watcher) return
  const text = statusFor(watcher)
  if (text !== s.lastStatus) {
    s.lastStatus = text
    // The host labels a plugin's status line with the plugin's name ("marimo: ").
    $.ui.status(text?.replace(/^marimo: /, ''))
  }
  const running = watcher.connection === 'connected' && watcher.notebook.running()
  if (running && !s.ticker) s.ticker = $.clock.every(1000, () => showStatus($, s))
  if (!running && s.ticker) {
    s.ticker.cancel()
    s.ticker = undefined
  }
}

/** MARIMO_NOTEBOOK=<path> follows that notebook, =off turns the plugin off; unset follows the one open under the project. */
export function modeFor(pinned: string | undefined): Mode {
  if (pinned === 'off') return { kind: 'off' }
  return pinned ? { kind: 'pinned', path: pinned } : { kind: 'auto' }
}

export function statusFor(watcher: MarimoWatcher): string | undefined {
  const { connection, attachment, mode } = watcher
  if (!attachment) return undefined
  if (connection === 'searching') {
    return mode.kind === 'pinned' ? statusText({ notebook: attachment.path.split('/').pop() ?? attachment.path, connection: 'not open', queued: 0, errors: 0 }) : undefined
  }
  return statusText(statusParts(watcher.notebook, attachment, connection, Date.now(), watcher.others().length))
}

/** The state block, tagged with its revision so later requests can tell it is superseded. */
export function stateText(watcher: MarimoWatcher, seenSeq: number, rev: string): string {
  return snapshot(watcher.notebook, watcher.attachment!, { seenSeq, others: watcher.others(), refresh: 'prompt' })
    .replace(`<${STATE_TAG} `, `<${STATE_TAG} rev="${rev}" `)
}

/** True for a state block of this plugin that is not the latest revision. */
export function isStaleState(text: string, latest: string): boolean {
  const match = new RegExp(`<${STATE_TAG} rev="([^"]+)"`).exec(text)
  return match !== null && match[1] !== latest
}

/** The core's host calls, through $: no Node APIs in a mod's sandbox. */
function claudeIo($: EngineInterface): Io {
  return {
    async registryEntries() {
      const home = (await $.env.get('HOME')) ?? ''
      const state = (await $.env.get('XDG_STATE_HOME')) || `${home}/.local/state`
      const dir = `${state}/marimo/servers`
      const entries: unknown[] = []
      const files = await $.fs.list(dir).catch(() => [])
      for (const file of files) {
        if (file.kind !== 'file' || !file.name.endsWith('.json')) continue
        try {
          entries.push(JSON.parse(await $.fs.read(`${dir}/${file.name}`)))
        } catch {
          // A file being written or removed; skip it this round.
        }
      }
      return entries
    },

    async getJson(url, headers, timeoutMs) {
      const request = $.http.fetch(url, { headers }).then(
        (response) => (response.ok ? JSON.parse(response.text) : undefined),
        () => undefined,
      )
      const timeout = $.clock.sleep(timeoutMs).then(() => undefined)
      return Promise.race([request, timeout]).catch(() => undefined)
    },

    // $.http.fetch buffers a whole body, so the SSE stream is read through curl.
    stream(url, headers, onText): Cancellable<StreamEnd> {
      const argv = ['curl', '--silent', '--no-buffer', '--fail']
      for (const [name, value] of Object.entries(headers)) argv.push('--header', `${name}: ${value}`)
      argv.push(url)
      const child = $.process.spawn({ argv })
      let received = false
      let cancelled = false
      const done = (async (): Promise<StreamEnd> => {
        try {
          for await (const chunk of child) {
            if (cancelled) break
            if (chunk.stream !== 'stdout') continue
            received = true
            onText(chunk.text)
          }
        } catch {
          return { ok: cancelled }
        }
        return { ok: received || cancelled }
      })()
      return {
        done,
        cancel: () => {
          cancelled = true
          void child.return(undefined as never).catch(() => undefined)
        },
      }
    },

    async realpath(path) {
      const result = await $.process.run(['realpath', path]).catch(() => undefined)
      const real = result && result.exitCode === 0 ? result.stdout.trim() : ''
      return real || path
    },

    sleep(ms): Cancellable<void> {
      let cancel = (): void => {}
      const done = new Promise<void>((resolve) => {
        const timer = $.clock.after(ms, resolve)
        cancel = () => {
          timer.cancel()
          resolve()
        }
      })
      return { done, cancel }
    },
  }
}
