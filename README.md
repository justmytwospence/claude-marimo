# claude-marimo

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that follows the
[marimo](https://marimo.io) notebooks open under your project, so Claude knows what they look like
and what they are doing without being asked. The Claude Code port of
[pi-marimo](https://github.com/justmytwospence/pi-marimo); `hooks/core` is pi-marimo's `src/core`,
copied unchanged.

- **Status line** under the prompt: `marimo: fit.py · running Data loading › Model fit (12s) · 1 error
  · also prep.py, plots.py`. The first notebook is the current one (used most recently), with what
  its kernel is doing: the running part is the markdown section (heading path) the running cell
  sits under, so you can tell roughly what is running. `also` names the other notebooks followed.
- **Context:** each prompt carries the state of every followed notebook beside it. The current one
  comes first and in full: its outline (markdown headings), one line per code cell with what it
  defines, and what needs attention (running, queued, errors, stale, edited but not rerun, changed
  by you in the browser since Claude's last turn). The others follow as short outlines with only the
  cells that need attention.
- **`/marimo`:** status and the open notebooks; `/marimo show` prints the block Claude sees;
  `/marimo auto`, `/marimo off`, or `/marimo <path> [<path>...]` to pin a set of notebooks.

It pairs with the [marimo-pair](https://github.com/marimo-team/marimo-pair) skill, which is how
Claude inspects and changes the notebook; this mod only reads.

## Only the latest copy

The state is attached at `prompt.submit` as context, and each block is tagged with a revision. A
`prompt.attachment` hook answers `null` for every block but the latest, and the mod invalidates
attachments after each prompt, so the conversation holds one copy of the state rather than one per
prompt. After a resume or reload only the next prompt's block is kept.

This differs from the pi and opencode ports, which add the block to each model request without ever
storing it. A mod cannot change the messages of a request (`turn.step` pins them), so here the
state is refreshed once per prompt, not before every tool follow-up, and dropping the previous
copy means the conversation after it is read uncached once per prompt (usually the last turn).

## How it works

The core subscribes to the notebook session's `/sse` stream as a marimo *kiosk* consumer: a
read-only viewer that cannot run or edit code and never takes the notebook over from your browser.
A mod runs without Node APIs, so the core reaches the host through `$`: the server registry with
`$.fs`, `/api/sessions` with `$.http.fetch`, and the stream through `curl` under `$.process.spawn`
(`$.http.fetch` buffers whole bodies). See pi-marimo's README for the rest.

It follows every notebook open under the session's working directory (up to eight, leaving out
hidden directories such as `.claude/worktrees/`). The current one is the one Claude last worked in,
read from its marimo-pair calls (`tool.call`: `--file`, `--session`, or `--url` when only one
followed notebook is on that server), so two Claude sessions in two notebooks each keep their own.
Before Claude has touched any, it is the one used most recently by anyone: a running cell first,
then the latest cell run or edit. Pin a set with `/marimo <path> <path>` or
`MARIMO_NOTEBOOK=/path/a.py,/path/b.py` (`off` disables the mod). Token-protected servers are reached with `MARIMO_TOKEN`.

## Install

A plugin directory with a hooks module, loaded with `claude --plugin-dir <checkout>` or listed in
`CLAUDE_CODE_PLUGIN_DIRS`. Needs `curl` and `realpath` on `PATH`. Tested with Claude Code 2.1.289.

## Development

```sh
claude plugin validate .   # static analysis of the hooks module
claude plugin test         # tests/, no session or network
tsc -p .                   # after one load, which writes .claude-plugin/types/
```
