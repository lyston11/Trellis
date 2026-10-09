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
| `perf(pi): dedup runtime messages on a small state key` | template ext | Stop re-appending a snapshot whenever git status changes; no_task stays exempt (see below) |
| `fix(pi): carry the phase step and the artifact list in the breadcrumb` | template ext | An active task used to dedup per status, which meant its step detail vanished once persisted. It now re-asserts every turn and names the task's worktree, so the model keeps seeing "cd there" and "read prd.md first" instead of losing it in a 124-line AGENTS.md. |
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

**`no_task` had to be exempt from the dedup.** Dropping the phase index
removed the only thing that re-asserted the triage rules every turn, and on Pi
no other channel covers for it:

- Phase 2's dispatch instructions do not apply — Pi registers no Task/Agent
tool, so "dispatch `trellis-implement` / `trellis-check`" is unactionable and
the model correctly edits inline.
- The system prompt's `<ready>` is generic ("decide whether to create,
continue, or skip a Trellis task") and the `project_context` block keeps only
the weak line "跨模块、需求不清或需要持续跟踪的工作先创建 Trellis task".
- `<workflow-state>` is therefore the *only* concrete instruction ("Complex
task: ask whether you may create a Trellis task and enter planning").

With `stateKey = root + breadcrumb` it was injected once per session and then
buried: 2026-10-09 15:26 familygraph session, `Status: no_task` at message 7 of
233, the user ending up saying "先创建trellis任务再执行" by hand. Pre-optimisation
sessions show the opposite pattern — the phase index appeared 85 times in one
transcript, which incidentally kept the same rules in view.

`stateKey` therefore appends a per-send counter while the breadcrumb reports
`no_task` (~422-byte breadcrumb per turn). Once a task exists the breadcrumb
varies by status and dedups exactly as before. Same trade-off applies to the full
phase-index restore: on Pi most of it is Claude Code/Cursor/Codex-specific and
only `### Request Triage` + `### Active Task Routing` do work.

**The breadcrumb had to carry the phase step.** Exempting `no_task` fixes task
*creation* but not task *execution*. The `workflow.md` bodies are summaries, and
the `in_progress` one (`Flow: trellis-before-dev -> edit -> trellis-check -> ...`)
refers to a Task/Agent tool Pi does not register, so the model edited inline
without reading `prd.md`, `design.md`, `implement.md` or `.trellis/spec/` —
even with a task bound to the session. No skill got loaded in either 2026-10-09
session, versus 144 loads across 26 pre-optimisation sessions.

So for a bound task the breadcrumb now emits the active step's own guidance
(`get_context.py --mode phase --platform pi --step 2.1`, the same text
`trellis-before-dev` would have surfaced) plus an explicit artifact list and,
when `task.json.worktree_path` is set, a one-line worktree reminder:

```
<workflow-state>
Task: architecture-completion-orchestration (in_progress)
Task dir: .trellis/tasks/10-06-architecture-completion-orchestration
Worktree: /Users/lyston/PycharmProjects/fg-10-06-... — write code there, keep the main checkout clean (AGENTS.md parallel-isolation rule).
Read before editing: prd.md, design.md, implement.md in that directory.
#### 2.1 Implement `[required · repeatable]`


1. Load the `trellis-before-dev` skill to read project guidelines
2. Read `{TASK_DIR}/prd.md`, ...
3. Consult materials under `{TASK_DIR}/research/`
4. Implement the code per reviewed artifacts
5. Run project lint and type-check
</workflow-state>
```

**Every turn, not just on status change.** The dedup-from-§3 is a same-turn
cache (the 1.5s window in `getTurnCtx`); it never survives across user turns.
Deduping across turns is what created the two symptoms above: no_task lost its
triage prompt after turn 1, and an active task lost its artifact list after the
first injection. Measured cost: no_task 472 B, in_progress 738 B, planning
1575 B — about 1.5% of a 40 KB request.

This also kills the compaction duplicate. The same-text key used to break at
every compaction because Magic Context rewrites history, so a session produced
nine duplicates — four of them adjacent. Re-asserting unconditionally does not
need the key to be perfect; the 1.5s window is the only dedup that matters.

The step text is read from disk each turn but returned from a per-process cache
(`stepDetailCache`), keeping the repeated python spawn off the hot path.
`--platform pi` matters: without it the step renders the Claude Code/Cursor
dispatch text.

Two smaller fixes rode along: a stale runtime pointer naming an archived task
directory now falls back to `no_task` instead of suppressing the triage
instruction forever, and `<ready>` in the system prompt states that an active
task's artifacts and the specs they name are required reading.

## Known limitation: worktree isolation is project-side, not here

`AGENTS.md` asks for one branch + one linked worktree per task, and
`familygraph` implements that with a Trellis `hooks.after_start` entry running
`.trellis/scripts/hooks/auto_worktree.py`. That file is **project**
customisation (`apply_customization.py`), not part of the templates in this
fork, so the breadcrumb cannot remind anyone about it. A project missing the
hook gets a task with `worktree_path: null` and no complaint. Check the project,
not this fork:

```bash
python3 ./.trellis/scripts/task.py create "probe" --slug probe
python3 - <<'EOF'
import json; print(json.load(open('.trellis/tasks/*probe*/task.json'))['worktree_path'])
EOF
```

## Verifying a breadcrumb change without a live session

The extension is a template, so it is exercised by importing it directly:

```bash
cp packages/cli/src/templates/pi/extensions/trellis/index.ts.txt /tmp/ext.ts
bun build /tmp/ext.ts --target=node --format=esm --outfile=/tmp/trellis_ext.mjs
```

Then call the `before_agent_start` handler with a fake `pi` object and a
`ctx.sessionManager.getSessionId()` of `"<uuid>"` (the runtime pointer file is
`pi_<uuid>.json`; a `pi_`-prefixed id misses it and silently reports `no_task`).
Fire the handler twice to check dedup: repeating a breadcrumb means the dedup key
is wrong, an empty second message means it is right.

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

## Keeping up with upstream

`main` stays a clean mirror of `upstream/main`; the patches live only on
`local/pi-inline-context`. To sync:

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main
git push origin main

git checkout local/pi-inline-context
git rebase main                       # replay the patch commits
git push --force-with-lease origin local/pi-inline-context
```

To review the whole patch set at once:

```bash
git diff upstream/main..local/pi-inline-context
git diff upstream/main..local/pi-inline-context --stat
```
