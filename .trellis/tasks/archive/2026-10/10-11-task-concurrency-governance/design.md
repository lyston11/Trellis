# Runtime task coordination design

## 1. Data model

Keep the stable task.json top-level shape and add a `coordination` object so old readers ignore it safely:

```json
{
  "coordination": {
    "owned_paths": ["backend/app/services/memory_rag.py"],
    "shared_paths": ["backend/app/services/memory_rag.py"],
    "serialization_group": "rag-retrieval-core",
    "blocked_by": ["10-11-unified-authorized-retrieval-entry"],
    "integration_lane": "main"
  }
}
```

The object is normalized on read to defaults: lists become `[]`, group/lane become `None`/`main`, and malformed values are validation errors when the task is started. No legacy task is treated as owning `**/*`.

The CLI gets explicit coordination commands rather than requiring JSON syntax in `--meta`:

```text
task.py claim-paths <task> <path>... [--shared <path>...]
task.py set-resource <task> --group <name> --lane <name>
task.py add-blocker <task> <blocking-task>
task.py remove-blocker <task> <blocking-task>
task.py preflight <task> [--target <branch>]
```

`set-meta` remains a compatibility escape hatch for unrelated metadata and cannot write `coordination` as an unvalidated string.

## 2. Resource model

### Path claims

Normalize declarations as POSIX repo-relative paths:

- reject absolute paths, `..`, empty segments, NUL, and paths outside repo root;
- normalize `\` to `/` only on input, then persist `/`;
- allow exact files, directory prefixes (`backend/app/`), and glob patterns (`backend/migrations/versions/**`, `*.md`);
- reject a negated glob or a pattern that cannot be classified.

Use a conservative overlap predicate instead of attempting perfect glob satisfiability. Exact/prefix relationships overlap directly; recursive directory patterns overlap when one is an ancestor; wildcard patterns overlap when their literal prefixes or static segments can match the same path. If the predicate is uncertain, return overlap and explain that the declaration must be narrowed.

### Built-in serialized resources

`.trellis/config.yaml` gets an explicit default list, so projects can extend it without changing Python:

```yaml
coordination:
  default_serialized_paths:
    - ".trellis/spec/**"
    - "backend/migrations/versions/**"
    - "migrations/**"
  default_serialization_groups:
    - "trellis-integration-main"
```

The template default is language-neutral; a project may add `backend/**`, `frontend/**`, or a database name when those are genuinely shared. The runtime never guesses FamilyGraph-specific paths in the global template.

Built-in serialized paths are compared against claims only when at least one task claims the path or the task declares a matching resource group. This avoids blocking every unrelated task merely because the repository contains a migrations directory.

### State semantics

- `planning`: no execution claim; may be inspected and planned.
- `in_progress`: claims `owned_paths`, group and integration lane.
- `completed`/archived: releases all claims.
- `blocked`: optional future status; does not release an active task until it is explicitly finished or archived.

A task can use `--reserve` at start only if the user intentionally wants planning to hold a resource; the default remains no reservation.

## 3. Start gate

`task.py start` sequence:

1. Load/validate the task and coordination object.
2. Validate `blocked_by` using active and archived task records; reject cycles and unresolved blockers.
3. Enumerate other `in_progress` tasks in the same repo. Ignore planning tasks unless the target task uses `--reserve`.
4. Compare path claims, serialization groups, and integration lanes.
5. Report a deterministic conflict sorted by task directory then resource kind/path.
6. Only after all gates pass, write session pointer and flip planning → in_progress.

No write occurs before all gates pass, so a rejected start cannot leave status/pointer drift.

The `--force` flag is deliberately absent from the start command. Bypassing a concurrency guard without a durable approval record would make the guard advisory.

## 4. Preflight gate

`task.py preflight` is read-only and is the only supported input to the serial integration lane. It verifies:

- task status is in_progress and branch/worktree metadata point to existing paths;
- worktree is clean except allowed local runtime outputs;
- branch is based on the recorded base branch and its changed paths are a subset of `owned_paths` plus task artifacts;
- base branch changes since task start do not overlap task-owned paths without a fresh merge/review;
- no active task owns an overlapping path/group/lane;
- exactly one migration head exists if migration paths changed;
- task artifact records validation results and commit hash only after preflight succeeds.

This command never merges, commits, pushes, archives, or deletes. The human/integration agent performs those actions after the report is green.

## 5. Parent/child and dependencies

Parent/child links remain organizational. `blocked_by` stores explicit task directory names and is checked transitively. `add-blocker` rejects self-reference, archived/nonexistent names, and cycles before writing. Archive refuses an active task with incomplete dependents unless an explicit `--allow-incomplete-children` is supplied to a future review-only command; the default is fail closed.

## 6. Template synchronization

The runtime child changes the dogfood script tree first. The rollout child copies the exact Python files to the template tree and updates the shared template `workflow.md`, references, and tests. Existing byte-parity regression remains the enforcement point. The CLI build copies `src/templates/**` into `dist/templates/**`; no generated dist files are committed by hand.

## 7. Compatibility and migration

No database migration is required. Existing task.json files remain valid because `coordination` is optional. `task.py validate` reports a warning for missing coordination only when a task is being started with a requested blocker/resource operation; list/current/archive stay backward compatible.

A future `trellis update` installs the new scripts and workflow block into existing projects through normal managed-template conflict handling. Local project customizations outside managed blocks remain untouched.

## 8. Failure and rollback

Resource check failures are read-only and leave task status/pointers unchanged. If a release exposes a false positive, narrow the task declaration or remove the configured default serialized path; do not add a bypass. Runtime rollback is reverting the template/runtime commit; old tasks without coordination continue to list/archive, while new starts use the previous guard behavior only after the code rollback.
