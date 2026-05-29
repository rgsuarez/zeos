#!/usr/bin/env python3
"""
zeos /newproject — register and scaffold a new project (local-first).

Operates LOCALLY only. No GitHub API calls, no auto-push.

Scaffolds five files by default. The project repo gets one (CLAUDE.md); the
operator state root (~/.zeos, env ZEOS_STATE_ROOT) gets the other four:

| Artifact         | Location                                       | Purpose                      |
|------------------|------------------------------------------------|------------------------------|
| CLAUDE.md        | <local_path>/CLAUDE.md  (in the project repo)  | Operations doctrine (HOW)    |
| SOUL.md          | ~/.zeos/souls/<app_id>/SOUL.md                 | Project identity (WHO)       |
| MEMORY.md        | ~/.zeos/memory/<app_id>/MEMORY.md              | Curated mid-term memory      |
| journals/        | ~/.zeos/journals/<app_id>/                     | Append-only session journals |
| MASTER_ROADMAP.md| ~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md    | Development direction        |

CLAUDE.md is the only file written into the project repo — it's what teammates
see if you ever commit it. Default content covers mission/stack/conventions
plus a documentation block describing the zeos integration. Edit freely after
scaffold; zeos won't overwrite it.

SOUL.md, MEMORY.md, journals/, and MASTER_ROADMAP.md live under the operator
state root (~/.zeos), outside any repo, mirroring the ~/.claude and ~/.codex
convention. The registry (~/.zeos/apps/REGISTRY.json) is operator state too.
Project repos stay 100% clean.

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
    --no-commit           Accepted for backward compatibility; no-op (the
                          registry is operator-local and never committed).
    --yes / -y            Skip the confirmation prompt
    --version             Print version and exit

Examples:
    python tools/newproject.py my-app --type=internal --repo=https://github.com/your-org/my-app
    python tools/newproject.py side-tool --type=utility
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

VERSION = "1.4.0"

VALID_TYPES = {"internal", "venture", "research", "infrastructure", "utility"}
APP_ID_PATTERN = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")

# Two roots as of v1.2.0:
#   ZEOS_REPO_ROOT  - the public product (this repo), resolved from the script.
#   ZEOS_STATE_ROOT - operator-mutated state (default ~/.zeos), env-overridable.
# All operator state (registry, profiles, souls, memory, journals, roadmaps)
# lives under the state root so the repo stays a clean public product.
ZEOS_REPO_ROOT = Path(__file__).resolve().parent.parent
ZEOS_STATE_ROOT = Path(os.environ.get("ZEOS_STATE_ROOT", Path.home() / ".zeos"))
REGISTRY_PATH = ZEOS_STATE_ROOT / "apps" / "REGISTRY.json"
SOULS_ROOT = ZEOS_STATE_ROOT / "souls"
JOURNALS_ROOT = ZEOS_STATE_ROOT / "journals"
MEMORY_ROOT = ZEOS_STATE_ROOT / "memory"
ROADMAPS_ROOT = ZEOS_STATE_ROOT / "roadmaps"


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


def _starter_registry() -> dict:
    """Minimal registry used when no state-side registry exists yet.

    Prefers the repo's apps/REGISTRY.example.json template; falls back to a
    hardcoded empty registry so /newproject works on a fresh state root even
    before install.sh has bootstrapped one.
    """
    example = ZEOS_REPO_ROOT / "apps" / "REGISTRY.example.json"
    if example.exists():
        try:
            data = json.loads(example.read_text())
            data["apps"] = []
            return data
        except json.JSONDecodeError:
            pass
    return {"registry_version": "1.0.0", "schema_version": "1.0", "apps": []}


def load_registry() -> dict:
    if not REGISTRY_PATH.exists():
        # Fresh state root: start from the starter template rather than failing.
        return _starter_registry()
    try:
        return json.loads(REGISTRY_PATH.read_text())
    except json.JSONDecodeError as e:
        fail(f"registry JSON parse error: {e}")


def save_registry(registry: dict) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
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

This project is registered with zeos. The operator's session-level context lives under the zeos state root `~/.zeos` (NOT in this project repo):

- Project SOUL (identity, mission, constraints): `~/.zeos/souls/{app_id}/SOUL.md`
- Curated memory (cross-session): `~/.zeos/memory/{app_id}/MEMORY.md`
- Session journals (append-only): `~/.zeos/journals/{app_id}/`
- Master roadmap (development direction): `~/.zeos/roadmaps/{app_id}/MASTER_ROADMAP.md`

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
location: "~/.zeos/souls/{app_id}/SOUL.md"
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
- Curated memory: `~/.zeos/memory/{app_id}/MEMORY.md`
- Session journals: `~/.zeos/journals/{app_id}/`
- Master roadmap: `~/.zeos/roadmaps/{app_id}/MASTER_ROADMAP.md`

---

*SOUL.md describes WHO the project is — identity, mission, values, constraints. It should change rarely (quarterly at most). For HOW the project operates (build commands, file paths, conventions, anything that changes weekly), see the project's CLAUDE.md.*
"""

JOURNALS_README_TEMPLATE = """# Session Journals - {name}

Append-only session journals for the `{app_id}` project. Written by `/snap`
and `/end` (or programmatically via the inject MCP server's `zeos_snap` /
`zeos_end_session` tools).

## Naming

`YYYY-MM-DD-NNN-agent.md` - e.g., `2026-05-21-001-claude.md`

## Frontmatter

```yaml
---
schema_version: "2.0.0"
session_id: "YYYY-MM-DD-NNN"
project: "{app_id}"
date: "YYYY-MM-DD"
sequence: 1
agent: "claude"
instance: "claude"
status: active
created: "YYYY-MM-DDTHH:MM:SSZ"
---
```

## Discipline

Append-only. Never rewrite past entries. Write so a future agent can pick up
cold with no other context.

## Why these live under the zeos state root

Session journals are operator-side artifacts: debug attempts, decisions in
flight, working context. Keeping them in the project repo would either leak
personal context into teammates' clones, require per-machine `.git/info/exclude`
config, or risk accidental commits. Pinning them to `~/.zeos/journals/`
(outside any repo) keeps the project repo clean regardless of who clones it.

## Continuity Packet

Each `/snap` and `/end` should capture:

- Objective
- State of the world
- Decisions and assumptions
- Open threads
- Verified facts and remaining assumptions
- Blockers and dead ends
- Next tactical move
"""

MEMORY_MD_TEMPLATE = """---
document: "MEMORY"
project: {app_id}
purpose: "Rolling synopsis of session work - long-term memory tier"
token_estimate: 0
entry_count: 0
archive_count: 0
last_updated: "{timestamp}"
---

# Project Memory: {name}

## Continuity Digest

### Last 3 Sessions
*No prior sessions*

### Open Threads
*None*

### Decisions/Constraints
*None yet*

### Next Actions
*None specified*

---

<!-- Newest entries below. Format:
## YYYY-MM-DD: short title [decay:N] [importance:1-5] [tags:tag-a,tag-b]

### Summary
...

### Why
...

### How to Apply
...

### Final Bridge
...

### Next Actions
...
-->
"""

MASTER_ROADMAP_TEMPLATE = """---
document: "MASTER_ROADMAP"
project: {app_id}
name: "{name}"
type: {project_type}
status: "draft"
created: "{timestamp}"
last_updated: "{timestamp}"
location: "~/.zeos/roadmaps/{app_id}/MASTER_ROADMAP.md"
active_blueprint: null
---

# Master Roadmap: {name}

> Stable development direction for this project. Mostly static: update it when
> the intended path changes, not every session. For session-by-session work,
> use the journals; for curated mid-term context, use MEMORY.md.

## Document Status

Draft. Revise as the project's direction firms up.

## North Star / Desired End State

<One paragraph: the destination. What is unambiguously true when this project
has succeeded? Write it so any contributor can tell whether a change moves
toward or away from it.>

## Intent

<The WHY behind the project, stated so a contributor can adapt to changed
conditions without re-asking. Not the how; the purpose and the boundaries of
acceptable solutions.>

## Roadmap Phases

1. <Phase 1 - name and one-line outcome>
2. <Phase 2 - name and one-line outcome>
3. <Phase 3 - name and one-line outcome>

## Current Milestone

<The single milestone in flight right now, and the concrete signal that marks
it done.>

## Out of Scope / Not Yet

- <Explicitly excluded, so contributors do not chase it>
- <Deferred until a later phase>

## Decision Log

| Date | Decision | Why |
|------|----------|-----|
| {timestamp} | Roadmap scaffolded | Project registered with zeos |

## Change Discipline

This file is stable guidance, not a session journal. Edit it when the intended
path changes (new phase, scope shift, reversed decision). Record what changed
and why in the Decision Log, and bump `last_updated` in the frontmatter. Routine
session progress belongs in the journals, not here.
"""


def scaffold_zeos_side(app_id: str, name: str, project_type: str, local_path: Path) -> list[str]:
    """Create the state-side scaffolding (under ~/.zeos):
    - ~/.zeos/souls/<app_id>/SOUL.md                  (project identity)
    - ~/.zeos/journals/<app_id>/README.md             (journal dir + convention)
    - ~/.zeos/memory/<app_id>/MEMORY.md               (curated memory)
    - ~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md     (development direction)

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

    created.extend(scaffold_roadmap(app_id, name, project_type))

    return created


def scaffold_roadmap(app_id: str, name: str, project_type: str) -> list[str]:
    """Create ~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md.

    The master roadmap is the project's stable development direction (desired
    end state, North Star, phases). State-side operator artifact. Never
    overwrites an existing roadmap; operator edits are preserved.
    """
    created: list[str] = []
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    roadmap_dir = ROADMAPS_ROOT / app_id
    roadmap_dir.mkdir(parents=True, exist_ok=True)
    roadmap_md = roadmap_dir / "MASTER_ROADMAP.md"
    if not roadmap_md.exists():
        roadmap_md.write_text(
            MASTER_ROADMAP_TEMPLATE.format(
                app_id=app_id,
                name=name,
                project_type=project_type,
                timestamp=timestamp,
            )
        )
        created.append(str(roadmap_md))

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
    """No-op as of v1.2.0.

    The registry now lives at ~/.zeos/apps/REGISTRY.json (operator state,
    outside the repo), so there is nothing in the repo tree to commit. The
    --no-commit flag is still accepted for backward compatibility but no git
    operation is ever performed. Returns (False, reason) so the caller prints
    an informational line.
    """
    return False, "registry is operator-local (~/.zeos/apps/REGISTRY.json); not committed in v1.2.0+"


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
    info(f"  registry        : {REGISTRY_PATH}  (state-side)")
    info(f"  project CLAUDE  : {local_path / 'CLAUDE.md'}  (project repo)")
    info(f"  SOUL.md         : {SOULS_ROOT / app_id / 'SOUL.md'}  (state-side, ~/.zeos)")
    info(f"  MEMORY.md       : {MEMORY_ROOT / app_id / 'MEMORY.md'}  (state-side, ~/.zeos)")
    info(f"  journals dir    : {JOURNALS_ROOT / app_id}/  (state-side, ~/.zeos)")
    info(f"  MASTER_ROADMAP  : {ROADMAPS_ROOT / app_id / 'MASTER_ROADMAP.md'}  (state-side, ~/.zeos)")
    info(f"  scaffold        : {'no' if args.no_scaffold else 'yes (all five)'}")
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
            info("✓ scaffolded (state-side, ~/.zeos):")
            for path in zeos_created:
                info(f"    {path}")
        else:
            info("  (state-side scaffold already exists, left as-is)")

        claude_created = scaffold_project_claude_md(local_path, app_id, name, args.project_type)
        if claude_created:
            info("✓ scaffolded (project repo):")
            for path in claude_created:
                info(f"    {path}")
        else:
            info(f"  (project CLAUDE.md already exists at {local_path / 'CLAUDE.md'} — left as-is)")

    # v1.2.0: the registry is operator-local (~/.zeos), never committed to the
    # repo. The --no-commit flag is still accepted for backward compatibility.
    _, detail = git_commit_registry(app_id)
    info(f"  ({detail})")

    info("")
    info(f"Project {app_id!r} ready. Boot it with: /project {app_id}")


if __name__ == "__main__":
    main()
