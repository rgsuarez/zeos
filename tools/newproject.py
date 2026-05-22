#!/usr/bin/env python3
"""
zeos /newproject — register and scaffold a new project (local-first).

Operates LOCALLY only. No GitHub API calls, no auto-push.

Scaffolds four files by default. Project repo gets one (CLAUDE.md), zeos repo
gets the other three:

| Artifact      | Location                                              | Purpose                          |
|---------------|-------------------------------------------------------|----------------------------------|
| CLAUDE.md     | <local_path>/CLAUDE.md  (in the project repo)         | Operations doctrine (HOW)        |
| SOUL.md       | ~/projects/zeos/souls/<app_id>/SOUL.md                | Project identity (WHO)           |
| MEMORY.md     | ~/projects/zeos/memory/<app_id>/MEMORY.md             | Curated mid-term memory          |
| journals/     | ~/projects/zeos/journals/<app_id>/                    | Append-only session journals     |

CLAUDE.md is the only file written into the project repo — it's what teammates
see if you ever commit it. Default content covers mission/stack/conventions
plus a documentation block describing the zeos integration. Edit freely after
scaffold; zeos won't overwrite it.

SOUL.md, MEMORY.md, and journals/ live entirely in the zeos repo (all three
directories are gitignored in zeos by default). Project repos stay 100% clean.

Usage:
    python tools/newproject.py <app_id> [options]

Options:
    --name=<name>         Human-readable project name (default: titlecased app_id)
    --repo=<url>          Remote URL for the project repo (informational only)
    --type=<type>         internal | venture | research | infrastructure | utility
                          (default: internal)
    --local-path=<path>   Absolute or ~-relative path where the project lives.
                          Default: ~/projects/<app_id>/
    --no-scaffold         Skip all scaffold writes (registry only).
    --no-commit           Skip the local git commit (just edit REGISTRY.json).
    --yes / -y            Skip the confirmation prompt
    --version             Print version and exit

Examples:
    python tools/newproject.py my-app --type=internal --repo=https://github.com/your-org/my-app
    python tools/newproject.py side-tool --type=utility --no-commit
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

VERSION = "1.3.0"

VALID_TYPES = {"internal", "venture", "research", "infrastructure", "utility"}
APP_ID_PATTERN = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")

# Resolve zeos repo root from this script's location (tools/newproject.py).
ZEOS_ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = ZEOS_ROOT / "apps" / "REGISTRY.json"
SOULS_ROOT = ZEOS_ROOT / "souls"
JOURNALS_ROOT = ZEOS_ROOT / "journals"
MEMORY_ROOT = ZEOS_ROOT / "memory"


def fail(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def info(msg: str) -> None:
    print(msg)


def validate_app_id(app_id: str) -> None:
    if not APP_ID_PATTERN.match(app_id):
        fail(
            f"invalid app_id {app_id!r}: must be lowercase kebab-case "
            f"(letters, digits, hyphens; must start with a letter)"
        )


def load_registry() -> dict:
    if not REGISTRY_PATH.exists():
        fail(f"registry not found at {REGISTRY_PATH}")
    try:
        return json.loads(REGISTRY_PATH.read_text())
    except json.JSONDecodeError as e:
        fail(f"registry JSON parse error: {e}")


def save_registry(registry: dict) -> None:
    text = json.dumps(registry, indent=2) + "\n"
    REGISTRY_PATH.write_text(text)


def find_existing(registry: dict, app_id: str) -> Optional[dict]:
    for entry in registry.get("apps", []):
        if entry.get("app_id") == app_id:
            return entry
    return None


def resolve_local_path(raw: Optional[str], app_id: str) -> Path:
    if raw:
        return Path(os.path.expanduser(raw)).resolve()
    return (Path.home() / "projects" / app_id).resolve()


def local_path_relative(local_path: Path) -> str:
    """Return the local_path string for the registry: ~/projects/<id>/ becomes
    '<id>/' (relative to ~/projects/); anything else is stored absolutely."""
    home = Path.home()
    try:
        return f"{local_path.relative_to(home / 'projects').as_posix()}/"
    except ValueError:
        return str(local_path)


def build_entry(
    app_id: str,
    name: str,
    project_type: str,
    repo_url: Optional[str],
    local_path: Path,
) -> dict:
    return {
        "app_id": app_id,
        "name": name,
        "type": project_type,
        "status": "active",
        "repo": {
            "url": repo_url or "",
            "branch": "main",
        },
        "local_path": local_path_relative(local_path),
        "capabilities": [],
        "modules": [],
    }


CLAUDE_MD_TEMPLATE = """# Project: {name}

## Mission
<one paragraph — what this project does, who it's for>

## Stack
<key technologies, build / test / lint commands>

## Conventions
<branch naming, commit format, code style, project-specific rules>

## Key Files
<critical files an agent should know about (add `@path` references to auto-load)>

---

<!-- zeos integration — managed by the /newproject tool. Edit this section freely. -->

## zeos context

This project is registered with zeos. The operator's session-level context lives in the zeos repo (NOT in this project repo):

- Project SOUL (identity, mission, constraints): `~/projects/zeos/souls/{app_id}/SOUL.md`
- Curated memory (cross-session): `~/projects/zeos/memory/{app_id}/MEMORY.md`
- Session journals (append-only): `~/projects/zeos/journals/{app_id}/`

Operators with zeos installed boot this project with:

```
/project {app_id}
```

That loads the SOUL, latest journals, and MEMORY.md alongside this file. Teammates without zeos see only this CLAUDE.md and can ignore the references above.

---

*Registered with zeos {timestamp}. Type: {project_type}.*
"""

SOUL_MD_TEMPLATE = """---
project: {app_id}
name: "{name}"
type: {project_type}
classification: "PROJECT_SOUL"
created: "{timestamp}"
location: "~/projects/zeos/souls/{app_id}/SOUL.md"
---

# Soul: {name}

> *North star — one line describing the project's reason for existing.*

## Mission

<2–3 sentences: what this project does, who it's for, why it exists. Identity-level, not operations.>

## Constraints

Hard constraints the project must respect. These rarely change.

- <constraint 1 — e.g., "must work offline">
- <constraint 2 — e.g., "no PII in logs">

## Identity

Who the agent IS when working on this project. Voice, tone, expertise, what it should never do.

- <identity note 1>
- <identity note 2>

## Values

Core principles that govern decisions when the explicit doctrine is silent.

- <value 1 — e.g., "Correctness over speed">
- <value 2 — e.g., "Boring tech where possible">

## Cross-references

- Operations doctrine (build, deploy, conventions): `<local_path>/CLAUDE.md`
- Curated memory: `~/projects/zeos/memory/{app_id}/MEMORY.md`
- Session journals: `~/projects/zeos/journals/{app_id}/`

---

*SOUL.md describes WHO the project is — identity, mission, values, constraints. It should change rarely (quarterly at most). For HOW the project operates (build commands, file paths, conventions, anything that changes weekly), see the project's CLAUDE.md.*
"""

JOURNALS_README_TEMPLATE = """# Session Journals — {name}

Append-only session journals for the `{app_id}` project. Written by `/snap`
and `/end` (or programmatically via the inject MCP server's `zeos_snap` /
`zeos_end_session` tools).

## Naming

`YYYY-MM-DD-NNN-agent.md` — e.g., `2026-05-21-001-claude.md`

## Frontmatter

```yaml
---
date: "YYYY-MM-DD"
sequence: 1
agent: claude
status: active
created: "YYYY-MM-DDTHH:MM:SSZ"
---
```

## Discipline

Append-only. Never rewrite past entries. Write so a future agent can pick up
cold with no other context.

## Why these live in the zeos repo

Session journals are operator-side artifacts — debug attempts, decisions in
flight, working context. Keeping them in the project repo would either leak
personal context into teammates' clones, require per-machine `.git/info/exclude`
config, or risk accidental commits. Pinning them to `~/projects/zeos/journals/`
(gitignored) keeps the project repo clean regardless of who clones it.
"""

MEMORY_MD_TEMPLATE = """---
project: {app_id}
token_estimate: 0
entry_count: 0
last_updated: "{timestamp}"
---

# {name} — MEMORY

Curated mid-term memory for the `{app_id}` project. Add entries as work
progresses. Each entry should answer: "what would a future agent need to know
that they can't derive from code, git history, CLAUDE.md, or SOUL.md?"

Entries carry `[decay:N]` tags — drop entries when N hits 0 unless renewed.
Default token budget: 10,000. Curate via `/memory-curate` when over.

## Entries

<!-- Newest at top. Format:
## YYYY-MM-DD [decay:N] — short title
Body...
-->
"""


def scaffold_zeos_side(app_id: str, name: str, project_type: str, local_path: Path) -> list[str]:
    """Create the zeos-side scaffolding:
    - ~/projects/zeos/souls/<app_id>/SOUL.md       (project identity)
    - ~/projects/zeos/journals/<app_id>/README.md  (journal dir + naming convention)
    - ~/projects/zeos/memory/<app_id>/MEMORY.md    (curated memory)

    Returns list of files created (skips existing files; never overwrites).
    """
    created: list[str] = []
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    souls_dir = SOULS_ROOT / app_id
    souls_dir.mkdir(parents=True, exist_ok=True)
    soul_md = souls_dir / "SOUL.md"
    if not soul_md.exists():
        soul_md.write_text(
            SOUL_MD_TEMPLATE.format(
                app_id=app_id,
                name=name,
                project_type=project_type,
                timestamp=timestamp,
                local_path=str(local_path),
            )
        )
        created.append(str(soul_md))

    journals_dir = JOURNALS_ROOT / app_id
    journals_dir.mkdir(parents=True, exist_ok=True)
    journals_readme = journals_dir / "README.md"
    if not journals_readme.exists():
        journals_readme.write_text(
            JOURNALS_README_TEMPLATE.format(app_id=app_id, name=name)
        )
        created.append(str(journals_readme))

    memory_dir = MEMORY_ROOT / app_id
    memory_dir.mkdir(parents=True, exist_ok=True)
    memory_md = memory_dir / "MEMORY.md"
    if not memory_md.exists():
        memory_md.write_text(
            MEMORY_MD_TEMPLATE.format(
                app_id=app_id,
                name=name,
                timestamp=timestamp,
            )
        )
        created.append(str(memory_md))

    return created


def scaffold_project_claude_md(local_path: Path, app_id: str, name: str, project_type: str) -> list[str]:
    """Write <local_path>/CLAUDE.md (the project's operations doctrine) into
    the project repo. Always called (CLAUDE.md is mandatory). Never overwrites
    an existing CLAUDE.md — operator's edits are preserved.
    """
    created: list[str] = []
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    local_path.mkdir(parents=True, exist_ok=True)
    claude_md = local_path / "CLAUDE.md"
    if not claude_md.exists():
        claude_md.write_text(
            CLAUDE_MD_TEMPLATE.format(
                name=name,
                app_id=app_id,
                timestamp=timestamp,
                project_type=project_type,
            )
        )
        created.append(str(claude_md))
    return created


def git_commit_registry(app_id: str) -> tuple[bool, str]:
    """Commit apps/REGISTRY.json change to the local zeos repo. No push."""
    if not (ZEOS_ROOT / ".git").exists():
        return False, "zeos directory is not a git repo; skipping commit"
    if not shutil.which("git"):
        return False, "git not on PATH; skipping commit"

    try:
        subprocess.run(
            ["git", "-C", str(ZEOS_ROOT), "add", "apps/REGISTRY.json"],
            check=True, capture_output=True, text=True,
        )
        result = subprocess.run(
            ["git", "-C", str(ZEOS_ROOT), "diff", "--cached", "--quiet"],
            capture_output=True,
        )
        if result.returncode == 0:
            return False, "no staged changes in apps/REGISTRY.json (already up to date?)"
        subprocess.run(
            [
                "git", "-C", str(ZEOS_ROOT), "commit",
                "-m", f"chore(registry): register {app_id}",
            ],
            check=True, capture_output=True, text=True,
        )
        rev = subprocess.run(
            ["git", "-C", str(ZEOS_ROOT), "rev-parse", "--short", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        return True, rev
    except subprocess.CalledProcessError as e:
        return False, f"git command failed: {e.stderr.strip() or e}"


def prompt_confirm(prompt: str) -> bool:
    try:
        return input(f"{prompt} [y/N] ").strip().lower() in {"y", "yes"}
    except (EOFError, KeyboardInterrupt):
        print()
        return False


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="newproject.py",
        description=f"zeos new-project registrar and scaffolder (v{VERSION})",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("app_id", help="Unique kebab-case identifier for the project")
    parser.add_argument("--name", help="Human-readable name (default: titlecased app_id)")
    parser.add_argument("--repo", help="Remote URL (informational; no push performed)")
    parser.add_argument(
        "--type", dest="project_type", default="internal",
        choices=sorted(VALID_TYPES),
        help="Project type (default: internal)",
    )
    parser.add_argument(
        "--local-path", dest="local_path",
        help="Local path for the project (default: ~/projects/<app_id>/)",
    )
    parser.add_argument("--no-scaffold", action="store_true",
                        help="Skip all scaffold writes (registry only)")
    parser.add_argument("--no-commit", action="store_true",
                        help="Skip the local git commit")
    parser.add_argument("--yes", "-y", action="store_true",
                        help="Skip the confirmation prompt")
    parser.add_argument("--version", action="version",
                        version=f"newproject.py v{VERSION}")
    args = parser.parse_args()

    app_id = args.app_id.strip().lower()
    validate_app_id(app_id)

    name = args.name or app_id.replace("-", " ").title()
    local_path = resolve_local_path(args.local_path, app_id)

    registry = load_registry()

    if find_existing(registry, app_id):
        fail(f"app_id {app_id!r} already exists in registry")

    entry = build_entry(app_id, name, args.project_type, args.repo, local_path)

    info("")
    info(f"  app_id          : {app_id}")
    info(f"  name            : {name}")
    info(f"  type            : {args.project_type}")
    info(f"  repo            : {args.repo or '(none)'}")
    info(f"  local_path      : {local_path}")
    info(f"  registry        : {REGISTRY_PATH}")
    info(f"  project CLAUDE  : {local_path / 'CLAUDE.md'}  (project repo)")
    info(f"  SOUL.md         : {SOULS_ROOT / app_id / 'SOUL.md'}  (zeos-side, gitignored)")
    info(f"  MEMORY.md       : {MEMORY_ROOT / app_id / 'MEMORY.md'}  (zeos-side, gitignored)")
    info(f"  journals dir    : {JOURNALS_ROOT / app_id}/  (zeos-side, gitignored)")
    info(f"  scaffold        : {'no' if args.no_scaffold else 'yes (all four)'}")
    info(f"  git commit      : {'no' if args.no_commit else 'yes (local only, no push)'}")
    info("")

    if not args.yes and not prompt_confirm("Register and scaffold?"):
        info("aborted")
        sys.exit(2)

    registry.setdefault("apps", []).append(entry)
    registry["last_updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    registry["updated_by"] = f"newproject.py v{VERSION}"
    save_registry(registry)
    info(f"✓ registry updated: {REGISTRY_PATH}")

    if not args.no_scaffold:
        zeos_created = scaffold_zeos_side(app_id, name, args.project_type, local_path)
        if zeos_created:
            info("✓ scaffolded (zeos-side):")
            for path in zeos_created:
                info(f"    {path}")
        else:
            info("  (zeos-side scaffold already exists — left as-is)")

        claude_created = scaffold_project_claude_md(local_path, app_id, name, args.project_type)
        if claude_created:
            info("✓ scaffolded (project repo):")
            for path in claude_created:
                info(f"    {path}")
        else:
            info(f"  (project CLAUDE.md already exists at {local_path / 'CLAUDE.md'} — left as-is)")

    if not args.no_commit:
        ok, detail = git_commit_registry(app_id)
        if ok:
            info(f"✓ committed locally: {detail}")
        else:
            info(f"  (skipped commit: {detail})")

    info("")
    info(f"Project {app_id!r} ready. Boot it with: /project {app_id}")


if __name__ == "__main__":
    main()
