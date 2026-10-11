"""Task resource claims, dependency checks, and integration preflight.

The module is intentionally dependency-light: task lifecycle commands import it,
while the template copy is kept byte-identical by the CLI regression suite.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import _load_config
from .git import run_git
from .paths import FILE_TASK_JSON, get_tasks_dir
from .task_utils import find_task_by_name
from .tasks import iter_active_tasks

_WILDCARDS = re.compile(r"[*?[]")
_DEFAULT_SERIALIZED_PATHS = (
    ".trellis/spec/**",
    "backend/migrations/versions/**",
    "migrations/**",
)


@dataclass(frozen=True)
class Coordination:
    owned_paths: tuple[str, ...] = ()
    shared_paths: tuple[str, ...] = ()
    serialization_group: str | None = None
    blocked_by: tuple[str, ...] = ()
    integration_lane: str = "main"
    integration_active: bool = False
    reserve: bool = False


@dataclass(frozen=True)
class Conflict:
    kind: str
    task: str
    other: str
    resource: str
    detail: str


class CoordinationError(ValueError):
    """A task coordination declaration is unsafe or malformed."""


def normalize_claim(value: str) -> str:
    """Normalize one repository-relative path/glob or raise CoordinationError."""
    if not isinstance(value, str):
        raise CoordinationError("path claims must be strings")
    value = value.strip().replace("\\", "/")
    if not value or "\x00" in value:
        raise CoordinationError("path claims must be non-empty and contain no NUL")
    if value.startswith("/") or re.match(r"^[A-Za-z]:/", value):
        raise CoordinationError(f"path claim must be repository-relative: {value}")
    parts = [part for part in value.split("/") if part not in ("", ".")]
    if ".." in parts:
        raise CoordinationError(f"path claim may not contain '..': {value}")
    normalized = "/".join(parts)
    if not normalized:
        raise CoordinationError(f"path claim resolves to nothing: {value}")
    if value.endswith("/"):
        normalized += "/**"
    if normalized in (".", "**"):
        raise CoordinationError(f"path claim is too broad: {value}")
    return normalized


def _claims(value: Any, field: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise CoordinationError(f"coordination.{field} must be a list")
    result = tuple(dict.fromkeys(normalize_claim(item) for item in value))
    return result


def coordination_from_task(data: dict[str, Any]) -> Coordination:
    raw = data.get("coordination")
    if raw is None:
        return Coordination()
    if not isinstance(raw, dict):
        raise CoordinationError("coordination must be an object")
    group = raw.get("serialization_group")
    lane = raw.get("integration_lane", "main")
    if group is not None and (not isinstance(group, str) or not group.strip()):
        raise CoordinationError("coordination.serialization_group must be a non-empty string")
    if not isinstance(lane, str) or not lane.strip():
        raise CoordinationError("coordination.integration_lane must be a non-empty string")
    blockers = raw.get("blocked_by", [])
    if not isinstance(blockers, list) or any(
        not isinstance(item, str) or not item.strip() for item in blockers
    ):
        raise CoordinationError("coordination.blocked_by must be a list of task names")
    return Coordination(
        owned_paths=_claims(raw.get("owned_paths"), "owned_paths"),
        shared_paths=_claims(raw.get("shared_paths"), "shared_paths"),
        serialization_group=group.strip() if group else None,
        blocked_by=tuple(dict.fromkeys(item.strip() for item in blockers)),
        integration_lane=lane.strip(),
        integration_active=bool(raw.get("integration_active", False)),
        reserve=bool(raw.get("reserve", False)),
    )


def coordination_dict(value: Coordination) -> dict[str, Any]:
    return {
        "owned_paths": list(value.owned_paths),
        "shared_paths": list(value.shared_paths),
        "serialization_group": value.serialization_group,
        "blocked_by": list(value.blocked_by),
        "integration_lane": value.integration_lane,
        "integration_active": value.integration_active,
        "reserve": value.reserve,
    }


def _literal_prefix(pattern: str) -> str:
    match = _WILDCARDS.search(pattern)
    prefix = pattern[: match.start()] if match else pattern
    return prefix.rsplit("/", 1)[0] if "/" in prefix else prefix


def _prefix_match(pattern: str, path: str) -> bool:
    if pattern.endswith("/**"):
        prefix = pattern[:-3].rstrip("/")
        return path == prefix or path.startswith(prefix + "/")
    return fnmatch.fnmatchcase(path, pattern)


def claims_overlap(left: str, right: str) -> bool:
    """Conservatively determine whether two repo-relative claims may overlap."""
    left = normalize_claim(left)
    right = normalize_claim(right)
    if left == right:
        return True
    left_wild = bool(_WILDCARDS.search(left))
    right_wild = bool(_WILDCARDS.search(right))
    if not left_wild and not right_wild:
        return left.startswith(right + "/") or right.startswith(left + "/")
    if left_wild and not right_wild:
        return _prefix_match(left, right) or right.startswith(_literal_prefix(left) + "/")
    if right_wild and not left_wild:
        return _prefix_match(right, left) or left.startswith(_literal_prefix(right) + "/")
    if left.endswith("/**") and right.endswith("/**"):
        lp, rp = left[:-3].rstrip("/"), right[:-3].rstrip("/")
        return lp == rp or lp.startswith(rp + "/") or rp.startswith(lp + "/")
    # Two patterns with different first static path segments cannot intersect.
    lp, rp = _literal_prefix(left), _literal_prefix(right)
    if lp and rp and lp.split("/", 1)[0] != rp.split("/", 1)[0]:
        return False
    return True


def configured_serialized_paths(repo_root: Path) -> tuple[str, ...]:
    config = _load_config(repo_root)
    section = config.get("coordination")
    if not isinstance(section, dict):
        return _DEFAULT_SERIALIZED_PATHS
    raw = section.get("default_serialized_paths")
    if raw is None:
        return _DEFAULT_SERIALIZED_PATHS
    if not isinstance(raw, list):
        raise CoordinationError("coordination.default_serialized_paths must be a list")
    return tuple(normalize_claim(item) for item in raw)


def _archived_names(tasks_dir: Path) -> set[str]:
    archive = tasks_dir / "archive"
    if not archive.is_dir():
        return set()
    names: set[str] = set()
    for month in archive.iterdir():
        if not month.is_dir():
            continue
        names.update(child.name for child in month.iterdir() if child.is_dir())
    return names


def dependency_errors(task_name: str, task_data: dict[str, Any], tasks_dir: Path) -> list[str]:
    """Return missing/cyclic blocker errors without mutating any task."""
    active = {task.dir_name: task for task in iter_active_tasks(tasks_dir)}
    archived = _archived_names(tasks_dir)
    graph: dict[str, tuple[str, ...]] = {}
    for name, task in active.items():
        try:
            graph[name] = coordination_from_task(task.raw).blocked_by
        except CoordinationError as exc:
            graph[name] = ()
            if name == task_name:
                return [str(exc)]
    try:
        current = coordination_from_task(task_data).blocked_by
    except CoordinationError as exc:
        return [str(exc)]
    graph[task_name] = current
    errors = [
        f"blocked_by task is missing or not completed: {name}"
        for name in current
        if name not in archived
        and (name not in active or active[name].status not in ("completed", "done"))
    ]
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str) -> None:
        if name in visiting:
            errors.append(f"blocked_by cycle detected at: {name}")
            return
        if name in visited:
            return
        visiting.add(name)
        for parent in graph.get(name, ()):
            if parent in graph:
                visit(parent)
        visiting.remove(name)
        visited.add(name)

    visit(task_name)
    return list(dict.fromkeys(errors))


def _task_coordination(task: Any) -> Coordination | None:
    try:
        return coordination_from_task(task.raw)
    except CoordinationError:
        return None


def conflicts_for_task(
    task_name: str,
    task_data: dict[str, Any],
    tasks_dir: Path,
    repo_root: Path,
    *,
    include_reservations: bool = False,
    integration_only: bool = False,
) -> list[Conflict]:
    """Find active task conflicts in deterministic order."""
    current = coordination_from_task(task_data)
    others = []
    for task in iter_active_tasks(tasks_dir):
        if task.dir_name == task_name:
            continue
        if task.status == "in_progress" or (include_reservations and _task_coordination(task)):
            other = _task_coordination(task)
            if other is not None:
                others.append((task.dir_name, task.status, other))
    result: list[Conflict] = []
    serialized = configured_serialized_paths(repo_root)
    current_claims = current.owned_paths + current.shared_paths
    for other_name, other_status, other in sorted(others):
        if integration_only:
            if current.integration_active and other.integration_active and current.integration_lane == other.integration_lane:
                result.append(Conflict("integration_lane", task_name, other_name, current.integration_lane, "integration lane is occupied"))
            continue
        if current.serialization_group and current.serialization_group == other.serialization_group:
            result.append(Conflict("serialization_group", task_name, other_name, current.serialization_group, "serialization group is occupied"))
        other_claims = other.owned_paths + other.shared_paths
        for left in current_claims:
            for right in other_claims:
                if claims_overlap(left, right):
                    result.append(Conflict("path", task_name, other_name, f"{left} ↔ {right}", "declared paths overlap"))
                for resource in serialized:
                    if claims_overlap(left, resource) and claims_overlap(right, resource):
                        result.append(Conflict("serialized_path", task_name, other_name, resource, "configured serialized path is shared"))
    return sorted(result, key=lambda item: (item.other, item.kind, item.resource))


def format_conflicts(conflicts: list[Conflict]) -> str:
    lines = ["Task start/preflight blocked by coordination conflicts:"]
    for conflict in conflicts:
        lines.append(
            f"- {conflict.kind}: {conflict.task} ↔ {conflict.other}; "
            f"resource={conflict.resource}; {conflict.detail}"
        )
    lines.append("Resolve the claim, dependency, group, or integration lane before retrying.")
    return "\n".join(lines)


def changed_paths(repo_root: Path, base_branch: str, worktree: Path | None = None) -> tuple[str, ...]:
    cwd = worktree if worktree and worktree.is_dir() else repo_root
    rc, out, _ = run_git(["diff", "--name-only", f"{base_branch}...HEAD"], cwd=cwd)
    if rc != 0:
        raise CoordinationError(f"could not inspect changes against base branch {base_branch}")
    return tuple(line.strip().replace("\\", "/") for line in out.splitlines() if line.strip())


#: A coordination lock older than this is treated as abandoned and taken
#: over. Without takeover a crash mid-claim would leave the lane permanently
#: unclaimable, and a guard that can only be cleared by deleting a hidden file
#: is a guard people learn to bypass.
COORDINATION_LOCK_STALE_SECONDS = 120


def acquire_coordination_lock(repo_root: Path):
    """Acquire a process-safe short-lived lock using atomic file creation.

    Returns the lock path. Raises CoordinationError when another live
    operation holds it.
    """
    runtime = repo_root / ".trellis" / ".runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    path = runtime / "coordination.lock"
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        try:
            age = time.time() - path.stat().st_mtime
        except OSError as exc:
            raise CoordinationError("could not inspect the coordination lock") from exc
        if age < COORDINATION_LOCK_STALE_SECONDS:
            raise CoordinationError(
                "another coordination operation is in progress"
            ) from None
        print(
            f"[WARN] taking over a stale coordination lock "
            f"({int(age)}s old): {path}",
            file=sys.stderr,
        )
        try:
            path.unlink()
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except OSError as exc:
            raise CoordinationError(
                "another coordination operation is in progress"
            ) from exc
    os.write(fd, str(os.getpid()).encode("ascii"))
    os.close(fd)
    return path


def release_coordination_lock(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def preflight_errors(task_name: str, task_data: dict[str, Any], tasks_dir: Path, repo_root: Path) -> list[str]:
    errors: list[str] = []
    if task_data.get("status") != "in_progress":
        errors.append("task must be in_progress before integration preflight")
    try:
        coordination = coordination_from_task(task_data)
        errors.extend(dependency_errors(task_name, task_data, tasks_dir))
        conflicts = conflicts_for_task(task_name, task_data, tasks_dir, repo_root, integration_only=True)
        if conflicts:
            errors.append(format_conflicts(conflicts))
        base = task_data.get("base_branch")
        if not isinstance(base, str) or not base:
            errors.append("task has no base_branch")
        else:
            worktree_value = task_data.get("worktree_path")
            worktree = Path(worktree_value) if isinstance(worktree_value, str) and worktree_value else repo_root
            rc, status, _ = run_git(["status", "--porcelain"], cwd=worktree)
            if rc != 0:
                errors.append("could not inspect worktree status")
            elif status.strip():
                errors.append("worktree is dirty; commit or remove changes before integration")
            rc, branch, _ = run_git(["branch", "--show-current"], cwd=worktree)
            expected_branch = task_data.get("branch")
            if rc != 0 or (expected_branch and branch.strip() != expected_branch):
                errors.append(f"worktree branch does not match task branch: expected {expected_branch!r}, got {branch.strip()!r}")
            paths = changed_paths(repo_root, base, worktree)
            allowed = tuple(coordination.owned_paths) + (".trellis/tasks/" + task_name + "/**",)
            for path in paths:
                if not any(_prefix_match(claim, path) for claim in allowed):
                    errors.append(f"changed path is outside owned_paths: {path}")
    except CoordinationError as exc:
        errors.append(str(exc))
    return list(dict.fromkeys(errors))


__all__ = [
    "Coordination",
    "CoordinationError",
    "changed_paths",
    "claims_overlap",
    "conflicts_for_task",
    "coordination_dict",
    "coordination_from_task",
    "dependency_errors",
    "format_conflicts",
    "preflight_errors",
    "normalize_claim",
    "acquire_coordination_lock",
    "release_coordination_lock",
]
