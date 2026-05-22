---
module_id: "ZEOS_MODULE_004"
module_type: "constraint"
version: "1.0.0"
created: "2026-01-05"
updated: "2026-01-05"
author: "Claude (system)"
status: "active"
classification: "CONSTRAINT"
location: "modules/constraints/ZEOS_MODULE_004_JOURNAL_SCHEMA.md"
parent: "kernel/SOUL.md"
dependencies: ["ZEOS_MODULE_002_SHELL_PROTOCOL"]
applies_to: "All zeos session journals"
---

# ZEOS Module 004: Session Journal Schema

## Overview

This module defines the canonical file structure and formatting standards for session journals within the zeos ecosystem. Session journals serve as the primary record of AI-human collaborative work sessions, providing audit trails, context restoration capabilities, and knowledge preservation.

**Design Principles:**
1. Machine-parseable structure for tooling automation
2. Human-readable format for quick scanning
3. Chronological checkpoint trail for audit compliance
4. Backward-compatible with graceful legacy handling

---

## 1. File Naming Convention

### 1.1 Canonical Format

```
YYYY-MM-DD-NNN-topic.md
```

### 1.2 Component Specification

| Component | Format | Description | Example |
|-----------|--------|-------------|---------|
| `YYYY` | 4-digit year | ISO 8601 year | `2026` |
| `MM` | 2-digit month | Zero-padded (01-12) | `01` |
| `DD` | 2-digit day | Zero-padded (01-31) | `05` |
| `NNN` | 3-digit sequence | Daily session counter (001-999) | `001` |
| `topic` | kebab-case string | Brief session topic descriptor | `api-refactor` |

### 1.3 Naming Rules

1. **Date Component**: MUST use UTC date at session start
2. **Sequence Number**: MUST increment per day, starting at `001`
3. **Topic String**:
   - MUST use lowercase kebab-case
   - SHOULD be 2-5 words maximum
   - MUST NOT contain special characters except hyphens
   - SHOULD reflect primary session objective

### 1.4 Examples

**Valid:**
```
2026-01-05-001-scaffold-initialization.md
2026-01-05-002-bug-fix-auth-flow.md
2026-01-06-001-feature-user-dashboard.md
```

**Invalid:**
```
2026-01-05-scaffold-init.md       # Missing sequence number
2026-01-05-001-API_Refactor.md    # Underscore, uppercase
2026-01-05-001.md                  # Missing topic
2026-1-5-001-init.md              # Single-digit month/day
```

---

## 2. YAML Frontmatter Schema

### 2.1 Required Fields

Every session journal MUST begin with YAML frontmatter:

```yaml
---
type: session-journal
project: <project-identifier>
status: <status-enum>
started: <ISO-8601-datetime>
ended: <ISO-8601-datetime | null>
---
```

### 2.2 Field Specifications

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | String (constant) | Yes | Always `session-journal` |
| `project` | String (kebab-case) | Yes | Project identifier |
| `status` | Enum | Yes | `active`, `completed`, `abandoned`, `paused` |
| `started` | ISO 8601 datetime | Yes | Session start timestamp with `Z` suffix |
| `ended` | ISO 8601 datetime or `null` | Yes | Session end timestamp or `null` if active |

### 2.3 Status Definitions

| Status | Description |
|--------|-------------|
| `active` | Session currently in progress |
| `completed` | Session concluded successfully with objectives met |
| `abandoned` | Session terminated without completing objectives |
| `paused` | Session suspended with intent to resume |

### 2.4 Validation Rules

1. Frontmatter MUST be the first content in the file
2. Opening and closing `---` MUST be on their own lines
3. All required fields MUST be present
4. `ended` MUST be `null` for `active` or `paused` sessions
5. `ended` MUST be a valid datetime for `completed` or `abandoned` sessions

### 2.5 Complete Header Example

```yaml
---
type: session-journal
project: zeos-core
status: completed
started: 2026-01-05T10:30:00Z
ended: 2026-01-05T14:45:00Z
---

# Session: API Refactoring Sprint

## Objectives
- Refactor authentication middleware
- Update rate limiting configuration
```

---

## 3. Checkpoint Entry Format

### 3.1 Shell Protocol Bridge Rule Alignment

Checkpoint entries follow the Shell Protocol Bridge Rule format: capture what a future session needs to know that it can't derive from code, git history, CLAUDE.md, or MEMORY.md. No file lists. No command logs. Git has that.

### 3.2 Checkpoint Structure

```markdown
## Snap — {timestamp}

### State of the World
{1-3 sentences: what's different now vs before this session. Not what was done — what changed.}

### Open Threads
- {In-progress work, pending decisions, or known issues not captured in code, backlog, or memory}

### Context That Would Be Lost
- {Debugging insights, Operator preferences expressed this session, strategic decisions not yet persisted elsewhere}
```

### 3.3 Field Requirements

| Field | Required | Description |
|-------|----------|-------------|
| `timestamp` | Yes | ISO timestamp or HH:MM UTC |
| `State of the World` | Yes | 1-3 sentences: what changed (not what was done) |
| `Open Threads` | No | Bulleted list of in-progress work, pending decisions |
| `Context That Would Be Lost` | No | Knowledge that dies with the session if not captured |

### 3.4 Checkpoint Frequency Guidelines

| Session Duration | Recommended Checkpoints |
|------------------|------------------------|
| < 1 hour | 1-2 checkpoints |
| 1-2 hours | 2-4 checkpoints |
| 2-4 hours | 4-6 checkpoints |
| > 4 hours | Every 30-45 minutes |

---

## 4. Anti-Patterns

### 4.1 File Naming Anti-Patterns

**Missing Sequence Number:**
```markdown
# WRONG
2026-01-05-api-refactor.md

# CORRECT
2026-01-05-001-api-refactor.md
```

**Non-Kebab-Case Topics:**
```markdown
# WRONG
2026-01-05-001-API_Refactor_Sprint.md

# CORRECT
2026-01-05-001-api-refactor-sprint.md
```

### 4.2 Frontmatter Anti-Patterns

**Missing Required Fields:**
```yaml
# WRONG
---
type: session-journal
project: zeos-core
---

# CORRECT
---
type: session-journal
project: zeos-core
status: active
started: 2026-01-05T10:30:00Z
ended: null
---
```

**Invalid Datetime Format:**
```yaml
# WRONG
started: January 5, 2026 10:30 AM

# CORRECT
started: 2026-01-05T10:30:00Z
```

### 4.3 Checkpoint Anti-Patterns

**Missing Delta Summary:**
```markdown
# WRONG
## Checkpoint: Auth Update
**Time:** 11:45 UTC

### Actions Taken
1. Updated auth middleware

# CORRECT
## Checkpoint: Auth Update
**Time:** 11:45 UTC
**Delta:** Fixed token expiration bug in auth middleware

### State Before
...
```

**Vague State Descriptions:**
```markdown
# WRONG
### State Before
Things weren't working right.

# CORRECT
### State Before
- JWT tokens expiring after 1 minute instead of 1 hour
- Error rate at 15% on authenticated endpoints
```

---

## 5. Legacy Journal Compatibility

### 5.1 Scope

Applies to session journals created before 2026-01-04, prior to this schema.

### 5.2 Compatibility Policy

1. **No Retroactive Modification Required**: Legacy journals SHOULD NOT be bulk-modified
2. **Read Compatibility**: Tooling MUST gracefully handle legacy formats
3. **Forward Compliance**: All journals created on or after 2026-01-04 MUST comply
4. **Voluntary Migration**: Projects MAY migrate legacy journals at their discretion

### 5.3 Legacy Journal Marker

When marking a legacy journal that will not be migrated:

```yaml
---
type: session-journal
legacy: true
legacy_format_version: pre-2026-01-04
# ... other available fields
---
```

---

## 6. Validation Checklist

### File Naming
- [ ] Filename matches pattern `YYYY-MM-DD-NNN-topic.md`
- [ ] Date is valid and in UTC
- [ ] Sequence number is 3 digits, zero-padded
- [ ] Topic is kebab-case, 2-5 words

### Frontmatter
- [ ] Frontmatter is first content in file
- [ ] All five required fields present
- [ ] `type` equals `session-journal`
- [ ] `status` is valid enum value
- [ ] Timestamps use ISO 8601 with `Z` suffix

### Checkpoints
- [ ] Checkpoints are in chronological order
- [ ] Each checkpoint has Time and Delta fields
- [ ] State Before and State After are present
- [ ] Actions Taken uses numbered list

---

## 7. Integration Points

### 7.1 BOOT_PROTOCOL Step 4

Session journal initialization integrates with BOOT_PROTOCOL when `/project <id>` is invoked. See `kernel/BOOT_PROTOCOL.md` Step 4.

### 7.2 Shell Protocol Commands

| Command | Journal Interaction |
|---------|---------------------|
| `/snap` | Creates new checkpoint entry |
| `/end` | Finalizes journal, sets status to `completed` |
| `/project` | Initializes or resumes session journal |

### 7.3 scaffold.py

The `generate_journal_readme()` function produces README.md files compliant with this schema. See `tools/scaffold.py`.

---

## 8. Related Modules

| Module ID | Name | Relationship |
|-----------|------|--------------|
| ZEOS_MODULE_002 | SHELL_PROTOCOL | Defines Bridge Rule for checkpoints |
| ZEOS_MODULE_003 | CONTINUITY_PROTOCOL | Session continuity patterns |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-05 | Initial release |

---

*ZEOS_MODULE_004_JOURNAL_SCHEMA v1.0.0*
*"Structured journals enable intelligence compounding"*
