# Global template rollout design

- Runtime source of truth is `.trellis/scripts/**` in the Trellis repo; `packages/cli/src/templates/trellis/scripts/**` must be byte-identical and is enforced by existing regression tests.
- Workflow guidance is managed through the template `workflow.md` and bundled Trellis references, not by editing generated FamilyGraph files.
- Template update uses existing managed-file hashes and conflict behavior; modified user files remain untouched and are reported as conflicts.
- The rollout verifies a temporary fixture project with `trellis init`/`trellis update --dry-run`, then runs parity, CLI lint/typecheck/tests/build.
- The existing dirty Pi extension is an explicit excluded path and must be snapshot-compared before/after.
