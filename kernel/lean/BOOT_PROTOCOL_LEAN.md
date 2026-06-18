---
document: "BOOT_PROTOCOL_LEAN"
version: "5.7.0"
classification: "KERNEL (IMMUTABLE)"
lean_version_of: "kernel/BOOT_PROTOCOL.md"
full_protocol_uri: "zeos://protocols/boot"
token_limit: "≤1,500 tokens"
updated: "2026-01-20"
update_reason: "Claude native integration - command prefix migration from ! to /"
---

# zeos Boot Protocol — Skeleton v5.7.0

**Purpose:** Initialize any AI agent into zeos context with full awareness.

**Full Protocol:** [zeos://protocols/boot](../BOOT_PROTOCOL.md) (36,000+ tokens)

---

## Claude Native Integration

zeos now leverages Claude's native features:
- **Rules:** `~/.claude/rules/` — Auto-loaded governance
- **Commands:** `~/.claude/commands/` — `/zeos`, `/project`, `/status`, `/fleet`
- **Skills:** `~/.claude/skills/` — `/snap`, `/end`, `/blueprint`
- **Hooks:** `~/.claude/settings.json` — SessionStart, SessionEnd, PreCompact
- **Per-Project:** `{project}/.claude/CLAUDE.md` — Project context

---

## Supremacy Hierarchy

```
KERNEL (Layer 0) — Immutable Law
  ├── SOUL.md — Values, constraints, security
  ├── BOOT_PROTOCOL.md — This document
  └── [Architecture & capability specs]

  ▼ SUPERSEDES ▼

MODULES (Layer 1) — Binding Constraints
  ├── shell-protocol — Command vocabulary (auto-loaded)
  ├── continuity-protocol — Persistence modes
  └── [Application modules as needed]

  ▼ SUPERSEDES ▼

PROFILE (Layer 2) — Operator Context
  └── PROFILE.md — Identity, preferences, fleet overview
```

**Precedence Rule:** Kernel > Modules > Profile

---

## Boot Sequence (7 Steps)

**Step 1:** Load Kernel (SOUL.md, BOOT_PROTOCOL.md)

**Step 2:** Resolve Profile (specified → default → template)

**Step 3:** Load Profile Context (PROFILE.md)

**Step 4:** Load Session Continuity
- Project mode after `/zeos` (no active project)
- On `/project <id>`: Create journal stub immediately, enable journaling

**Step 4.5:** Parallel Instance Detection
- Instance ID is the bare agent name (the `instance` frontmatter mirrors `agent`; no hash suffix)
- Scan ~/.zeos/journals/<app_id>/ for parallel instances

**Step 4.6:** Repo Boundary Detection (git root, enforcement level)

**Step 5:** Load Modules
- Auto-load: SHELL_PROTOCOL, CONTINUITY_PROTOCOL
- Conditional: BLUEPRINT_COMMANDS, FUEL_COMMANDS, BOUNDARY_COMMANDS

**Step 5.5:** Load Active Blueprint (if active_blueprint set in MASTER_ROADMAP)

**Step 6:** Validate & Confirm (Supremacy Clause compliance)

**Step 6.5:** Boot Completion Gate (MANDATORY)
- G1-G5: Kernel files loaded
- G6-G12: Project-specific gates (App SOUL, journals, blueprint, etc.)

**Self-Validation:**
1. North Star? → "One operator. Infinite leverage."
2. Version? → "5.7.0"
3. Commands? → /snap, /end, /status

**Step 7:** Determine Onboarding Flow (initial-boot / project-boot / resume-boot)

---

## Core Commands (Shell Protocol)

| Command | Purpose |
|---------|---------|
| `/zeos [profile]` | Initialize zeos (Project mode) |
| `/project <id>` | Load project context, enable journaling |
| `/snap [note]` | Save progress (manual milestone) |
| `/end` | Terminate session with final journal |
| `/status` | Infrastructure health check |
| `/help [command]` | Show available commands |
| `/fleet` | Show portfolio overview |

**Full vocabulary:** [zeos://protocols/shell](../../modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md)

---

## Error Handling

| Error | Recovery |
|-------|----------|
| PROFILE_NOT_FOUND | Fall back to template, inform operator |
| KERNEL_MISSING | Cannot boot — operator must restore |
| JOURNAL_NOT_FOUND | Proceed without continuity (new session) |

---

## Boot Validation Checklist

**Before outputting boot confirmation:**
- Did I load kernel/SOUL.md?
- Did I load kernel/BOOT_PROTOCOL.md?
- Did I load SHELL_PROTOCOL.md?
- Can I cite the North Star from memory?
- Did all G1-G5 gates pass?

---

**Full specification:** [zeos://protocols/boot](../BOOT_PROTOCOL.md)

*Boot Protocol Skeleton — "Kernel is law. Modules constrain. Profiles customize."*
