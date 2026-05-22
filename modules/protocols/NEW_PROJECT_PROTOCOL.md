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

**App session journals ALWAYS write to the APP REPO, not zeos Core.**

This is a fundamental architectural rule. When operating in an app context, the agent must route all persistence to the app's repository.

| Session Type | Journal Location | Example |
|--------------|------------------|---------|
| Core zeos (`/zeos`) | `zeos/profiles/{profile}/session-journals/{agent}/` | `zeos/profiles/operator/session-journals/claude/2025-12-30-001.md` |
| App session | `{app-repo}/session-journals/` | `zeos-agent/session-journals/2025-12-30-001.md` |

### How the Agent Knows Where to Write

1. **On app boot**: Read the app's SOUL file
2. **Extract `session_journals` field**: This is the authoritative destination
3. **All `/snap` and `/end` writes**: Go to that location
4. **NEVER**: Write app session journals to zeos Core profile

### SOUL File Must Include

Every app SOUL file MUST contain:

```yaml
session_journals: "{app-repo}/session-journals/"
```

And the prose section MUST include:

```markdown
## Session Management

**Journal Location:** `{repository}/session-journals/`

All session journals for this application are stored in the app repository, NOT in zeos Core.
When you execute `/snap` or `/end` during a {app_name} session, write to:
`{repository}/session-journals/YYYY-MM-DD-NNN.md`
```

### Violation Prevention

If an agent writes an app session journal to zeos Core:
1. This is a **PROTOCOL VIOLATION**
2. The misplaced journal must be moved to the correct app repo
3. Root cause: SOUL file missing `session_journals` field

---

## Execution Flow

### Step 1: Validate

```
1. Check app_id is unique (not in apps/REGISTRY.json)
2. Check app_id format (lowercase, hyphens, no spaces, no underscores)
3. If --repo provided:
   a. Verify repo exists and is accessible
   b. Use existing repo
4. If --repo NOT provided:
   a. Check if repo "rgsuarez/{app_id}" already exists
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
Repository: github.com/rgsuarez/{app_id} (will create, PRIVATE)

Proceed? [Y/n]
```

Or with `--public`:
```
Creating new venture: {app_id}
Repository: github.com/rgsuarez/{app_id} (will create, PUBLIC)

⚠️  Public repos are visible to everyone. Confirm? [Y/n]
```

### Step 2: Create zeos-Side Structure

In the `zeos` repo, create:

```
~/projects/zeos-apps/{app_id}/
└── {APP_ID}_SOUL.md       ← App identity (from template below)
```

**SOUL Template:**

```markdown
---
module_id: "{app_id}-app"
module_type: "application"
version: "1.0.0"
created: "{date}"
author: "Claude (system)"
status: "active"
classification: "APPLICATION"
location: "zeos-apps/{app_id}/{APP_ID}_SOUL.md"
parent: "kernel/SOUL.md"
applies_to: "{App Name}"
repository: "rgsuarez/{app_id}"
session_journals: "rgsuarez/{app_id}/session-journals/"
dependencies: ["shell-protocol"]
---

# Application Soul: {App Name}

## Mandatory Boot Sequence

After loading this SOUL file:

| Order | File | Purpose |
|-------|------|---------|
| 1 | `CLAUDE.md` | Operations, infrastructure, build/test commands |
| 2 | `session-journals/` (latest) | Session continuity |
| 3 | `docs/MASTER_ROADMAP.md` | Development direction |

## 1. Identity

{App Name} is [TODO: one-sentence mission].

[TODO: Core thesis — what problem this solves and why it matters]

## 2. Critical Knowledge

> Information that is NUCLEAR ESSENTIAL and cannot be derived from code, git history, or CLAUDE.md.

[TODO: Physical addresses, active customers, credential references, human contacts, legal entities]

## 3. Founding Principles

[TODO: The principles that govern ALL decisions for this application]

1. [Principle 1]
2. [Principle 2]

## 4. Constraints

[TODO: What the AI CANNOT do — permission boundaries, safety limits, operational guardrails]

1. Session writes go to `rgsuarez/{app_id}/session-journals/` — NEVER to zeos Core
2. GitOps discipline: GitHub is single source of truth
3. No secrets in chat, journals, or commits

## 5. zeos Integration

- **Operator:** `profiles/{profile}/`
- **Persistence:** Federated to `rgsuarez/{app_id}`
- **Kernel:** Live from `zeos/kernel/`
- **Journals:** `rgsuarez/{app_id}/session-journals/YYYY-MM-DD-NNN.md`

## Scope Guidance

> **SOUL.md is identity and constraints. CLAUDE.md is operations and infrastructure.**
> If it changes more than once a quarter, it belongs in CLAUDE.md.
> If it defines WHO the agent is rather than HOW it operates, it belongs in SOUL.md.

**OUT-OF-SCOPE for SOUL.md** (put these in CLAUDE.md instead):
- Infrastructure architecture (AWS accounts, CDK stacks, Lambda mappings)
- API pipeline diagrams and data flow charts
- Third-party service configurations (OAuth, analytics, email, SMS)
- Deployment procedures and build/test commands
- Known gotchas and technical workarounds
- Detailed roadmap status (the backlog is the live source of truth)
- Process documentation not actively used
- Lessons learned from specific sessions (these become MEMORY.md entries)

---

*{App Name} Application Soul v1.0.0*
*Part of zeos Application Layer*
*Parent: kernel/SOUL.md*
```

### Step 3: Create App-Repo Structure

In the app's GitHub repo, create (if not present):

```
{app-repo}/
├── docs/
│   ├── MASTER_ROADMAP.md      ← From template
│   └── SYSTEM_ARCHITECTURE.md ← From template  
├── session-journals/
│   └── README.md              ← Explains journal format
└── .zeos/
    └── APP_MANIFEST.json      ← Links back to zeos registry
```

**MASTER_ROADMAP.md Template:**

```markdown
# {App Name} — Master Roadmap

> **Document Status**: Living Document  
> **Last Updated**: {date}
> **Owner**: {Operator Name}

---

## Strategic Vision

[TODO: Define the vision for this venture]

---

## Tier 1: Foundation

**Goal**: [Define foundation goals]

| Item | Status | Notes |
|------|--------|-------|
| [Task 1] | 🔲 | |
| [Task 2] | 🔲 | |

---

## Success Metrics

### Tier 1 Complete When:
- [ ] [Metric 1]
- [ ] [Metric 2]

---

*"Systems over tasks. Build for the long term."*
```

**SYSTEM_ARCHITECTURE.md Template:**

```markdown
# {App Name} — System Architecture

> **Document Status**: Living Document  
> **Last Updated**: {date}
> **Owner**: Technical Operations

---

## Overview

[TODO: Describe the system architecture]

---

## Infrastructure

| Resource | Value |
|----------|-------|
| Repository | {repo_url} |
| AWS Account | {aws_account or 'N/A'} |

---

## Component Details

[TODO: Document components as they are built]

---

*Last verified: {date}*
```

**APP_MANIFEST.json Template:**

```json
{
  "app_id": "{app_id}",
  "zeos_registry": "https://github.com/rgsuarez/zeos/blob/main/apps/REGISTRY.json",
  "soul_location": "zeos-apps:{app_id}/{APP_ID}_SOUL.md",
  "session_journals": "{app-repo}/session-journals/",
  "kernel_version": "live",
  "created": "{date}",
  "visibility": "{private|public}",
  "note": "This app boots with live zeos kernel. No version pinning."
}
```

**session-journals/README.md Template:**

```markdown
# Session Journals

This directory contains session journals for {App Name}.

**IMPORTANT:** All session journals for this app are stored HERE, not in zeos Core.

## Format

Journals follow the zeos session journaling standard:
- Filename: `YYYY-MM-DD-NNN.md` (e.g., `2025-12-30-001.md`)
- Status: CHECKPOINT or COMPLETE
- Required fields: session_id, date, status, agent, next_action_primer

## Usage

- `/snap` — Save progress mid-session (writes HERE)
- `/end` — Generate final journal and commit (writes HERE)

See zeos Shell Protocol for full documentation.
```

### Step 4: Update Registry

Add entry to `apps/REGISTRY.json`:

```json
{
  "app_id": "{app_id}",
  "name": "{App Name}",
  "type": "venture",
  "status": "active",
  "repo": {
    "url": "{repo_url}",
    "branch": "main",
    "visibility": "{private|public}",
    "created_by_zeos": true
  },
  "local_path": "~/projects/zeos-apps/{app_id}/",
  "soul_file": "~/projects/zeos-apps/{app_id}/{APP_ID}_SOUL.md",
  "session_journals": "{repo}/session-journals/",
  "journal_prefix": null,
  "aws_account": "{aws_account_or_null}",
  "aws_region": "us-east-1",
  "capabilities": [
    "github-persistence",
    "session-journaling"
  ],
  "infrastructure": null
}
```

### Step 5: Confirm

Output scaffolding summary:

```
═══════════════════════════════════════════════════════════════════════════════
 ✅ APP SCAFFOLDED: {app_id}
═══════════════════════════════════════════════════════════════════════════════
 
 Repository:     github.com/rgsuarez/{app_id} (CREATED, private)
 
 zeos Registry:  Updated (apps/REGISTRY.json)
 SOUL File:      ~/projects/zeos-apps/{app_id}/{APP_ID}_SOUL.md (created)
 
 App Repo:       {repo_url}
   └── docs/MASTER_ROADMAP.md (created)
   └── docs/SYSTEM_ARCHITECTURE.md (created)
   └── session-journals/README.md (created)
   └── .zeos/APP_MANIFEST.json (created)

 📍 JOURNAL ROUTING: {repo}/session-journals/
    All /snap and /end writes go to the app repo, NOT zeos Core.

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
| `apps/REGISTRY.json` | Updated by this protocol |

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
