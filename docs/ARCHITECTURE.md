---
document: "ARCHITECTURE"
version: "2.0.0"
updated: "2026-02-02"
---

# zeos Architecture

> **Memory infrastructure for AI.**

zeos is an operating system that runs IN context, not ON hardware. It provides persistent memory, governance, and continuity for AI agents across sessions.

---

## Core Concept

Traditional software runs processes on silicon. zeos runs governance in token streams. When an AI agent boots with zeos, it **becomes** a zeos-governed agent. The kernel (identity, protocols, constraints) is injected into the agent's reasoning.

```
┌─────────────────────────────────────────────────────────────┐
│                    BEFORE zeos                              │
│                                                             │
│  User: "Continue where we left off"                         │
│  Agent: "I don't have memory of previous sessions"          │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                    AFTER zeos                               │
│                                                             │
│  User: /zeos                                                │
│  Agent: [Loads kernel + profile + memory]                   │
│  User: /project example-project                                  │
│  Agent: [Loads SOUL + MEMORY.md + recent journals]          │
│  Agent: "Continuing from Phase 1. Last session: API         │
│          endpoints deployed. Next: Frontend integration."   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Supremacy Hierarchy

zeos enforces a strict precedence hierarchy. Higher layers override lower layers.

```
KERNEL (Layer 0) — Immutable Law
├── SOUL.md — Identity, values, security constraints
├── BOOT_PROTOCOL.md — Boot sequence, gates
└── Cannot be overridden by any layer below

    ▼ SUPERSEDES ▼

MODULES (Layer 1) — Binding Constraints
├── SHELL_PROTOCOL.md — Command vocabulary
├── CONTINUITY_PROTOCOL.md — Persistence modes
└── Can extend but not contradict kernel

    ▼ SUPERSEDES ▼

PROFILE (Layer 2) — Operator Preferences
├── PROFILE.md — Identity, communication style, constraints
└── Customizes within kernel/module bounds

    ▼ SUPERSEDES ▼

SESSION (Layer 3) — Ephemeral Work
├── Current conversation
└── Journals capture for persistence
```

---

## Three-Tier Memory Model

zeos implements a three-tier memory architecture that enables AI agents to "remember" across sessions.

```
┌─────────────────────────────────────────────────────────────┐
│ TIER 1: LONG-TERM MEMORY                                    │
│ File: MEMORY.md (per project)                               │
│ Content: Rolling synopsis of all sessions                   │
│ Updated: On /end (session end)                              │
│ Loaded: Always, on project boot                             │
│ Purpose: "What has happened on this project overall?"       │
├─────────────────────────────────────────────────────────────┤
│ TIER 2: MID-TERM MEMORY                                     │
│ Files: Last 3 session journal summaries                     │
│ Content: Recent session summaries (not full journals)       │
│ Updated: Automatically                                      │
│ Loaded: On project boot                                     │
│ Purpose: "What happened in recent sessions?"                │
├─────────────────────────────────────────────────────────────┤
│ TIER 3: SHORT-TERM MEMORY                                   │
│ File: Current session journal                               │
│ Content: Full detail of current work                        │
│ Updated: On /snap                                     │
│ Loaded: Current session only                                │
│ Purpose: "What am I doing right now?"                       │
└─────────────────────────────────────────────────────────────┘
```

### MEMORY.md Format

Each project has a `MEMORY.md` file that accumulates session summaries:

```markdown
---
document: "MEMORY"
project: "example-project"
purpose: "Rolling synopsis of session work - long-term memory tier"
---

# Project Memory: example-project

## 2026-02-02: zeos refactor, inject MCP consolidated

Consolidated inject MCP into zeos infrastructure. Implemented three-tier
memory system. Profile slimmed down.

---

## 2026-01-24: Phase 1 complete

All 16 services deployed. API operational. Tests passing.

---
```

---

## Boot Flow

### 1. zeos Boot (`/zeos`)

```
User types: /zeos
        │
        ▼
┌─────────────────────────────────────────┐
│ Inject MCP: zeos_boot()                 │
├─────────────────────────────────────────┤
│ 1. Load PROFILE.md                      │
│ 2. Check boot_mode (lean=default)       │
│ 3. Load kernel (SOUL + BOOT_PROTOCOL)   │
│ 4. Load SHELL_PROTOCOL                  │
│ 5. Return compiled payload              │
└─────────────────────────────────────────┘
        │
        ▼
Agent is now zeos-governed (Project mode)
```

### 2. Project Load (`/project <name>`)

```
User types: /project example-project
        │
        ▼
┌─────────────────────────────────────────┐
│ Inject MCP: zeos_load_project()         │
├─────────────────────────────────────────┤
│ 1. Lookup in REGISTRY.json              │
│ 2. Check for parallel instances         │
│ 3. Create journal stub                  │
│ 4. Load SOUL.md                         │
│ 5. Load MEMORY.md (Tier 1)              │
│ 6. Load last 3 session summaries (T2)   │
│ 7. Load latest full journal (Tier 3)   │
│ 8. Load active blueprint (if any)       │
│ 9. Return compiled payload              │
└─────────────────────────────────────────┘
        │
        ▼
Agent has full project context + memory
```

### Boot Modes

| Mode | Tokens | Default | Trigger |
|------|--------|---------|---------|
| **LEAN** | ~6K | Yes | `boot_mode: lean` or omit |
| **FULL** | ~35K | No | `boot_mode: full` in PROFILE.md |

Lean mode loads compressed kernel skeletons. Full protocols available on-demand.

---

## Project Registry

All projects are registered in `~/.zeos/apps/REGISTRY.json`:

```json
{
  "apps": [
    {
      "app_id": "example-project",
      "name": "Example Corp",
      "type": "venture",
      "status": "active",
      "repo": {
        "url": "https://github.com/my-org/my-repo",
        "branch": "main"
      },
      "local_path": "example-project/",
      "capabilities": ["github-persistence"],
      "modules": []
    }
  ]
}
```

### Path Resolution

Operator state is resolved by the inject MCP server (`path-resolver.ts`) under
the state root (`~/.zeos`, env `ZEOS_STATE_ROOT`), keyed by `app_id`:

- **SOUL**: `~/.zeos/souls/<app_id>/SOUL.md`
- **Journals**: `~/.zeos/journals/<app_id>/`
- **MEMORY.md**: `~/.zeos/memory/<app_id>/MEMORY.md`
- **MASTER_ROADMAP.md**: `~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md`
- **CLAUDE.md**: `<local_path>/CLAUDE.md` (in the project repo)

---

## User Model

zeos uses a **machine-owner model**. Each developer has their own zeos installation.

### Installation

```bash
# One-line install
curl -sL https://raw.githubusercontent.com/rgsuarez/zeos/main/tools/install.sh | bash

# Or clone manually
git clone https://github.com/rgsuarez/zeos.git ~/projects/zeos
cd ~/projects/zeos/infrastructure/inject && npm install && npm run build
```

### Profile Setup

1. Copy `profiles/template/` to `~/.zeos/profiles/{yourname}/`
2. Edit `PROFILE.md` with your preferences
3. Profile is "set and forget" — rarely needs updates

### Multi-User

Each user has their own:
- `~/.claude/settings.json` (MCP config)
- `~/.zeos/profiles/{name}/` (profile)

No shared state. No multi-tenancy needed.

---

## MCP Integration

zeos boot is powered by the **Inject MCP server**.

### Location

```
~/projects/zeos/infrastructure/inject/
├── src/index.ts      # MCP server implementation
├── dist/             # Compiled output
├── package.json
└── tsconfig.json
```

### Configuration

In `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "inject": {
      "command": "node",
      "args": ["~/projects/zeos/infrastructure/inject/dist/index.js"]
    }
  }
}
```

### Tools

| Tool | Purpose |
|------|---------|
| `zeos_boot` | Boot zeos, load kernel + profile |
| `zeos_load_project` | Load project with three-tier memory |
| `zeos_fleet` | Portfolio overview from REGISTRY.json |
| `zeos_snap` | Save progress to journal |
| `zeos_end_session` | End session, update MEMORY.md |
| `zeos_parallel` | Check for concurrent agents |
| `zeos_help` | Show available commands |

---

## Shell Commands

After booting, these commands are available:

| Command | Purpose |
|---------|---------|
| `/zeos` | Boot/reboot zeos |
| `/project <id>` | Load project context |
| `/snap` | Save progress to journal |
| `/end` | End session with handoff |
| `/fleet` | Portfolio overview |
| `/status` | Current state |
| `/help` | Show help |

### Prefixes

- `/` (slash) — Claude Code native commands
- `!` (bang) — Legacy, still supported

---

## Session Journals

Journals capture work for persistence and handoff.

### Location

`~/.zeos/journals/<app_id>/`

### Naming

`YYYY-MM-DD-NNN-{agent}.md`

Example: `2026-02-02-001-claude-opus.md`

### Structure

```markdown
---
date: "2026-02-02"
sequence: 1
instance: "claude-opus"
status: active
---

# Session Journal: 2026-02-02-001

## Work Log

### Task 1: Implemented feature X
- Files modified: ...
- Decisions: ...

---

## Checkpoint: 14:30:00

### Delta
- Completed ...
- Started ...

---
```

### The Bridge Rule

Every checkpoint answers: "What does a future session need to know that it can't derive from code, git, CLAUDE.md, or MEMORY.md?"

1. State of the World (what changed)
2. Open Threads (pending work/decisions)
3. Context That Would Be Lost (insights, preferences, strategic decisions)

**No file lists. No command logs. Git has that.**

---

## Continuity Modes

Set in `PROFILE.md`:

```yaml
continuity:
  mode: HEAVY
```

| Mode | Behavior |
|------|----------|
| **OFF** | No automatic journaling |
| **LIGHT** | Artifacts and decisions only |
| **STANDARD** | + state pulse every 10 min |
| **HEAVY** | + synopsis every 5 min |

---

## Security Constraints

**Credentials NEVER appear in:**
- Session journals
- Committed files
- Chat output
- Boot payloads

**Credentials stored in:**
- `~/.zeos/tokens` (local file)
- `~/.aws/credentials` (AWS profiles)
- Environment variables

---

## Directory Structure

```
~/projects/zeos/                 # the public product repo
├── kernel/
│   ├── SOUL.md              # Identity + values
│   ├── BOOT_PROTOCOL.md     # Full boot protocol
│   └── lean/                # Lean boot files
│       ├── SOUL_CORE.md
│       ├── BOOT_PROTOCOL_LEAN.md
│       ├── SHELL_PROTOCOL_LEAN.md
│       └── CONTINUITY_PROTOCOL_LEAN.md
├── profiles/
│   └── template/            # Template only (operator profiles live in ~/.zeos)
├── apps/
│   └── REGISTRY.example.json  # Starter template (live registry in ~/.zeos)
├── infrastructure/
│   └── inject/              # Inject MCP server
│       ├── src/
│       ├── dist/
│       └── package.json
├── modules/
│   └── constraints/         # Protocol modules
├── tools/
│   ├── install.sh           # Installer script
│   ├── migrate-state.py     # Relocates operator state to ~/.zeos
│   └── newproject.py        # /newproject backend
└── docs/
    ├── ARCHITECTURE.md      # This file
    └── GETTING_STARTED.md

~/.zeos/                          # operator state (machine-global, never in a repo)
├── apps/REGISTRY.json        # Live project registry
├── profiles/<operator>/      # Operator profile(s)
├── souls/<app_id>/SOUL.md    # Per-project identity
├── memory/<app_id>/MEMORY.md # Per-project curated memory
├── journals/<app_id>/        # Per-project session journals
└── roadmaps/<app_id>/MASTER_ROADMAP.md  # Per-project direction
```

---

## Quick Reference

### Boot zeos
```
/zeos
```

### Load Project
```
/project example-project
```

### Save Progress
```
/snap
```

### End Session
```
/end
```

### View Fleet
```
/fleet
```

---

*zeos Architecture v2.0.0 — "Memory infrastructure for AI."*
