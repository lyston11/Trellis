# Local patches: Pi inline workflow + context budget

This fork tracks [`mindfold-ai/Trellis`](https://github.com/mindfold-ai/Trellis)
upstream. Everything here is local customisation kept on the
`local/pi-inline-context` branch so `main` can stay a clean mirror of upstream.

## Why

Pi ran Trellis in **sub-agent-dispatch mode**, which on Pi means: every
implement/check step spawns a second `pi` process (`--mode json -p
--no-session`). That costs a cold start each time, hides the work behind a
progress card, blocks the main session while it runs, and shares no prompt
cache with the parent.

Separately, the extension's `before_agent_start` hook broadcast a large amount
of context into every request:

| What | Size | Why it was dropped |
|---|---:|---|
| `## Trellis Task Context` (prd/design/implement + curated specs) | 62581 chars | The main session edits directly now; `trellis-before-dev` reads artifacts on demand |
| `<trellis-workflow>` (Phase Index) | 7352 chars | The per-turn breadcrumb already carries the current phase instruction |
| `<first-reply-notice>` | 756 chars | Pure prompt noise, no behavioural value |

Measured on one project, the Trellis segment of the developer message went
**72952 → 3496 chars**, and total provider input per request
**154147 → 82221 chars (−46%)**.

## The commits

Branch `local/pi-inline-context`, on top of `upstream/main`:

| Commit | File | Intent |
|---|---|---|
| `fix(pi): drop the first-reply notice and the per-turn phase index` | template ext | Remove two pure-noise injections |
| `perf(pi): stop broadcasting the implement sub-agent context every turn` | template ext | Replace the full task context with a task pointer + curated manifest list |
| `perf(pi): dedup runtime messages on a small state key` | template ext | Stop re-appending a snapshot whenever git status changes |
| `fix(pi): key overview and pointer snapshots by task, not just session` | template ext | A mid-session task switch must rebuild them |
| `chore(pi): stop declaring trellis_subagent to the model by default` | template ext | `defaultActive: false` — still callable, no longer auto-selected |
| `feat(workflow): treat Pi as an inline platform` | `workflow.md` template | Pi reads `planning`/`in_progress` only; the `-inline` bodies were Codex-only |
| `chore: sync this repo's own Pi assets with the updated templates` | `.pi/`, `.trellis/` | The repo runs Trellis on itself |

## Two non-obvious points

**`implement.jsonl` / `check.jsonl` had to stay reachable.** They were
delivered *only* by the full task-context injection. Neither `trellis-before-dev`
nor `trellis-check` reads the manifests, so dropping the injection outright left
10 of 40 curated entries in one project unreachable — all cross-task spec
references. The task pointer therefore lists each entry as `path — reason`
(about 1.3 KB) and the bodies are read on demand.

**The snapshots had to be keyed by task.** `startupCtxCache` and
`taskCtxSnapshot` were keyed only by session, so switching tasks mid-session
left the overview describing the old task *and the task pointer aimed at the
old task's directory*. Both keys now include `readTaskDir(root, key)`.

## Known limitation

`packages/cli/test/templates/trellis.test.ts` asserts that the bundled
`workflow.md` is byte-identical to the `marketplace` submodule's mirror
(`marketplace/workflows/native/workflow.md`). Changing the template breaks that
test unless the submodule is updated too. This fork does **not** update it — the
submodule points at `mindfold-ai/marketplace`. Run tests with that in mind, or
fork and repoint the submodule if you want a green suite.

## Applying to a project

The template changes reach projects through `trellis init`. If the global CLI
package is installed from npm, reinstall it from this fork to pick them up:

```bash
npm i -g github:lyston11/Trellis
```

For an existing project, the two affected files are
`.pi/extensions/trellis/index.ts` and `.trellis/workflow.md`; both are safe to
copy from `packages/cli/src/templates/`.
