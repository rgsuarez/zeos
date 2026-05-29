---
document: "NEW_PROJECT_PROTOCOL"
version: "3.0.0"
classification: "PROTOCOL"
created: "2025-12-24"
updated: "2026-01-09"
author: "Claude (system)"
update_reason: "Renamed from /newproject to /newproject for clarity"
status: "ACTIVE"
location: "modules/protocols/NEW_PROJECT_PROTOCOL.md"
parent: "kernel/BOOT_PROTOCOL.md"
triggers: ["/newproject", "initial-boot Option 2"]
---

# /newproject Command Protocol

## Purpose

The `/newproject` command scaffolds a new project in the zeos scaffolding system.
It creates the required structure in both the zeos repo and the new project's repo,
ensuring the project is immediately bootable with full kernel inheritance.

This protocol is triggered by:
- Direct command: `/newproject <project_id>`
- initial-boot flow: Selecting Option [2] "Start a new project"

---

## Syntax

```
/newproject <project_id> [--repo=<github_url>] [--public] [--aws=<account_id>]
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `project_id` | Yes | — | Unique identifier (lowercase, hyphens allowed) |
| `--repo` | No | Auto-create | Existing GitHub repo URL. If omitted, creates new repo. |
| `--public` | No | false | Make repo public (default is **private**) |
| `--aws` | No | null | AWS account ID if project has dedicated infrastructure |

---

## Session Journal Routing (CRITICAL)

**All session journals write to the state root, never into a project repo.**

As of v1.2.0 operator state lives under `~/.zeos` (env `ZEOS_STATE_ROOT`),
outside any repo. Journals for every project (including zeos itself) are keyed
by `app_id`.

| Session Type | Journal Location | Example |
|--------------|------------------|---------|
| Any project (`/project <id>`) | `~/.zeos/journals/<app_id>/` | `~/.zeos/journals/zeos-dev/2026-05-29-001-claude.md` |

### How the Agent Knows Where to Write

1. **On project boot**: the inject MCP server resolves the journal directory
   from `app_id` via `path-resolver.ts` (`resolveJournalPath`).
2. **All `/snap` and `/end` writes**: go to `~/.zeos/journals/<app_id>/`.
3. **NEVER**: write session journals into a project repo or into the zeos repo.

The SOUL file does NOT carry a journal-routing field; the path is computed from
`app_id`. Pre-v1.2.0 journal-routing fields in the SOUL are ignored.

### Violation Prevention

If an agent writes a session journal into a project repo or the zeos repo:
1. This is a **PROTOCOL VIOLATION**.
2. The misplaced journal must be moved to `~/.zeos/journals/<app_id>/`.
3. Root cause: agent bypassed the resolver and hardcoded a path.

---

## Execution Flow

> **Authoritative implementation (v1.2.0+):** `tools/newproject.py` (the
> `/newproject` skill). It is local-first: it registers the project and
> scaffolds state-side artifacts plus the project `CLAUDE.md`. It does NOT
> create or clone GitHub repositories; `--repo` is informational metadata only.
> The repo-creation steps below describe an earlier aspirational flow and are
> retained for reference; the registry's `repo.url` is operator-provided.

### Step 1: Validate

```
1. Check app_id is unique (not in ~/.zeos/apps/REGISTRY.json)
2. Check app_id format (lowercase, hyphens, no spaces, no underscores)
3. If --repo provided:
   a. Verify repo exists and is accessible
   b. Use existing repo
4. If --repo NOT provided:
   a. Check if repo "<org>/{app_id}" already exists
   b. If exists: use it (with warning)
   c. If not exists: CREATE NEW REPO (Step 1b)
```

### Step 1b: Create GitHub Repository (NEW)

When no `--repo` is provided and repo doesn't exist, create it automatically:

**API Call:**
```bash
curl -X POST \
  -H "Authorization: Bearer {GITHUB_PAT}" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/user/repos \
  -d '{
    "name": "{app_id}",
    "description": "zeos scaffolding system: {app_id}",
    "private": true,
    "auto_init": true,
    "has_issues": true,
    "has_projects": false,
    "has_wiki": false
  }'
```

**Visibility Logic:**
| Flag | Result |
|------|--------|
| (default) | Private repo — `"private": true` |
| `--public` | Public repo — `"private": false` |

**Why Private by Default:**
- Ventures may contain proprietary business logic
- Credentials could accidentally be committed during development
- Operator can make public later via GitHub UI
- Follows principle of least privilege

**Confirmation Prompt:**
```
Creating new venture: {app_id}
Repository: github.com/<org>/{app_id} (will create, PRIVATE)

Proceed? [Y/n]
```

Or with `--public`:
```
Creating new venture: {app_id}
Repository: github.com/<org>/{app_id} (will create, PUBLIC)

⚠️  Public repos are visible to everyone. Confirm? [Y/n]
```

### Step 2: Scaffold the SOUL (state-side)

The project SOUL lives at `~/.zeos/souls/{app_id}/SOUL.md` (state root, outside
any repo). The canonical SOUL template is defined in `tools/newproject.py` as
`SOUL_MD_TEMPLATE`; that is the single source of truth. Do not hand-author a
SOUL or duplicate the template here.

The SOUL carries identity only (mission, constraints, identity, values) and a
`location:` of `~/.zeos/souls/{app_id}/SOUL.md`. It does NOT carry a
journal-routing field; journals are resolved from `app_id` to
`~/.zeos/journals/<app_id>/` (see Session Journal Routing above).

**Scope guidance.** SOUL.md is identity and constraints; `CLAUDE.md` is
operations and infrastructure. If it changes more than once a quarter, or
describes HOW rather than WHO, it belongs in `CLAUDE.md`. Out of scope for
SOUL.md: infrastructure architecture, build/test commands, third-party configs,
deployment procedures, live roadmap status, and per-session lessons (those
become MEMORY.md entries).

### Step 3: Scaffold the project artifacts

As of v1.2.0 the canonical implementation is `tools/newproject.py` (the
`/newproject` skill). It scaffolds five artifacts and never overwrites an
existing file. Do not hand-create these:

| Artifact | Location | Notes |
|----------|----------|-------|
| `SOUL.md` | `~/.zeos/souls/<app_id>/SOUL.md` | Project identity (state) |
| `MEMORY.md` | `~/.zeos/memory/<app_id>/MEMORY.md` | Curated memory (state) |
| `journals/README.md` | `~/.zeos/journals/<app_id>/README.md` | Journals dir (state) |
| `MASTER_ROADMAP.md` | `~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md` | Development direction (state) |
| `CLAUDE.md` | `<local_path>/CLAUDE.md` | Operations doctrine (project repo) |

The `MASTER_ROADMAP.md` template (desired end state, North Star, intent,
phases, current milestone, out-of-scope, decision log, change discipline) is
defined in `tools/newproject.py` as `MASTER_ROADMAP_TEMPLATE`. That is the
single source of truth for the template; do not duplicate it here.

**Deferred to vNext (not scaffolded by `/newproject`):** project-repo
`docs/SYSTEM_ARCHITECTURE.md`, a project-repo journals README, and
project-repo `.zeos/APP_MANIFEST.json`. These were specified by earlier drafts
of this protocol but are not part of the v1.2.0 implementation. They are parked
for a later protocol cleanup; the roadmap above is the artifact v1.2.0 adds.

### Step 4: Update Registry

Add entry to `~/.zeos/apps/REGISTRY.json`:

```json
{
  "app_id": "{app_id}",
  "name": "{App Name}",
  "type": "venture",
  "status": "active",
  "repo": {
    "url": "{repo_url}",
    "branch": "main"
  },
  "local_path": "{app_id}/",
  "capabilities": [],
  "modules": []
}
```

SOUL, MEMORY, journals, and the roadmap are NOT registry fields; they are
resolved from `app_id` under `~/.zeos/`. `local_path` is where the project repo
is checked out (relative to `~/projects/`), where `CLAUDE.md` lives.

### Step 5: Confirm

Output scaffolding summary:

```
═══════════════════════════════════════════════════════════════════════════════
 ✅ APP SCAFFOLDED: {app_id}
═══════════════════════════════════════════════════════════════════════════════
 
 Registry:       Updated (~/.zeos/apps/REGISTRY.json)
 
 State (~/.zeos):
   └── souls/{app_id}/SOUL.md (created)
   └── memory/{app_id}/MEMORY.md (created)
   └── journals/{app_id}/README.md (created)
   └── roadmaps/{app_id}/MASTER_ROADMAP.md (created)
 
 Project repo:   {repo_url}
   └── CLAUDE.md (created)

 📍 JOURNAL ROUTING: ~/.zeos/journals/<app_id>/
    All /snap and /end writes go here, never into a project repo or zeos Core.

 Next Steps:
   1. Edit SOUL file to add vision/purpose
   2. Edit MASTER_ROADMAP.md to define phases
   3. Run: Begin journaled session: {App Name}

═══════════════════════════════════════════════════════════════════════════════
```

---

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `APP_EXISTS` | app_id already in registry | Choose different app_id |
| `INVALID_ID` | app_id contains invalid characters | Use lowercase, hyphens only |
| `REPO_NOT_FOUND` | --repo URL not accessible | Verify URL and permissions |
| `REPO_NOT_EMPTY` | Repo already has conflicting structure | Use --force or choose different repo |
| `REPO_CREATE_FAILED` | GitHub API error creating repo | Check PAT has `repo` scope |
| `COMMIT_FAILED` | GitHub API error | Retry or check PAT permissions |
| `JOURNAL_MISROUTED` | App journal written to zeos Core | Move to app repo, fix SOUL file |

---

## Security Notes

- Never include credentials in scaffolded files
- AWS credentials configured separately in operator preferences
- PAT must have `repo` scope for both zeos and target repo
- Credentials exist only in: operator preferences, environment variables, Secrets Manager
- **Private repos by default** protect against accidental credential exposure

---

## Integration Points

| Document | Reference |
|----------|-----------|
| `kernel/BOOT_PROTOCOL.md` | initial-boot Option [2] triggers this protocol |
| `modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md` | Lists `/newproject` command |
| `~/.zeos/apps/REGISTRY.json` | Updated by this protocol |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-12-24 | Initial protocol |
| 2.0.0 | 2025-12-30 | Add automatic repo creation with private default |
| 2.1.0 | 2025-12-30 | Add session journal routing specification |

---

*/newproject Command Protocol v2.1.0*
*Part of zeos Module Layer*
