# Runtime guard implementation plan

## Status: implemented, verified, awaiting merge to template main

## Delivered

- `common/coordination.py`: claim normalization, conservative overlap detection,
  dependency graph, integration-lane ownership, read-only preflight, and an
  atomic short-lived lock with stale-takeover.
- `task.py`: `claim-paths`, `set-resource`, `add-blocker`, `remove-blocker`,
  `integration-claim`, `integration-release`, `preflight`; `start` now enforces
  coordination before writing status or the session pointer.
- `task_store.py`: new tasks carry a normalized empty `coordination` object.
- `types.py`: `TaskData.coordination`.
- `config.yaml`: `coordination.default_serialized_paths` (both dogfood and
  template copies).
- `packages/cli/src/templates/trellis/index.ts`: registered
  `common/coordination.py` in the template script manifest.
- `packages/cli/test/scripts/task-resource-coordination.integration.test.ts`.
- `.trellis/spec/cli/backend/script-conventions.md`: coordination contract.

## Checklist

- [x] Add coordination types/normalization and conservative overlap helpers.
- [x] Add focused Vitest integration test source.
- [x] Add claim/resource/blocker/preflight CLI parsers and handlers.
- [x] Add start conflict gate with no-write-on-failure behavior.
- [x] Add configurable serialized resource defaults and legacy compatibility.
- [x] Add explicit integration-claim/release lane ownership.
- [x] Update runtime spec/reference docs.
- [ ] Commit and merge to main before the template rollout child starts.

## Verification evidence

- `npx vitest run` (packages/cli): **25 failed files / 38 failed tests / 1508
  passed**, identical to the stashed baseline (**25 / 38 / 1503**). Zero new
  failures; the +5 passing are the new coordination tests plus one.
- `npx vitest run test/regression.test.ts`: 7 failures, identical to baseline.
- `npx vitest run test/regression.test.ts -t "byte-identical"`: 32 passed
  (dogfood ↔ template parity, including `common/coordination.py`).
- `npx eslint src/templates/trellis/index.ts test/scripts/...`: clean.
- `npx tsc --noEmit` after `pnpm build:core`: clean.
- Direct CLI smoke over a temp repo covering all acceptance criteria:
  normalization, `..`/absolute/`.` rejection, directory-glob overlap, planning
  does not block, serialization group, default serialized spec path, missing and
  cyclic blockers, integration lane mutual exclusion, stale-lock takeover,
  real concurrent claim (exactly one winner), dirty-worktree preflight, and
  legacy task without coordination staying fail-closed rather than
  "owns everything".

## Defects found and fixed during implementation

1. `_check_start_coordination` was called but never defined (caught by smoke).
2. `normalize_claim(".")` returned an empty string and bypassed the
   too-broad guard — an empty claim instead of a rejection.
3. Default `integration_lane=main` made every `in_progress` task look like an
   active integrator, which would have deadlocked all integration. Replaced
   with explicit `integration_active` claimed by `integration-claim`.
4. A crash left the lock file behind forever, making the lane permanently
   unclaimable. Added stale takeover with a warning.
5. `common/coordination.py` was not registered in
   `packages/cli/src/templates/trellis/index.ts`, so `trellis init` would not
   install it and every `task.py` command would fail with ImportError
   (137 test failures). The template script manifest is the real install path.
6. Coordination enforcement initially made `start` hard-fail on a corrupt
   `task.json`, breaking the documented tolerance contract. Now it warns that
   coordination was not checked and still activates the pointer.

## Known gaps

- Preflight checks branch/worktree/dirty state and out-of-scope paths, but does
  not yet compare against a moving base branch beyond `git diff base...HEAD`.
- `shared_paths` participates in conflict detection but has no separate
  reporting channel; conflicts report kind `path`.
