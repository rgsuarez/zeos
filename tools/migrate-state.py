#!/usr/bin/env python3
"""
zeos migrate-state - relocate operator state from the repo tree to ~/.zeos.

Operator-mutated state (the project registry, per-operator profiles, and the
per-app souls / memory / journals / roadmaps) historically lived inside the
zeos repo (gitignored). As of v1.2.0 that state lives under a machine-global
state root (default ~/.zeos), mirroring the ~/.claude and ~/.codex convention,
so the repo can be a clean public product.

This tool performs the one-time relocation, verified by SHA-256, idempotent,
local-only. It never pushes, never calls a network service, and never touches
anything outside the known state subtrees.

Layout (relative paths are preserved across the boundary):

    <repo_root>/apps/REGISTRY.json     ->  <state_root>/apps/REGISTRY.json
    <repo_root>/profiles/<operator>/   ->  <state_root>/profiles/<operator>/
    <repo_root>/souls/<app_id>/        ->  <state_root>/souls/<app_id>/
    <repo_root>/memory/<app_id>/       ->  <state_root>/memory/<app_id>/
    <repo_root>/journals/<app_id>/     ->  <state_root>/journals/<app_id>/
    <repo_root>/roadmaps/<app_id>/     ->  <state_root>/roadmaps/<app_id>/

profiles/template/ and profiles/README.md are product, not operator state, and
are never migrated. The project registry is merged (destination-wins on
app_id) rather than blind-copied, so a populated state-side registry is never
clobbered by an empty or stale source.

Usage:
    python3 tools/migrate-state.py [--dry-run | --apply] [--backup]
                                   [--cleanup-repo-state] [--force]
                                   [--registry-source PATH]
                                   [--repo-root PATH] [--state-root PATH]
                                   [--json] [--quiet | --verbose]

Defaults to --dry-run: prints the plan, writes nothing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

VERSION = "1.2.0"

# Per-app collection dirs (each holds <app_id>/ subdirs) plus the operator
# profiles dir. "apps" is handled separately (registry merge), not as a
# generic file copy.
GENERIC_STATE_SUBDIRS = ("souls", "memory", "journals", "roadmaps")
PROFILE_EXCLUDES = {"template", "README.md", "README"}

CHUNK = 65536


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


@dataclass
class MigrationItem:
    rel: str                      # repo-relative path (preserves tree shape)
    src: Path
    dst: Path
    action: str                   # copy | skip-identical | conflict-needs-force
    src_sha: str
    dst_sha: Optional[str] = None


@dataclass
class Report:
    repo_root: str
    state_root: str
    dry_run: bool
    cleanup_repo_state: bool
    copied: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    registry: dict = field(default_factory=dict)
    backup_dir: Optional[str] = None
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "repo_root": self.repo_root,
            "state_root": self.state_root,
            "dry_run": self.dry_run,
            "cleanup_repo_state": self.cleanup_repo_state,
            "summary": {
                "copy": len(self.copied),
                "skip": len(self.skipped),
                "conflict": len(self.conflicts),
                "removed": len(self.removed),
                "errors": len(self.errors),
            },
            "copied": self.copied,
            "skipped": self.skipped,
            "conflicts": self.conflicts,
            "removed": self.removed,
            "registry": self.registry,
            "backup_dir": self.backup_dir,
            "errors": self.errors,
        }


def _default_repo_root() -> Path:
    # tools/migrate-state.py -> repo root is two levels up.
    return Path(__file__).resolve().parent.parent


def _example_registry_path() -> Path:
    # Resolved from the script's own location, independent of --repo-root, so
    # the tool always finds its own template even when migrating another tree.
    return _default_repo_root() / "apps" / "REGISTRY.example.json"


def resolve_roots(args: argparse.Namespace, env: dict) -> tuple[Path, Path]:
    repo_root = Path(
        args.repo_root or env.get("ZEOS_REPO_ROOT") or _default_repo_root()
    ).expanduser().resolve()
    state_root = Path(
        args.state_root or env.get("ZEOS_STATE_ROOT") or (Path.home() / ".zeos")
    ).expanduser().resolve()
    return repo_root, state_root


def _iter_profile_operator_files(profiles_dir: Path):
    """Yield files under profiles/<operator>/, excluding template/ and READMEs."""
    if not profiles_dir.is_dir():
        return
    for entry in sorted(profiles_dir.iterdir()):
        if entry.name in PROFILE_EXCLUDES:
            continue
        if entry.is_dir():
            for f in sorted(entry.rglob("*")):
                if f.is_file():
                    yield f
        # Loose files directly under profiles/ that are not excluded are left
        # alone; operator profiles are always directories.


def _iter_generic_files(repo_root: Path):
    for sub in GENERIC_STATE_SUBDIRS:
        base = repo_root / sub
        if not base.is_dir():
            continue
        for f in sorted(base.rglob("*")):
            if f.is_file():
                yield f


def plan(repo_root: Path, state_root: Path) -> list[MigrationItem]:
    items: list[MigrationItem] = []
    sources = list(_iter_generic_files(repo_root)) + list(
        _iter_profile_operator_files(repo_root / "profiles")
    )
    for src in sources:
        rel = src.relative_to(repo_root).as_posix()
        dst = state_root / rel
        src_sha = sha256(src)
        if not dst.exists():
            items.append(MigrationItem(rel, src, dst, "copy", src_sha))
        else:
            dst_sha = sha256(dst)
            if dst_sha == src_sha:
                items.append(
                    MigrationItem(rel, src, dst, "skip-identical", src_sha, dst_sha)
                )
            else:
                items.append(
                    MigrationItem(
                        rel, src, dst, "conflict-needs-force", src_sha, dst_sha
                    )
                )
    return items


def _atomic_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(dst.parent), prefix=".migrate-", suffix=".tmp")
    os.close(fd)
    try:
        shutil.copy2(src, tmp)
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def merge_registries(
    source_path: Path, target_path: Path, state_root: Path, timestamp: str
) -> dict:
    """Destination-wins merge by app_id. Returns a result dict for the report.

    A populated target is never clobbered: any app in source but not in target
    is appended; on app_id collision the target's entry is kept and the source
    variant is preserved under backups/<ts>/registry-conflicts/<app_id>.json.
    """
    result = {"source": str(source_path), "target": str(target_path),
              "added": [], "kept_on_conflict": [], "final_app_ids": []}

    if not source_path or not source_path.exists():
        if target_path.exists():
            with target_path.open() as fh:
                tgt = json.load(fh)
            result["final_app_ids"] = sorted(a["app_id"] for a in tgt.get("apps", []))
        return result

    with source_path.open() as fh:
        src = json.load(fh)

    if target_path.exists():
        with target_path.open() as fh:
            tgt = json.load(fh)
    else:
        # Seed structure from source but with an empty apps[] to fill by merge.
        tgt = {k: v for k, v in src.items() if k != "apps"}
        tgt["apps"] = []

    by_id = {a["app_id"]: a for a in tgt.get("apps", [])}
    conflicts_dir = state_root / "backups" / timestamp / "registry-conflicts"

    for app in src.get("apps", []):
        aid = app["app_id"]
        if aid not in by_id:
            tgt.setdefault("apps", []).append(app)
            by_id[aid] = app
            result["added"].append(aid)
        elif by_id[aid] != app:
            conflicts_dir.mkdir(parents=True, exist_ok=True)
            (conflicts_dir / f"{aid}.json").write_text(
                json.dumps(app, indent=2) + "\n"
            )
            result["kept_on_conflict"].append(aid)

    # Stable order by app_id for deterministic output.
    tgt["apps"] = sorted(tgt.get("apps", []), key=lambda a: a["app_id"])
    result["final_app_ids"] = [a["app_id"] for a in tgt["apps"]]

    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_text(json.dumps(tgt, indent=2) + "\n")
    return result


def bootstrap_registry(state_root: Path) -> bool:
    """If no state-side registry exists, seed it from the example template."""
    target = state_root / "apps" / "REGISTRY.json"
    if target.exists():
        return False
    example = _example_registry_path()
    if not example.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(example, target)
    return True


def backup(repo_root: Path, state_root: Path, timestamp: str) -> Path:
    """Tree-shape-preserving snapshot of current repo-tree operator state."""
    dest_root = state_root / "backups" / timestamp / "repo-local-state"
    sources = list(_iter_generic_files(repo_root)) + list(
        _iter_profile_operator_files(repo_root / "profiles")
    )
    registry = repo_root / "apps" / "REGISTRY.json"
    if registry.exists():
        sources.append(registry)
    for src in sources:
        rel = src.relative_to(repo_root).as_posix()
        dst = dest_root / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    return dest_root


def apply_plan(
    items: list[MigrationItem],
    *,
    repo_root: Path,
    state_root: Path,
    cleanup_repo: bool,
    force: bool,
    report: Report,
) -> None:
    all_verified = True
    for item in items:
        if item.action == "skip-identical":
            report.skipped.append(item.rel)
            continue
        if item.action == "conflict-needs-force" and not force:
            report.conflicts.append(item.rel)
            all_verified = False
            continue
        # copy or forced overwrite
        try:
            _atomic_copy(item.src, item.dst)
            if sha256(item.dst) != item.src_sha:
                report.errors.append(f"hash mismatch after copy: {item.rel}")
                all_verified = False
            else:
                report.copied.append(item.rel)
        except OSError as exc:
            report.errors.append(f"copy failed {item.rel}: {exc}")
            all_verified = False

    if cleanup_repo:
        if not all_verified:
            report.errors.append(
                "cleanup-repo-state refused: not all files verified"
            )
            return
        # Remove only verified generic + profile-operator sources. Never the
        # tracked registry (that is removed via 'git rm' separately).
        for item in items:
            if item.action in ("copy", "skip-identical") or (
                item.action == "conflict-needs-force" and force
            ):
                try:
                    if item.src.exists():
                        item.src.unlink()
                        report.removed.append(item.rel)
                except OSError as exc:
                    report.errors.append(f"remove failed {item.rel}: {exc}")
        _prune_empty_dirs(repo_root)


def _prune_empty_dirs(repo_root: Path) -> None:
    for sub in GENERIC_STATE_SUBDIRS + ("profiles",):
        base = repo_root / sub
        if not base.is_dir():
            continue
        for d in sorted(base.rglob("*"), reverse=True):
            if d.is_dir() and not any(d.iterdir()) and d.name not in PROFILE_EXCLUDES:
                try:
                    d.rmdir()
                except OSError:
                    pass


def write_state_version(state_root: Path, version: str = VERSION) -> None:
    state_root.mkdir(parents=True, exist_ok=True)
    (state_root / ".zeos-state-version").write_text(version + "\n")


def render_text(report: Report, items: list[MigrationItem]) -> str:
    lines = [
        "== zeos state migration ==",
        f"repo root   : {report.repo_root}",
        f"state root  : {report.state_root}",
        f"mode        : {'dry-run' if report.dry_run else 'apply'}"
        + (" +cleanup" if report.cleanup_repo_state else ""),
    ]
    if report.dry_run:
        for it in items:
            lines.append(f"  {it.action:22} {it.rel}")
        c = sum(1 for i in items if i.action == "copy")
        s = sum(1 for i in items if i.action == "skip-identical")
        x = sum(1 for i in items if i.action == "conflict-needs-force")
        lines.append(f"summary (planned): {c} copy, {s} skip, {x} conflict")
    else:
        lines.append(
            f"summary: {len(report.copied)} copy, {len(report.skipped)} skip, "
            f"{len(report.conflicts)} conflict, {len(report.removed)} removed, "
            f"{len(report.errors)} errors"
        )
    if report.registry:
        reg = report.registry
        lines.append(
            f"registry: {len(reg.get('final_app_ids', []))} apps "
            f"({len(reg.get('added', []))} added, "
            f"{len(reg.get('kept_on_conflict', []))} kept-on-conflict)"
        )
    if report.backup_dir:
        lines.append(f"backup: {report.backup_dir}")
    for e in report.errors:
        lines.append(f"ERROR: {e}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="migrate-state.py",
        description=f"zeos operator-state relocator (v{VERSION})",
    )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true",
                      help="Print the plan, write nothing (default).")
    mode.add_argument("--apply", action="store_true",
                      help="Execute the migration.")
    p.add_argument("--backup", action="store_true",
                   help="Snapshot current repo-tree state to backups/<ts>/ first.")
    p.add_argument("--cleanup-repo-state", action="store_true",
                   help="After verified copy, remove repo-tree state (not the "
                        "tracked registry). Refused unless all files verify.")
    p.add_argument("--force", action="store_true",
                   help="Overwrite destination files whose SHA differs.")
    p.add_argument("--registry-source",
                   help="Path to the canonical registry to ingest (e.g. a "
                        "pre-pull backup). Destination-wins merge by app_id.")
    p.add_argument("--repo-root", help="Override the legacy-state source root.")
    p.add_argument("--state-root", help="Override the state root (default ~/.zeos).")
    p.add_argument("--json", action="store_true", help="Emit a JSON report.")
    verb = p.add_mutually_exclusive_group()
    verb.add_argument("--quiet", action="store_true")
    verb.add_argument("--verbose", action="store_true")
    p.add_argument("--version", action="version", version=f"migrate-state.py v{VERSION}")
    return p


def _utc_stamp() -> str:
    # datetime.now is unavailable in some sandboxes; derive from the filesystem
    # via a temp file's mtime is overkill. Use a monotonic-free stamp from the
    # environment if provided, else a fixed-format from time.
    import time
    return time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    repo_root, state_root = resolve_roots(args, os.environ)

    # Safety: never let state live inside the repo tree (migration loop).
    try:
        state_root.relative_to(repo_root)
        print(
            f"error: state_root ({state_root}) is inside repo_root ({repo_root}); "
            "refusing to create a migration loop",
            file=sys.stderr,
        )
        return 2
    except ValueError:
        pass

    apply_mode = args.apply and not args.dry_run
    report = Report(
        repo_root=str(repo_root),
        state_root=str(state_root),
        dry_run=not apply_mode,
        cleanup_repo_state=bool(args.cleanup_repo_state),
    )
    timestamp = _utc_stamp()

    if args.backup:
        if apply_mode:
            report.backup_dir = str(backup(repo_root, state_root, timestamp))
        else:
            report.backup_dir = f"(dry-run) would back up to {state_root}/backups/{timestamp}/repo-local-state"

    items = plan(repo_root, state_root)

    if apply_mode:
        apply_plan(
            items,
            repo_root=repo_root,
            state_root=state_root,
            cleanup_repo=bool(args.cleanup_repo_state),
            force=bool(args.force),
            report=report,
        )
        # Registry: merge from the explicit source, else from the repo tree.
        reg_source = (
            Path(args.registry_source).expanduser().resolve()
            if args.registry_source
            else (repo_root / "apps" / "REGISTRY.json")
        )
        target = state_root / "apps" / "REGISTRY.json"
        if reg_source.exists() or target.exists():
            report.registry = merge_registries(reg_source, target, state_root, timestamp)
        else:
            if bootstrap_registry(state_root):
                with (state_root / "apps" / "REGISTRY.json").open() as fh:
                    boot = json.load(fh)
                report.registry = {
                    "source": str(_example_registry_path()),
                    "target": str(target),
                    "added": [a["app_id"] for a in boot.get("apps", [])],
                    "kept_on_conflict": [],
                    "final_app_ids": sorted(a["app_id"] for a in boot.get("apps", [])),
                }
        write_state_version(state_root)

    if args.json:
        print(json.dumps(report.to_dict(), indent=2))
    elif not args.quiet:
        print(render_text(report, items))

    # Nonzero on any error OR any unresolved conflict (migration not fully
    # applied; the caller must resolve before proceeding).
    return 1 if (report.errors or report.conflicts) else 0


if __name__ == "__main__":
    raise SystemExit(main())
