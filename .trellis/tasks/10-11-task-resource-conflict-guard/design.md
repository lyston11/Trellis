# Runtime resource coordination design

- Store coordination in an optional task.json object; normalize missing legacy fields to empty claims, `integration_lane=main`, and `integration_active=false`.
- Use dedicated commands (`claim-paths`, `set-resource`, `add-blocker`, `remove-blocker`, `integration-claim`, `integration-release`, `preflight`) so paths, blockers and lane ownership receive validation rather than opaque `meta` strings.
- Normalize repo-relative POSIX paths; reject absolute, `..`, NUL and unknown/ambiguous patterns. Exact files, directory prefixes and `/**` are supported.
- Compare claims conservatively. Exact/prefix and recursive patterns are direct; uncertain wildcard overlap is a conflict.
- `start` checks blockers, in-progress task claims and serialization groups before writing any status or session pointer. Planning tasks do not claim resources by default. The integration lane is not claimed by ordinary development; it is claimed explicitly by `integration-claim`.
- Built-in serialized path patterns are read from `.trellis/config.yaml`; no FamilyGraph-specific assumptions are embedded in the runtime.
- `integration-claim` atomically marks a task as the active occupant of its integration lane after checking for another `integration_active` task. `integration-release` clears that claim. `preflight` is read-only and checks active lane occupants, status/branch/worktree/base branch/changed paths and resource conflicts without claiming or releasing anything.
- No schema/database migration; old task files remain readable.
