---
module_id: "ZEOS_MODULE_004"
module_type: "constraint"
version: "2.0.0"
created: "2026-01-05"
updated: "2026-06-18"
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

> **Runtime-reconciled (v2.0.0, 2026-06-18).** This module is the binding,
> kernel-referenced source of truth for journal structure. As of v2.0.0 it is
> aligned end-to-end to the actual Inject MCP runtime in
> `infrastructure/inject/src/lib/journal.ts` and the snap/end handlers in
> `infrastructure/inject/src/index.ts`. The pre-2.0.0 schema described a
> `topic`-slug filename, a `type`/`started`/`ended` frontmatter, an
> `/end`-flips-`status` completion model, a `## Snap` checkpoint with
> State-of-the-World / Open-Threads / Context sections, and a
> Time/Delta/State-Before/State-After checkpoint body, none of which the runtime
> ever implemented. All of those are corrected throughout (the file naming and
> frontmatter in Sections 1-2, and the checkpoint shape, anti-patterns,
> validation checklist, and integration references in Sections 3, 4, 6, and 7).
> Fields that are genuinely wanted but not yet built (`type`, `ended`, `topic`,
> `paused` resume) are marked **Intentional-future** and are NOT current law.
> See the Version History note at the end.

---

## 1. File Naming Convention

### 1.1 Canonical Format

```
YYYY-MM-DD-NNN-<agent>.md
```

The agent name is the trailing component so parallel instances writing on the
same day do not collide. There is **no topic slug**; the session topic lives in
the journal body (the runtime emits no `topic` frontmatter field; see the
Intentional-future note below and the required frontmatter in Section 2.1).

### 1.2 Component Specification

| Component | Format | Description | Example |
|-----------|--------|-------------|---------|
| `YYYY` | 4-digit year | ISO 8601 year | `2026` |
| `MM` | 2-digit month | Zero-padded (01-12) | `06` |
| `DD` | 2-digit day | Zero-padded (01-31) | `18` |
| `NNN` | 3-digit sequence | Daily session counter (001-999) | `001` |
| `<agent>` | agent identifier | Writing agent name | `claude` |

### 1.3 Naming Rules

1. **Date Component**: MUST use UTC date at session start (`new Date().toISOString().split("T")[0]`)
2. **Sequence Number**: MUST increment per day, zero-padded, starting at `001`; the runtime probes `001`-`999` and uses exclusive-create (`flag: "wx"`) so a collision advances to the next free sequence
3. **Agent Component**: the writing agent's name (e.g. `claude`, `gemini`, `codex`), used to keep concurrent instances in distinct files

### 1.4 Examples

**Valid:**
```
2026-06-18-001-claude.md
2026-06-18-002-gemini.md
2026-06-19-001-codex.md
```

**Invalid:**
```
2026-06-18-claude.md          # Missing sequence number
2026-06-18-001-API_Refactor.md # Topic slug is not part of the schema
2026-06-18-001.md              # Missing agent component
2026-6-8-001-claude.md         # Single-digit month/day
```

> **Intentional-future:** a kebab-case `topic` slug after the sequence (the
> pre-2.0.0 design) is a wanted enhancement for at-a-glance scanning but is NOT
> implemented and MUST NOT be treated as required. Tooling parses the
> `YYYY-MM-DD-NNN-<agent>.md` shape; a topic slug would require a runtime change
> to `createJournalStub` plus every consumer regex first.

---

## 2. YAML Frontmatter Schema

### 2.1 Required Fields

Every session journal MUST begin with the YAML frontmatter the runtime emits
when it creates the stub (`createJournalStub`). The fields, in emitted order:

```yaml
---
schema_version: "2.0.0"
session_id: "YYYY-MM-DD-NNN"
project: "<app_id>"
date: "YYYY-MM-DD"
sequence: N
agent: "<agent>"
instance: "<agent>"
status: active
created: "<ISO-8601-datetime>"
previous_session: "YYYY-MM-DD-NNN" | null
---
```

### 2.2 Field Specifications

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema_version` | String (quoted) | Yes | Journal schema version; runtime constant `JOURNAL_SCHEMA_VERSION` (currently `"2.0.0"`) |
| `session_id` | String (quoted) | Yes | `YYYY-MM-DD-NNN`, equals the filename's date+sequence |
| `project` | String (quoted) | Yes | The project `app_id` (empty string if unknown) |
| `date` | String (quoted) | Yes | UTC date at session start, `YYYY-MM-DD` |
| `sequence` | Integer (bare) | Yes | Daily session counter as a bare integer (not zero-padded, not quoted) |
| `agent` | String (quoted) | Yes | Writing agent name |
| `instance` | String (quoted) | Yes | Instance identifier (currently mirrors `agent`) |
| `status` | Literal `active` | Yes | Always written as `active`; never mutated (see 2.3) |
| `created` | String (quoted) | Yes | Full ISO-8601 stub-creation timestamp with `Z` suffix |
| `previous_session` | String (quoted) or bare `null` | Yes | `session_id` of the prior substantive session, or bare `null` if first |

### 2.3 Status and Completion Model (append-only)

The runtime is **append-only**. The frontmatter `status` is written once as
`active` and is **never flipped**. A session's completion is signaled by an
appended `## Session End:` block in the body, not by a frontmatter change.

| Mechanism | Meaning |
|-----------|---------|
| `status: active` (frontmatter) | The created state of every journal; stays `active` for the file's life |
| `## Checkpoint: <ts>` (body) | A `/snap` checkpoint was appended |
| `## Session End: <ts>` (body) | The session was finalized via `/end` (this IS the completion marker) |

**Legacy back-compat:** tooling also treats frontmatter `status: complete`
(short form) as complete, but ONLY for pre-2.0.0 journals; the live runtime
never writes it.

### 2.4 Validation Rules

1. Frontmatter MUST be the first content in the file
2. Opening and closing `---` MUST be on their own lines
3. All required fields above MUST be present
4. `status` MUST be `active`; completion is the appended `## Session End:` block, not a status value
5. `previous_session` MUST be a quoted `session_id` or the bare token `null`
6. `session_id` MUST match the filename's `YYYY-MM-DD-NNN` prefix

### 2.5 Complete Header Example

```yaml
---
schema_version: "2.0.0"
session_id: "2026-06-18-001"
project: "zeos-dev"
date: "2026-06-18"
sequence: 1
agent: "claude"
instance: "claude"
status: active
created: "2026-06-18T10:30:00.000Z"
previous_session: "2026-06-17-004"
---

# Session Journal: 2026-06-18-001

*Session started via zeos Inject MCP*
```

> **Intentional-future:** the pre-2.0.0 fields `type: session-journal`,
> `started`, `ended`, and the broader status enum (`completed`, `abandoned`,
> `paused`) are NOT current law. An explicit `ended` timestamp and a `paused`
> resume state are reasonable future enhancements, but each would require a
> runtime change (the append-only finalizer would have to also write
> frontmatter) before it could be required here. Until then, do not emit or
> require `type`, `started`, `ended`, or any non-`active` status.

---

## 3. Checkpoint Entry Format

### 3.1 Shell Protocol Bridge Rule Alignment

Checkpoint entries follow the Shell Protocol Bridge Rule format: capture what a future session needs to know that it can't derive from code, git history, CLAUDE.md, or MEMORY.md. No file lists. No command logs. Git has that.

### 3.2 Checkpoint Structure

This is the exact block the runtime appends on `/snap` (the `zeos_snap`
handler in `infrastructure/inject/src/index.ts`). The heading is
`## Checkpoint:` with an ISO timestamp, and the only required body section is
`### Bridge`. `Note` and `Tags` are optional and emitted only when supplied:

```markdown
## Checkpoint: {ISO-8601-timestamp}

**Note:** {optional one-line operator note; omitted when not supplied}

**Tags:** {optional comma-separated tags; omitted when not supplied}

### Bridge
{What a future session needs to know that it cannot derive from code, git
history, CLAUDE.md, or MEMORY.md. Bridge Rule content, see Section 3.1.}
```

After the Bridge, the runtime appends an optional git snapshot and a redaction
notice when sensitive values were stripped; those are tool-generated, not
operator-authored fields.

### 3.3 Field Requirements

| Field | Required | Description |
|-------|----------|-------------|
| `timestamp` | Yes | ISO-8601 timestamp in the `## Checkpoint:` heading (runtime always emits ISO) |
| `Bridge` | Yes | Bridge Rule content (Section 3.1): what a future session cannot derive from code, git, CLAUDE.md, or MEMORY.md |
| `Note` | No | Optional one-line note; emitted only when supplied |
| `Tags` | No | Optional comma-separated tags; emitted only when supplied |

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

The runtime filename is `YYYY-MM-DD-NNN-<agent>.md` with no topic slug (Section
1). The agent name is the trailing component.

**Missing Sequence Number:**
```markdown
# WRONG
2026-01-05-claude.md

# CORRECT
2026-01-05-001-claude.md
```

**Topic Slug Instead of Agent (not the schema):**
```markdown
# WRONG
2026-01-05-001-api-refactor-sprint.md

# CORRECT
2026-01-05-001-claude.md
```

### 4.2 Frontmatter Anti-Patterns

**Missing Required Fields:**
```yaml
# WRONG
---
session_id: "2026-06-18-001"
project: "zeos-dev"
---

# CORRECT (see Section 2.1 for the full required set)
---
schema_version: "2.0.0"
session_id: "2026-06-18-001"
project: "zeos-dev"
date: "2026-06-18"
sequence: 1
agent: "claude"
instance: "claude"
status: active
created: "2026-06-18T10:30:00.000Z"
previous_session: null
---
```

**Invalid Datetime Format:**
```yaml
# WRONG
created: June 18, 2026 10:30 AM

# CORRECT
created: "2026-06-18T10:30:00.000Z"
```

**Flipping status on completion (WRONG):**
```yaml
# WRONG - the runtime never rewrites frontmatter; status stays active
status: completed

# CORRECT - completion is an appended body block, frontmatter is untouched
status: active
# ...and in the body:
## Session End: 2026-06-18T14:45:00.000Z
```

### 4.3 Checkpoint Anti-Patterns

A checkpoint is a `## Checkpoint: <ISO-ts>` heading with a `### Bridge` body
(Section 3.2). The anti-patterns are about Bridge content, not a `Time`/`Delta`/
`State Before` body the runtime never emits.

**Action Log Instead of a Bridge:**
```markdown
# WRONG - re-derivable from git; not Bridge content
## Checkpoint: 2026-06-18T11:45:00.000Z

### Bridge
1. Edited auth middleware
2. Ran the test suite
3. Committed the fix

# CORRECT - what a future session cannot derive from code or git
## Checkpoint: 2026-06-18T11:45:00.000Z

### Bridge
Token expiry was set in seconds, not ms; the 1-minute logout was a unit bug,
not a refresh-flow bug. Left the refresh path untouched on purpose.
```

**Vague Bridge:**
```markdown
# WRONG
### Bridge
Things weren't working right; fixed some of it.

# CORRECT
### Bridge
JWT tokens expired after 1 minute instead of 1 hour because expiry was passed in
seconds. Authenticated-endpoint error rate was ~15% until the unit fix landed.
```

---

## 5. Legacy Journal Compatibility

### 5.1 Scope

Applies to session journals created before 2026-01-04, prior to any version of
this schema.

### 5.2 Compatibility Policy

1. **No Retroactive Modification Required**: Legacy journals SHOULD NOT be bulk-modified
2. **Read Compatibility**: Tooling MUST gracefully handle legacy formats
3. **Forward Compliance**: All journals the live runtime writes today comply with the **v2.0.0 runtime schema** defined by this module (Sections 1-3). The original v1.0.0 forward-compliance cutoff (journals created on or after 2026-01-04) still marks the boundary below which the legacy read-compatibility carve-out applies; journals written above it are validated against whichever version of this module was current when they were written, and against v2.0.0 going forward.
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
- [ ] Filename matches pattern `YYYY-MM-DD-NNN-<agent>.md`
- [ ] Date is valid and in UTC
- [ ] Sequence number is 3 digits, zero-padded
- [ ] Trailing component is the writing agent name (no topic slug)

### Frontmatter
- [ ] Frontmatter is first content in file
- [ ] All ten required fields present (Section 2.1)
- [ ] `session_id` matches the filename's date+sequence
- [ ] `status` is `active` (completion is the appended `## Session End:` block)
- [ ] `created` uses ISO 8601 with `Z` suffix
- [ ] `previous_session` is a quoted `session_id` or bare `null`

### Checkpoints
- [ ] Checkpoints are in chronological order (append-only)
- [ ] Each checkpoint heading is `## Checkpoint:` with an ISO-8601 timestamp
- [ ] Each checkpoint has a `### Bridge` section with Bridge Rule content (Section 3.2)
- [ ] `Note` and `Tags`, when present, sit above the Bridge

---

## 7. Integration Points

### 7.1 BOOT_PROTOCOL Step 4

Session journal initialization integrates with BOOT_PROTOCOL when `/project <id>` is invoked. See `kernel/BOOT_PROTOCOL.md` Step 4.

### 7.2 Shell Protocol Commands

| Command | Journal Interaction |
|---------|---------------------|
| `/snap` | Appends a `## Checkpoint:` block (append-only) |
| `/end` | Appends a `## Session End:` block; this block IS the completion marker. Does NOT flip frontmatter `status` or rewrite the file |
| `/project` | Creates (or reuses) the day's journal stub and seeds `previous_session` |

### 7.3 Inject MCP Runtime

Journal stubs that comply with this schema are produced by the Inject MCP
runtime, not by a scaffolding script. `createJournalStub` in
`infrastructure/inject/src/lib/journal.ts` emits the Section 2.1 frontmatter and
the opening body; the `zeos_snap` and `zeos_end_session` handlers in
`infrastructure/inject/src/index.ts` append the Section 3 checkpoint and the
`## Session End:` completion block. There is no separate journal-README
generator in `tools/`.

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
| 2.0.0 | 2026-06-18 | Runtime reconciliation. Aligned the binding schema end-to-end to the actual Inject MCP runtime (`infrastructure/inject/src/lib/journal.ts` + the snap/end handlers in `src/index.ts`). Corrected: filename is `YYYY-MM-DD-NNN-<agent>.md` (no topic slug, Sections 1 and 4.1); frontmatter is `schema_version, session_id, project, date, sequence, agent, instance, status, created, previous_session` (replacing `type`/`started`/`ended`, Section 2); the checkpoint block is `## Checkpoint: <ISO-ts>` with a required `### Bridge` section plus optional `Note`/`Tags` (Sections 3.2-3.3), replacing the prior `## Snap` State-of-the-World/Open-Threads body; the checkpoint anti-patterns and the Section 6 validation checklist were re-expressed around the Bridge body (dropping the never-emitted Time/Delta/State-Before/State-After fields); the Section 7.3 integration reference now points at the Inject MCP runtime instead of a non-existent `tools/scaffold.py` README generator; and completion is the appended `## Session End:` block under an append-only model (the prior `/end`-flips-`status` description was never implemented). The withdrawn fields (`type`, `ended`, `topic` slug, `paused` resume) are reclassified as Intentional-future, not current law. |

> **2.0.0 reconciliation note (2026-06-18).** This is a dated amendment to a
> binding, kernel-referenced constraint. The kernel restatement in
> `kernel/BOOT_PROTOCOL.md` (Step 4) was updated in lockstep in the same change
> so the kernel does not cite a stale spec, and the older conflicting
> `docs/SESSION_JOURNAL_FORMAT.md` was superseded by a pointer to this module.
> The amendment reconciles documentation to existing runtime behavior; it does
> not change any runtime code.

---

*ZEOS_MODULE_004_JOURNAL_SCHEMA v2.0.0*
*"Structured journals enable intelligence compounding"*
