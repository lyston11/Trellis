# Execution plan

## Parent review

- [ ] Keep parent in `planning`; do not start it for implementation.
- [ ] Start child `10-11-task-resource-conflict-guard` first.
- [ ] After child 1 is merged to the template repo main, start child `10-11-task-governance-template-rollout`.
- [ ] Parent final review checks both child acceptance sets and template parity.

## Child 1: runtime guard

- [ ] Read CLI script/spec conventions and establish a dedicated worktree.
- [ ] Add normalized coordination metadata helpers and TypedDict/property support.
- [ ] Add path claim validation and conservative overlap detection tests.
- [ ] Add `task.py` commands for claims, resource group/lane, blockers and read-only preflight.
- [ ] Add start gate with deterministic conflict diagnostics and no partial writes.
- [ ] Add blocker cycle/transitive dependency validation.
- [ ] Add configurable default serialized resources without hardcoding FamilyGraph paths.
- [ ] Preserve old task.json list/current/archive behavior.
- [ ] Run Python lint/type checks and CLI task script tests.
- [ ] Commit, push, and merge through the single integration lane.

## Child 2: global template rollout

- [ ] Wait for child 1 to be merged; merge the latest template main into the rollout branch.
- [ ] Mirror `.trellis/scripts/**` to `packages/cli/src/templates/trellis/scripts/**` with byte parity.
- [ ] Update template workflow and bundled references with the new planning/start/preflight/integration rules.
- [ ] Add or update template/regression tests and migration notes.
- [ ] Run `pnpm lint`, `pnpm typecheck`, focused Vitest, full relevant Vitest, and Python parity checks.
- [ ] Verify current uncommitted `packages/cli/src/templates/pi/extensions/trellis/index.ts.txt` is unchanged and untracked from the rollout commit.
- [ ] Commit, push, merge, publish/update template artifacts through the existing release path.

## Risk checks

- [ ] Never use `rsync --delete` against a user project; only compare/copy the two tracked template trees inside the Trellis repository.
- [ ] Never start both children in parallel when they touch the same template/script resources.
- [ ] Never use `--force` to bypass a conflict; add a narrow claim or serialize the task.
- [ ] Never treat planning tasks as active file owners by default.
- [ ] Keep generated `dist/**` out of hand edits.
- [ ] Confirm one migration/test head and clean worktree before each integration.

## Validation commands

```bash
cd packages/cli
pnpm lint
pnpm typecheck
pnpm test -- test/scripts/task-resource-coordination.test.ts test/templates/trellis.test.ts test/regression.test.ts
pnpm test
pnpm build
cd ../..
diff -rq .trellis/scripts packages/cli/src/templates/trellis/scripts -x __pycache__
```

The final rollout child must also run `trellis update --dry-run` in a temporary fixture project and verify the new task coordination files are installed without overwriting a modified managed file.
