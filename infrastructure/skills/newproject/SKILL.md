---
name: newproject
description: Register a new project with zeos and scaffold five files: SOUL.md, MEMORY.md, journals/, MASTER_ROADMAP.md under the state root (~/.zeos), plus CLAUDE.md in the project repo. Local-first; never pushes to a remote registry.
argument-hint: <app_id> [--name=<name>] [--repo=<url>] [--type=<type>] [--local-path=<path>] [--no-scaffold] [--no-commit] [--yes]
allowed-tools: Bash
---

# /newproject

Register a new project in `~/.zeos/apps/REGISTRY.json` and scaffold its five canonical files. Operates only on local files: no GitHub API calls, no auto-push. The registry is operator-local state (`~/.zeos`), never committed to a repo.

## What it does

1. **Validates** `app_id` (kebab-case, not already in the registry).
2. **Appends** a new entry to `~/.zeos/apps/REGISTRY.json` with the project's metadata.
3. **Scaffolds five files** (skips any that already exist; never overwrites):

   | File | Where | Purpose |
   |---|---|---|
   | `SOUL.md` | `~/.zeos/souls/<app_id>/SOUL.md` | Project identity (WHO): mission, constraints, values. Rarely changes. |
   | `MEMORY.md` | `~/.zeos/memory/<app_id>/MEMORY.md` | Curated mid-term memory (cross-session). Token-budgeted, decay-tagged. |
   | `journals/README.md` | `~/.zeos/journals/<app_id>/README.md` | Journal directory + naming convention. Journals append here from `/snap` and `/end`. |
   | `MASTER_ROADMAP.md` | `~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md` | Development direction: desired end state, North Star, phases. Mostly static. |
   | `CLAUDE.md` | `<local_path>/CLAUDE.md` | Operations doctrine (HOW): build commands, conventions, key files. Lives in the project repo; team-visible if committed. |

4. The registry is operator-local and never committed. `--no-commit` is accepted for backward compatibility but is a no-op.
5. Reports the result. The project is now bootable with `/project <app_id>`.

## Architecture: why these files

- `SOUL.md` answers **WHO** the project is. Identity-level, rarely changes (quarterly at most).
- `CLAUDE.md` answers **HOW** the project operates. Build commands, conventions, file paths. Changes weekly.
- `MEMORY.md` is curated cross-session memory the operator maintains.
- Journals are append-only logs from `/snap` and `/end`.

Four of the five (SOUL, MEMORY, journals, MASTER_ROADMAP) live under the state root `~/.zeos` (outside any repo, env `ZEOS_STATE_ROOT`), so they never leave the operator's machine and never contaminate the product repo. `CLAUDE.md` is the only file in the project repo; it's what teammates see if you commit it. The default `CLAUDE.md` template documents this layout so any agent (or human) entering the project understands where state lives.

The operator is free to edit `CLAUDE.md` after scaffold — add references to project docs, customize sections, remove the zeos integration block if not needed. Zeos never overwrites it on subsequent runs.

## Invocation

Forward the user's argument string verbatim to `tools/newproject.py`. Use `--yes` only if the user explicitly opted to skip confirmation; otherwise let the tool prompt.

```bash
python3 ~/projects/zeos/tools/newproject.py $ARGUMENTS
```

If the user omitted `--yes`, the tool will print a summary and wait for `y/N`. Surface that summary to the user verbatim and ask for confirmation before passing input back.

## Examples

```
/newproject my-app --name="My App" --type=internal --repo=https://github.com/your-org/my-app
/newproject side-tool --type=utility --no-commit
/newproject demo --local-path=~/work/demos    # custom local path
/newproject experiment --no-scaffold          # registry only, no files written
```

## Argument reference

| Flag | Default | Notes |
|---|---|---|
| `app_id` (positional, required) | — | Kebab-case, must not already exist in the registry |
| `--name` | titlecased app_id | Human-readable name |
| `--repo` | empty | Remote URL — informational only, no fetch / no clone / no push |
| `--type` | `internal` | One of: internal, venture, research, infrastructure, utility |
| `--local-path` | `~/projects/<app_id>/` | Where the project lives locally |
| `--no-scaffold` | off | Skip all scaffold writes (registry-only mode) |
| `--no-commit` | off | Accepted for backward compatibility; no-op (the registry is operator-local and never committed) |
| `--yes` / `-y` | off | Skip the confirmation prompt |

## Where state lives after `/newproject`

| Artifact | Path | Location |
|---|---|---|
| Registry entry | `~/.zeos/apps/REGISTRY.json` | state root (operator-local, not committed) |
| `SOUL.md` | `~/.zeos/souls/<app_id>/SOUL.md` | state root |
| `MEMORY.md` | `~/.zeos/memory/<app_id>/MEMORY.md` | state root |
| Journals | `~/.zeos/journals/<app_id>/` | state root |
| `MASTER_ROADMAP.md` | `~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md` | state root |
| `CLAUDE.md` | `<local_path>/CLAUDE.md` | Project repo (untracked by default; operator decides whether to commit) |

## What it does NOT do

- Does not push to any remote (`git push` is your call, separately).
- Does not create a GitHub repo for the project.
- Does not `git clone` the project repo.
- Does not commit anything: the registry is operator-local state under `~/.zeos`, never committed to a repo.
- Does not overwrite any existing file. Re-running `/newproject` on the same `app_id` errors out cleanly.

## Source

- Tool: `~/projects/zeos/tools/newproject.py`
- Registry: `~/.zeos/apps/REGISTRY.json`
