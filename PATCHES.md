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
| `feat(pi): remove trellis_subagent entirely, keep inline workflow` | template ext | The tool spawned a cold pi subprocess per dispatch and held the main session hostage; the user has no use for it. Removes the registration, the alt+o shortcut, the native-card rendering, the runPi/runSubagent pipeline, the CLI resolver, and the agent frontmatter parser. The inline workflow (context injection) is unchanged. Supersedes `chore(pi): stop declaring trellis_subagent to the model by default`. |
| `feat(workflow): treat Pi as an inline platform` | `workflow.md` template | Pi reads `planning`/`in_progress` only; the `-inline` bodies were Codex-only. The bodies it actually reads are the phase steps, so the platform-block membership is the part that matters — see the shared-breadcrumb note below. |
| `fix(pi): restore the cmdHasTrellisCtx guard` | template ext | `feat(pi): remove trellis_subagent entirely` deleted the definition with the rest of the sub-agent helpers but left the `tool_call` call site, so the handler threw `ReferenceError` and Pi blocked **every** bash call. Restored with a command-position regex (start, `env`/`export`, or after `;`/`&&`/`|`) instead of the old start-only one. |
| `refactor(pi): drop the context-injection path inline mode never reaches` | template ext | `buildContext` kept the whole #441 machinery alive (truncateUtf8, ContextBudget, the binary/truncate/index notices, readContextInjectionLimits, TRELLIS_AGENT_JSONL) although the task pointer had replaced the full context broadcast, so nothing called any of it. ~280 lines deleted; `readJsonlEntries` stays, the pointer uses it. |
| `fix(pi): escape single quotes with the standard '\'' sequence` | template ext | `shellQuote` emitted one backslash too few, so an embedded single quote closed the quoted string instead of surviving as data. The test had always expected the standard form. |
| `test(pi): sync pi.test.ts with inline mode` | test | The branch deleted eleven helpers the test file re-exported from the template, so `loadExtensionInternals()` threw before a single assertion ran (21 of 47 cases red). Dropped the sub-agent suites and re-pointed the survivors at pointer/breadcrumb behaviour. |
| `fix(workflow): keep the inline wording out of the shared breadcrumbs` | `workflow.md` template, template ext | The branch had overwritten the sub-agent dispatch lines in the plain `[workflow-state:planning]` / `[in_progress]` blocks with inline wording. Pi never reads those bodies (the extension resolves the status to a phase step first), while every non-codex platform's hook injects exactly them — `resolve_breadcrumb_key` returns the plain status for everything but codex. Restored the dispatch lines, kept the task-coordination additions, and made the Pi fallback prefer the `-inline` twin. See below. |
| `test: align the upstream suites with inline mode` | tests, `.husky/` | Five files asserted behaviour the branch removed: sub-agent registration in the generated extension, Pi's step 2.1 hook block, the sub-agent jsonl line in the planning breadcrumb, and two hardcoded platform-block member lists. Also made one fixture idempotent (a sibling bare repo survived across runs, so its second `main` push was rejected as non-fast-forward) and added the missing build to the pre-commit hook — three integration tests spawn the real CLI, which loads `packages/cli/dist/`. |
| `chore: sync this repo's own Pi assets with the updated templates` | `.pi/`, `.trellis/` | The repo runs Trellis on itself |

## Non-obvious points

**The shared breadcrumbs leaked inline guidance to twelve platforms.**
`feat(workflow): treat Pi as an inline platform` rewrote the plain
`[workflow-state:planning]` and `[workflow-state:in_progress]` bodies to say
"skip jsonl curation" and "do not dispatch implement/check sub-agents". The
intent was to make Pi inline, but Pi cannot see those bodies:

- the extension resolves a status to a phase step first (`stepForStatus`:
  `planning` → 1.1, `in_progress` → 2.1) and pushes the step detail; the body is
  only the fallback, and `no_task`/`task_error` (which have no inline twin) are
  the states where a body really is what Pi reads;
- `inject-workflow-state.py`'s `resolve_breadcrumb_key` returns the plain status
  for every platform except codex, so Claude Code, Cursor, Kiro, Gemini, Qoder,
  Copilot, Droid, ZCode, Snow, Oh My Pi, Reasonix, Trae, Grok and Kimi Code all
  read those bodies — and their step 2.1 still tells them to dispatch.

So the edit reached only the platforms it was wrong for. The bodies are back to
the sub-agent wording (plus the new coordination lines), and the Pi fallback now
prefers `templates[`${status}-inline`]`, which is the variant the comment above
the block always claimed Pi used.

**Two tests were failing for reasons unrelated to the branch.** The
`platforms.integration` suite spawns the built CLI, so it fails on any tree
without `packages/cli/dist/` — the pre-commit hook now builds first. And the
`issue-399.1` fixture creates its bare remote at `path.join(tmpDir, "..")`,
which the OS tmpdir keeps between runs: the second run pushes a different `main`
and git rejects it, so it deletes the leftover first.

**A deleted helper still had a call site.** `cmdHasTrellisCtx` sat between the
sub-agent helpers `feat(pi): remove trellis_subagent entirely` deleted, so it went
with them — but the `tool_call` hook still called it. Pi's `emitToolCall` has no
try/catch (unlike `before_agent_start`), so the `ReferenceError` propagated to
`prepareToolCall` and turned into an error tool result: bash never ran. The
symptom in a live session is a tool result reading
`cmdHasTrellisCtx is not defined`, and nothing else in the extension looks wrong —
the breadcrumb, the startup snapshot and the dedup all work.

This is also why every deployed copy has to be checked, not just the template:
the `trellis init` templates and the `.pi/extensions/trellis/index.ts` copies in
the projects all come from the same bytes.

**Two things the branch left behind, and how they hid.** The dead-code removal
was invisible to any test because the test file could not load at all: it
re-exported helpers (`normalizeAgent`, `buildPiArgs`, `servingSessionId`, …) that
went out with the sub-agent feature, so `loadExtensionInternals()` threw and
took every case in the file with it — including the ones covering behaviour that
still existed. A green-looking subset (26 of 47) came only from the one suite
that does not call it.

The `shellQuote` bug is the same shape: the escape sequence was written as
`'\''` in a template literal instead of `'\\''`, which renders as

```
before:  `'${v.replace(/'/g, `'\''`)}'`    -> with 'quote' => 'with 'quote''
after:   `'${v.replace(/'/g, `'\\''`)}'`   -> with 'quote' => 'with '\''quote'\'''
```

Both variants read the same in a diff at a glance, and only the second is a
valid shell escape. `cmdHasTrellisCtx` guards the injected
`export TRELLIS_CONTEXT_ID='<key>'; …`, so a key carrying a quote would have
broken the command it prefixes.

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

`stateKey` therefore appended a per-send counter while the breadcrumb reported
`no_task` (~422-byte breadcrumb per turn). That counter is gone: once the
breadcrumb also carried the active step (below), the `in_progress` case needed
the same treatment, so *both* statuses re-assert on every turn and the 1.5s
`getTurnCtx` window is the only dedup left. Same trade-off applies to the full
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
