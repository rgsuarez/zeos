---
module_id: "ZEOS_MODULE_009"
module_name: "REPO_BOUNDARY"
module_type: "constraint"
version: "1.0.0"
created: "2026-01-11"
updated: "2026-01-11"
author: "Claude (system)"
status: "active"
classification: "CONSTRAINT MODULE (Governance)"
source: "IDEA-008"
---

# ZEOS_MODULE_009: Repo Boundary Constraint

> **Purpose:** Prevent unauthorized cross-repository file operations by establishing repo boundaries at project boot and enforcing write constraints.

---

## Overview

When an agent operates in Project A's context, it MUST NOT write to Project B's repository without explicit authorization. This module defines the behavioral constraints for boundary detection, enforcement, and audit.

**Problem Addressed:** Agent in Outpost channel attempted to git tag the MCPify repo without authorization, violating governance boundaries.

**Classification:** Behavioral constraint module. Operates through agent self-compliance with documented protocols—no runtime code.

---

## Boot Detection

### G12 Gate: Repo Boundary Detection

**When:** After G11 (Parallel Instance Detection), during project boot.

**Process:**

```
STEP 1: Detect Git Root
─────────────────────────────────────────────────────────────────
Execute: git rev-parse --show-toplevel

SUCCESS → Set boundary to result (absolute path)
FAILURE → Fall back to Step 2

STEP 2: Fallback Detection (if Step 1 fails)
─────────────────────────────────────────────────────────────────
Check project SOUL for repo_path field
If found → Set boundary to SOUL.repo_path
If not found → Use current working directory with WARNING

STEP 3: Initialize Session State
─────────────────────────────────────────────────────────────────
session_boundary:
  git_root: "<detected path>"
  project_name: "<from /project command>"
  detected_at: "<ISO 8601 timestamp>"
  detection_method: "git_root" | "soul_path" | "working_dir"

STEP 4: Load Enforcement Default
─────────────────────────────────────────────────────────────────
Read: profile.preferences.boundary.default_enforcement
Default: ADVISORY (if not specified)

STEP 5: Initialize Allow List
─────────────────────────────────────────────────────────────────
Load: profile.preferences.boundary.permanent_allow_list
Initialize session allow_list with permanent entries

STEP 6: Output Boot Confirmation
─────────────────────────────────────────────────────────────────
Include in boot block:
  Repo Boundary: <path>
  Enforcement: <level> (profile default)
```

### Boot Output Example

```
═══════════════════════════════════════════════════════════════
SESSION LOADED
═══════════════════════════════════════════════════════════════
...
Repo Boundary: ~/projects/outpost
Enforcement:   ADVISORY (profile default)
...
═══════════════════════════════════════════════════════════════
```

---

## Enforcement Levels

### Level Definitions

| Level | Behavior | Logging | User Notification |
|-------|----------|---------|-------------------|
| **OFF** | Allow all writes silently | None | None |
| **ADVISORY** | Warn on violation, allow operation | Full | Warning message |
| **STRICT** | Block violations | Full | Error message |

### OFF Mode

```yaml
off_mode:
  on_boundary_violation: "allow_silent"
  audit_logging: false
  user_notification: false
  use_case: "Trusted multi-project work, debugging"
```

### ADVISORY Mode (Default)

```yaml
advisory_mode:
  on_boundary_violation: "warn_and_allow"
  audit_logging: true
  user_notification: true

  warning_format: |
    ⚠️ BOUNDARY WARNING
       Target: ${target_path}
       Boundary: ${active_boundary}
       Action: Proceeding (ADVISORY mode)

       To block future violations: !boundary-set STRICT
       To allow this path: !boundary-allow ${target_path} "reason"
```

### STRICT Mode

```yaml
strict_mode:
  on_boundary_violation: "block"
  audit_logging: true
  user_notification: true

  error_format: |
    ⛔ BOUNDARY VIOLATION BLOCKED
       Target: ${target_path}
       Boundary: ${active_boundary}
       Action: Write operation DENIED

       To allow this path: !boundary-allow ${target_path} "reason"
       To change enforcement: !boundary-set ADVISORY
```

---

## Write Monitoring

### Agent Self-Monitoring Protocol

Before ANY write operation, the agent MUST perform boundary validation:

```
┌─────────────────────────────────────────────────────────────┐
│                    WRITE OPERATION FLOW                     │
└─────────────────────────────────────────────────────────────┘

1. RESOLVE PATH
   ─────────────────────────────────────────────────────────
   - Convert target path to absolute path
   - Resolve symlinks to real path
   - Expand ~ to home directory

2. CHECK BOUNDARY
   ─────────────────────────────────────────────────────────
   - Compare resolved path against session_boundary.git_root
   - Path is IN-BOUNDARY if it starts with git_root

3. IF IN-BOUNDARY
   ─────────────────────────────────────────────────────────
   → ALLOW (proceed with operation)
   → Log as "allowed" (if audit enabled)

4. IF OUT-OF-BOUNDARY
   ─────────────────────────────────────────────────────────
   → Check allow_list for matching entry
     - If match found → ALLOW (proceed with operation)
     - If no match → Apply enforcement action

5. APPLY ENFORCEMENT
   ─────────────────────────────────────────────────────────
   OFF:      Allow silently
   ADVISORY: Output warning, allow operation, log
   STRICT:   Output error, BLOCK operation, log
```

### Monitored Operations

**File Write Tools:**
- `Write` — File creation or overwrite
- `Edit` — File modification

**Git Operations:**
- `git tag` — Create/push tags
- `git commit` — Create commits
- `git push` — Push to remote
- `git checkout -b` — Create branches

**Bash File Operations:**
- `cp <src> <dst>` — Copy file
- `mv <src> <dst>` — Move file
- `rm <path>` — Delete file
- `> <path>` — Redirect output
- `>> <path>` — Append output
- `sed -i` — In-place edit
- `tee <path>` — Write via tee

### Excluded Operations (Always Allowed)

Read-only operations do not require boundary checks:
- `Read`
- `Glob`
- `Grep`
- `git status`, `git log`, `git diff`, `git show`
- `cat`, `head`, `tail`
- `ls`, `find`

---

## Allow List Management

### Allow List Structure

```yaml
allow_list:
  entries:
    - path: "~/projects/zeos/kernel"
      type: "permanent"  # From profile
      source: "profile"
      reason: "Always allow kernel writes"
      expires: "never"

    - path: "~/projects/mcpify"
      type: "session"    # From command
      source: "command"
      granted_at: "2026-01-11T04:15:00Z"
      reason: "Cross-project integration"
      expires: "session"
```

### Path Matching Rules

```
EXACT MATCH:
  allow_list entry: ~/projects/zeos
  target path:      ~/projects/zeos/kernel/BOOT.md
  result:           MATCH (target is subdirectory of allowed)

GLOB MATCH:
  allow_list entry: ~/projects/zeos/kernel/*
  target path:      ~/projects/zeos/kernel/BOOT.md
  result:           MATCH

NO MATCH:
  allow_list entry: ~/projects/zeos/kernel
  target path:      ~/projects/zeos/modules/SHELL.md
  result:           NO MATCH (different subdirectory)
```

### Granting Allowances

**Via Command:**
```bash
!boundary-allow /path/to/repo "reason for access"
```

**Via Profile (Permanent):**
```yaml
# profiles/operator/PROFILE.md
preferences:
  boundary:
    permanent_allow_list:
      - "~/projects/zeos/kernel/*"
      - "~/projects/zeos/modules/*"
```

### Revoking Allowances

```bash
# Revoke session allowance
!boundary-revoke /path/to/repo

# Permanent allowances require profile edit
```

---

## Audit Logging

### Audit Log Structure

```yaml
audit_log:
  events:
    - timestamp: "2026-01-11T04:20:00Z"
      operation: "write"
      tool: "Edit"
      target_path: "~/projects/mcpify/README.md"
      in_boundary: false
      allow_list_match: null
      enforcement_level: "ADVISORY"
      action_taken: "warned"
```

### Logged Events

| Event Type | Trigger | Logged Fields |
|------------|---------|---------------|
| Write attempt | Any monitored write operation | path, tool, result |
| Violation | Out-of-boundary write | path, enforcement, action |
| Allow grant | !boundary-allow command | path, reason, expiry |
| Allow revoke | !boundary-revoke command | path |
| Level change | !boundary-set command | old_level, new_level |

### Audit in Checkpoints

When `/snap` is executed, include boundary summary:

```markdown
### Repo Boundary Activity

- **Boundary:** ~/projects/outpost
- **Enforcement:** ADVISORY
- **Total writes:** 52
  - In-boundary: 48
  - Out-of-boundary: 4
    - Allowed (allow-list): 3
    - Warned: 1
    - Blocked: 0
- **Allow-list grants this session:** 1
  - ~/projects/zeos ("Module update")
```

---

## Shell Commands

### !boundary-status

Show current boundary configuration and statistics.

```
!boundary-status
```

**Output:**
```
═══════════════════════════════════════════════════════════════
REPO BOUNDARY STATUS
═══════════════════════════════════════════════════════════════
Active Boundary: ~/projects/outpost
Project:         outpost
Detection:       git root

Enforcement:     ADVISORY (profile default)

Allow List (2 entries):
  1. ~/projects/zeos/* (permanent)
  2. ~/projects/mcpify (session)
     Reason: "Cross-project integration"

Session Statistics:
  In-boundary writes:    48
  Out-of-boundary:       4 (3 allowed, 1 warned, 0 blocked)
═══════════════════════════════════════════════════════════════
```

### !boundary-allow

Grant temporary write access to external path.

```
!boundary-allow <path> [reason]
```

**Example:**
```
!boundary-allow ~/projects/zeos "Module integration work"
```

### !boundary-revoke

Remove path from session allow list.

```
!boundary-revoke <path>
```

### !boundary-audit

Display boundary operation log.

```
!boundary-audit [--filter <allowed|warned|blocked>] [--limit <n>]
```

### !boundary-set

Change enforcement level for current session.

```
!boundary-set <OFF|ADVISORY|STRICT>
```

---

## Profile Configuration

### Default Configuration

```yaml
# profiles/<operator>/PROFILE.md
preferences:
  boundary:
    default_enforcement: "ADVISORY"
    permanent_allow_list: []
    audit_to_journal: true
    show_boot_status: true
```

### Example: <operator> Profile

```yaml
# profiles/operator/PROFILE.md
preferences:
  boundary:
    default_enforcement: "ADVISORY"
    permanent_allow_list:
      - "~/projects/zeos/kernel/*"
      - "~/projects/zeos/modules/*"
    audit_to_journal: true
    show_boot_status: true
```

---

## Edge Cases

### Symlinks

- Resolve symlinks to real path before boundary check
- Log both symlink path and resolved path in audit

### Git Submodules

- Each submodule has its own git root
- If parent repo is boundary, submodule writes are allowed
- If submodule is loaded directly, parent writes are blocked

### Git Worktrees

- Worktrees share the same repository
- Detect via `git rev-parse --git-common-dir`
- All worktrees of same repo share boundary

### No Git Repository

- Fall back to SOUL repo_path or working directory
- Output warning at boot about degraded detection
- Recommend running from git repository root

---

## Related Documents

- REPO_BOUNDARY_ARCHITECTURE.md (design reference): Architecture design
- REPO_BOUNDARY_SCHEMA.md (design reference): YAML schema
- REPO_BOUNDARY_COMMANDS.md (design reference): Command interface
- [BOOT_PROTOCOL.md](../../kernel/BOOT_PROTOCOL.md) — G12 gate integration
- [SHELL_PROTOCOL.md](ZEOS_MODULE_002_SHELL_PROTOCOL.md) — Command integration

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-01-11 | Claude (system) | Initial module |

---

*ZEOS_MODULE_009_REPO_BOUNDARY v1.0.0 — "Stay in your lane"*
