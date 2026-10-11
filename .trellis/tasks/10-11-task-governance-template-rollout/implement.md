# Template rollout implementation plan

## Status: implemented, verified, awaiting merge

## Delivered

- `workflow.md` (dogfood `.trellis/` + `packages/cli/src/templates/trellis/`,
  byte-identical): new **Task Coordination (parallel work)** section, coordination
  commands in the Task System block, `blocked_by` named as the machine-checked
  ordering mechanism in the parent/child section, Phase 1.4 activation note, and
  coordination lines in all four breadcrumbs (`planning`, `planning-inline`,
  `in_progress`, `in_progress-inline`).
- `packages/cli/test/templates/trellis.test.ts`: two new tests pinning the
  coordination contract and its reach into every breadcrumb.

## Checklist

- [x] Sync runtime script behaviour into the shipped template (done in the
      runtime child, because the dogfood↔template parity test requires both
      trees to move in one commit).
- [x] Update workflow guidance in both trees.
- [x] Add template regression tests for the new guidance.
- [x] Run lint, typecheck and the full CLI suite against the stashed baseline.
- [ ] Commit and merge.

## Verification evidence

- `npx vitest run` (packages/cli): 36 failed / 1908 passed — **identical
  failure set to the stashed baseline** (`comm` diff empty in both directions).
- `npx vitest run test/templates/trellis.test.ts`: 25 passed, 3 failed; the 3
  are the same pre-existing failures as baseline, and the 2 new coordination
  tests pass.
- `npx eslint test/templates/trellis.test.ts`: clean.
- `npx tsc --noEmit` after `pnpm build:core`: clean.
- `diff -q` workflow.md across both trees: identical.
- `diff -rq .trellis/scripts packages/cli/src/templates/trellis/scripts`: identical.

## Deliberately not done

- **`marketplace/workflows/native/workflow.md` mirror was not updated.** Its
  parity test already fails at baseline, because the local `local/pi-inline-context`
  patch stack changed the template workflow without touching the submodule.
  Syncing it would publish those local Pi customisations into the
  `mindfold-ai/marketplace` submodule and require a submodule commit plus pointer
  update — a separate release decision, not part of this rollout.
- No `dist/**` hand edits; template update hashes are managed by the existing
  update pipeline.
