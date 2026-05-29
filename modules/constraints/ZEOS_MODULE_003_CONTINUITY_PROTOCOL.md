---
module_id: "continuity-protocol"
module_type: "constraint"
version: "3.3.0"
created: "2025-12-29"
updated: "2026-01-13"
author: "Claude (system)"
status: "active"
load_priority: 2
dependencies: ["shell-protocol"]
conflicts: []
auto_load: true
authority: "Operator directive 2025-12-29, IDEA-003 implementation, IDEA-008 integration"
update_reason: "Document (removed in v1.0) vs (removed in v1.0) relationship"
---

# Module: Continuity Protocol

## Purpose

This module defines **Continuity Mode** — the system for continuous, automatic persistence that keeps zeos in Alive State without requiring explicit operator checkpoints.

**Core Principle:** Persistence is continuous, not ceremonial. The system stays alive by default.

**Problem Solved:** Manual checkpoints create failure points. Operators forget. Work is lost. Continuity Mode eliminates this by making persistence automatic.

---

## Parallel Instance Support

zeos supports multiple agent instances working on the same project simultaneously. This section defines the coordination mechanisms.

### Instance Identification

Each zeos session receives a unique instance identifier at boot:

```
Instance ID Format: {agent}-{hash4}

Examples:
  claude-opus-a3f2
  gemini-cli-b7c1
  codex-d9e4
  aider-f1a8
```

**Generation Algorithm:**

```
ON SESSION START (after /project load):
  1. EXTRACT agent name:
     - From model identifier (claude-opus-4-5 → claude-opus)
     - From CLI tool name (gemini → gemini-cli)
     - Fallback: "agent"

  2. GENERATE hash suffix:
     - Input: timestamp (ms) + process ID + 4 random bytes
     - Output: 4-character hex string (e.g., "a3f2")

  3. COMPOSE instance ID: "{agent}-{hash4}"

  4. STORE in session context (memory only, not persisted)
```

**Instance ID Usage:**

| Context | How Instance ID Is Used |
|---------|------------------------|
| Journal filename | `{date}-{seq}-{agent-name}.md` |
| Commit messages | `Instance: {instance-id}` in commit body |
| Boot output | Displayed in session load card |
| /status output | Shown with parallel instance count |

**Session Scope:** Instance ID is ephemeral — new ID generated each boot. Not persisted to disk.

### Journal Stub at Boot (Immediate Visibility)

**⚠️ CRITICAL: All agents MUST create a journal stub immediately on `/project` load.**

The stub makes the instance visible to parallel detection **before** any work or checkpoint occurs. Without the stub, instances are invisible until first checkpoint — creating a collision window.

**Stub Creation (On `/project` Load):**

```
1. GENERATE instance ID: {agent}-{hash4}
2. GLOB ~/.zeos/journals/<app_id>/{today}-*.md
3. DETERMINE next sequence number
4. CREATE stub file immediately
5. COMMIT stub (single-file commit)
6. PROCEED with boot
```

**Stub File Template:**

```yaml
---
session: "2026-01-08-009"
instance: "claude-opus-b7d9"
project: "zeos-dev"
agent: "Claude Opus 4.5"
started: "2026-01-08T23:45:00Z"
ended: null
status: in_progress
blueprint: "IMPLEMENT_FEATURE_X.md"
---

# Session 009: [Awaiting First Checkpoint]

*Journal stub created at boot. Content populates on first `/snap`.*

---
```

**Stub Commit Message:**
```
session: 2026-01-08-009 boot stub (claude-opus-b7d9)
```

**Stub Lifecycle:**

| Event | Action |
|-------|--------|
| `/project` load | Stub created + committed |
| First `/snap` | Placeholder body replaced with real content |
| Subsequent checkpoints | Content appended |
| `/end` | `status: in_progress` → `status: complete` |
| Crash | Stub remains with `status: in_progress` (stale detection finds it) |

**Why Commit Immediately:**

- Local-only stub invisible to other machines
- Immediate commit = immediate visibility across fleet
- Crash before checkpoint still leaves trace

---

### Instance-Scoped Session Journals

Journal files include agent identifier to prevent collision:

```
Before (collision-prone):
  ~/.zeos/journals/<app_id>/2026-01-08-007.md

After (instance-scoped):
  ~/.zeos/journals/<app_id>/2026-01-08-007-claude-opus.md
  ~/.zeos/journals/<app_id>/2026-01-08-007-gemini-cli.md
```

**Naming Convention:**
```
{date}-{sequence}-{agent-name}.md

Components:
  date       = ISO date (YYYY-MM-DD)
  sequence   = Daily sequence number (001-999)
  agent-name = Lowercase agent identifier from instance ID
```

**Sequence Number Assignment:**

```
ON JOURNAL CREATION:
  1. GLOB ~/.zeos/journals/<app_id>/{today}-*.md
  2. PARSE filenames, extract sequence numbers
  3. FIND highest sequence for today
  4. INCREMENT by 1 for this instance

  IF sequence collision detected (race condition):
    APPEND instance hash suffix: {date}-{seq}-{agent-name}-{hash4}.md
```

**Collision-Safe Examples:**
```
2026-01-08-007-claude-opus.md      # First Claude instance
2026-01-08-007-gemini-cli.md       # Gemini (same seq OK, different agent)
2026-01-08-007-claude-opus-a3f2.md # Second Claude (hash suffix)
```

**Backward Compatibility:** Legacy journals without agent suffix are still valid and readable. New sessions always use instance-scoped format.

### Protected Files Registry

Certain files require single-writer semantics. Concurrent modification causes semantic conflicts even if git can merge.

**Protected File List:**

| File Pattern | Reason | Location |
|--------------|--------|----------|
| `MASTER_ROADMAP.md` | Version field, active_blueprint | `~/.zeos/roadmaps/<app_id>/` |
| Active blueprint (from frontmatter) | Task status updates | Project blueprints/ |
| `~/.zeos/apps/REGISTRY.json` | App registry mutations | state root (`~/.zeos`) |
| `CHANGELOG.md` | Version entries | Project root |

**Timestamp Check Protocol:**

```
BEFORE MODIFYING PROTECTED FILE:

  1. READ file, capture mtime (modification timestamp)

  2. PREPARE changes in memory

  3. CHECK mtime again immediately before write

  4. IF mtime changed since step 1:
     a. DETECT conflict — another instance modified
     b. READ new content
     c. ATTEMPT merge if append-only section
     d. IF structural conflict:
        → OUTPUT conflict warning (see format below)
        → OFFER options: retry, overwrite, abort

  5. IF mtime unchanged:
     a. WRITE changes
     b. COMMIT immediately (minimize conflict window)
```

**Conflict Warning Format:**

```
═══════════════════════════════════════════════════════════════
⚠️ PROTECTED FILE CONFLICT
═══════════════════════════════════════════════════════════════
File: MASTER_ROADMAP.md
Modified by: Another instance at 15:42:07
Your change: Bump version to 1.10.0
Their change: Set active_blueprint to IMPLEMENT_X.md

Options:
  [1] Retry (re-read and merge)
  [2] Overwrite (your changes win)
  [3] Abort (discard your changes)
═══════════════════════════════════════════════════════════════
```

**Conflict Resolution:**

| Option | Behavior |
|--------|----------|
| Retry | Re-read file, attempt to merge changes intelligently |
| Overwrite | Write your version, discarding their changes (use with caution) |
| Abort | Cancel your edit, keep their version |

**Merge Rules for Protected Files:**

| Section Type | Auto-Merge Possible |
|--------------|---------------------|
| Version bumps | No — manual resolution |
| active_blueprint changes | No — only one can be active |
| Task status updates | Yes — if different tasks |
| Changelog entries | Yes — append both |
| Registry additions | Yes — merge entries |

---

## The Continuity Mode Dial

| Mode | Behavior | Target User | Default |
|------|----------|-------------|---------|
| `LOCK` | Zero repo writes. True incognito. | Sensitive exploration, off-record | |
| `OFF` | Manual `/snap` only. No automatic journaling. | Privacy-conscious, explorers | |
| `LIGHT` | Artifacts + decisions + procedures only | Executives, demos, clean repos | |
| `STANDARD` | LIGHT + periodic state pulse (configurable interval) | Most users | ✅ |
| `HEAVY` | STANDARD + granular deltas + conversation synopsis | Builders, compliance, power users | |

---


---

### ⛔ AUTO-CHECKPOINT ENFORCEMENT CLAUSE ⛔

**In STANDARD and HEAVY modes, the agent MUST auto-checkpoint silently.**

This is not optional. This is not "when convenient." This is automatic and mandatory.

**Core Principle:** Users WILL forget to checkpoint. Sessions WILL end abruptly. The system MUST protect work automatically.

**Triggers (any ONE sufficient to initiate auto-checkpoint):**

| Trigger | Threshold | Rationale |
|---------|-----------|-----------|
| Time elapsed | 10 minutes since last checkpoint | Prevents loss of more than 10 min work |
| Activity count | 5+ file changes or tool calls | High activity = high value at risk |
| Major artifact | File creation complete | Natural save point |
| Context warning | ~80% context usage (if detectable) | Last chance before session death |

**Execution Sequence:**

1. **VERIFY** coherent unit complete (not mid-file, mid-function)
2. **REFLECT** on what changed since last checkpoint (Bridge Rule)
3. **SYNTHESIZE** into structured journal entry
4. **COMMIT** to GitHub with `[AUTO]` prefix in message
5. **CONTINUE** silently (no user notification for routine auto-saves)

**Auto-Checkpoint Journal Format:**

```yaml
---
type: auto-checkpoint
timestamp: 2026-01-03T15:30:00Z
trigger: time_elapsed | activity_count | artifact_complete | context_warning
mode: STANDARD
---

## [AUTO] Work Since Last Save

### Artifacts
- Created /path/to/file.py — description
- Modified /path/to/other.js — what changed

### Current Focus
What the agent is working on.
```

**Context Limit Warning (MANDATORY when detectable):**

When session complexity exceeds ~80% estimated capacity, the agent MUST:

1. Execute immediate auto-checkpoint
2. Output warning to user:

```
═══════════════════════════════════════════════════════════════
⚠️ CONTEXT LIMIT APPROACHING
═══════════════════════════════════════════════════════════════
Auto-checkpoint saved. Session may terminate soon.
Consider: /end and start fresh session to continue work.
═══════════════════════════════════════════════════════════════
```

**Why This Matters:**

Without mandatory auto-checkpoint:
- Users lose 30+ minutes of work when sessions end
- Recovery requires re-explaining context from scratch
- Trust in zeos erodes ("it lost my work")
- The entire purpose of zeos (defeating context death) fails

**Failure Mode:**

If agent reaches session end without recent checkpoint:
- This is a **SYSTEM FAILURE**
- Work is lost
- User trust is damaged
- The agent has failed its core mission

**Override Behavior:**

| Mode | Auto-Checkpoint |
|------|-----------------|
| LOCK | ❌ Disabled (true incognito) |
| OFF | ❌ Disabled (manual only) |
| LIGHT | ❌ Disabled (artifacts only on explicit events) |
| STANDARD | ✅ **MANDATORY** every 10 min |
| HEAVY | ✅ **MANDATORY** every 5 min |

## Mode Specifications

### OFF Mode

```
Triggers: None (manual only)
Behavior: 
  - No automatic journal writes
  - /snap required for any persistence
  - System logs that journaling is disabled (audit integrity)
Use case: Sensitive exploration, privacy-first users
```


### (removed in v1.0) (True Incognito)

```
Triggers: None
Behavior:
  - ZERO repo writes (automatic OR manual)
  - /snap returns: "⚠️ Continuity LOCKED — no persistence this session"
  - /end outputs handoff block to CHAT ONLY (not committed)
  - /end includes explicit alert: "🔒 LOCK MODE: No files were written this session"
  - Session exists only in conversation context
Use case: Sensitive exploration, off-the-record discussions, demos, brainstorming
```

**(removed in v1.0) Command Behavior:**

| Command | Behavior in (removed in v1.0) |
|---------|----------------------|
| `/snap` | Refused with alert message |
| `/snap --force` | Refused (no override possible) |
| `/end` | Outputs handoff to chat + LOCK alert, no commit |
| `+continuity UNLOCK` | Alias for switching to OFF mode |

**/end Output in (removed in v1.0):**

```
═══════════════════════════════════════════════════════════════
🔒 LOCK MODE SESSION COMPLETE
═══════════════════════════════════════════════════════════════
No files were written to the repository this session.
To preserve this work, manually copy the handoff below.
═══════════════════════════════════════════════════════════════

[Standard handoff block content here]

═══════════════════════════════════════════════════════════════
```

**(removed in v1.0) vs (removed in v1.0):**

| Aspect | (removed in v1.0) (``) | (removed in v1.0) |
|--------|------------------------|-----------|
| **How to enter** | `/project <id> ` | `+continuity LOCK` or profile setting |
| **Journal stub** | NOT created (invisible) | Created normally |
| **Parallel detection** | Session invisible | Session visible |
| **Can switch mid-session** | No (must `/end` and reboot) | Yes (`+continuity <mode>`) |
| **Use case** | Read-only exploration | Off-record work that may write later |

Ghost mode is LOCK mode + no journal stub. Use ghost mode when you want to be completely invisible to the project. Use LOCK mode when you want visibility but no persistence.

### LIGHT Mode

```
Triggers:
  ✅ Artifact created/modified (files, code, documents)
  ✅ Decision locked ("We will use X because Y")
  ✅ Procedure/SOP defined
  ❌ Tool calls (unless they produce artifacts)
  ❌ Conversation synopsis
  ❌ Periodic pulse

Debounce: Per-artifact (no time-based batching)
Format: Minimal delta — path + one-line summary
```

### STANDARD Mode (Default)

```
Triggers:
  ✅ All LIGHT triggers
  ✅ Periodic state pulse (every debounce_minutes if meaningful work occurred)
  ✅ Tool calls that modify state
  ❌ Conversation synopsis

Debounce: Configurable (default: 10 minutes)
Format: Structured delta with context
```

### HEAVY Mode

```
Triggers:
  ✅ All STANDARD triggers
  ✅ Conversation synopsis (significant dialog summarized)
  ✅ All tool calls (including read operations)
  ✅ Risk/security events

Debounce: Configurable (default: 5 minutes)
Format: Comprehensive delta with full context
```

---

## Event Trigger Definitions

### Artifact Events (LIGHT+)

| Event | Captures |
|-------|----------|
| File created | Path, purpose, brief content summary |
| File modified | Path, what changed, why |
| Code executed | Command/function, outcome, side effects |
| Document produced | Title, format, purpose |

### Decision Events (LIGHT+)

| Event | Captures |
|-------|----------|
| Architecture decision | Choice made, alternatives rejected, rationale |
| Technology selection | What was chosen, why, constraints considered |
| Process decision | Workflow defined, governance implications |

### Procedure Events (LIGHT+)

| Event | Captures |
|-------|----------|
| SOP defined | Steps, prerequisites, expected outcomes |
| Runbook created | Procedure name, trigger conditions, actions |
| Workflow documented | Process flow, decision points, ownership |

### State Pulse Events (STANDARD+)

| Event | Captures |
|-------|----------|
| Periodic pulse | Summary of work since last pulse, current focus, next action |
| Session idle | State snapshot when no input for 2+ minutes |
| Complexity threshold | Auto-checkpoint when session complexity exceeds threshold |

### Synopsis Events (HEAVY only)

| Event | Captures |
|-------|----------|
| Significant dialog | 2-3 sentence summary of meaningful exchange |
| Direction change | Pivot detected, old vs new direction |
| Clarification received | Ambiguity resolved, impact on work |

---

## Persistence Mechanics

### Buffer Model

```
IN-MEMORY BUFFER
  │
  ├── Append on each triggered event
  │
  └── FLUSH to journal on:
      ├── Debounce timer expires (configurable)
      ├── Major artifact completed
      ├── Session idle (2+ minutes no input)
      ├── /snap command (explicit milestone)
      ├── /end command (mandatory final flush)
      └── Buffer size threshold (prevent memory bloat)
```

### Debounce Rules

| Mode | Default Interval | Configurable |
|------|------------------|--------------|
| OFF | N/A | N/A |
| LIGHT | Per-event (no batching) | No |
| STANDARD | 10 minutes | Yes |
| HEAVY | 5 minutes | Yes |

### Compaction (Future Enhancement)

```
COMPACTION RULES:
  - Trigger: compact_after_entries threshold reached
  - Action: Summarize N deltas into 1 coherent entry
  - Preserve: All artifact references, decisions, procedures
  - Compress: Redundant state pulses, minor tool calls
```

---

## Configuration Schema

### Profile Preference Block

```yaml
# profiles/{operator}/PROFILE.md (continuity section)
continuity:
  mode: STANDARD                    # LOCK | OFF | LIGHT | STANDARD | HEAVY
  debounce_minutes: 10              # Flush interval (STANDARD/HEAVY)
  
  # Auto-Checkpoint Settings (STANDARD/HEAVY only)
  auto_checkpoint: true             # Enable silent auto-checkpoint protection
  auto_checkpoint_interval: 10      # Minutes between auto-checkpoints
  activity_threshold: 5             # File changes/tool calls before forced checkpoint
  context_warning: true             # Warn when approaching session limits
  
  # Advanced
  compact_after_entries: 20         # Trigger compaction (future)
  allow_conversation_synopsis: true # Enable dialog summaries (HEAVY)
```

**Auto-Checkpoint Defaults by Mode:**

| Mode | auto_checkpoint | interval | activity_threshold |
|------|-----------------|----------|-------------------|
| LOCK | N/A (no writes) | N/A | N/A |
| OFF | false | N/A | N/A |
| LIGHT | false | N/A | N/A |
| STANDARD | **true** | 10 min | 5 |
| HEAVY | **true** | 5 min | 3 |


### Per-App Override (Optional)

```yaml
# ~/.zeos/souls/{app_id}/APP_SOUL.md or APP_MANIFEST.json
continuity:
  mode: LIGHT    # Can only be MORE restrictive than profile
```

**Override Rule:** App-level continuity mode can only be LOWER (more restrictive) than profile default. Apps cannot escalate logging beyond operator preference.

### Session Override

```bash
/zeos --continuity=OFF     # This session only
/zeos --continuity=HEAVY   # This session only
```

---

## Hard Constraints (Always Enforced)

**Regardless of Continuity Mode setting, these constraints ALWAYS apply:**

### 1. No Credentials in Output

```
BEFORE ANY JOURNAL WRITE:
  1. Scan buffer for credential patterns:
     - API keys, tokens, passwords
     - Connection strings, secrets
     - Private keys, certificates
  2. If detected:
     - Replace with: "[REDACTED: credential type]"
     - Log: "Security event: credential redacted from journal"
     - Continue with sanitized content
  3. If clean:
     - Write to journal
```

### 2. Kernel Supremacy

```
Continuity Mode CANNOT override:
  - SOUL.md constraints
  - Security model
  - Operator authority
  - Any Kernel-level rule
```

### 3. Audit Integrity

```
Even in OFF mode:
  - Log that journaling is disabled
  - Log session start/end times
  - Log any security events
  
The system always knows what it chose NOT to log.
```

### 4. Blueprint Enforcement

When an active blueprint is loaded, `/snap` behavior changes based on enforcement level:

| Level | Behavior |
|-------|----------|
| **OFF** | No alignment section in checkpoint. Purely informational. |
| **ADVISORY** | Show alignment section. Unplanned work flagged with ⚠️. No blocking. |
| **STRICT** | Show alignment section. Unplanned work **requires** `/blueprint:deviation` log. If missing, output WARNING but proceed. |
| **LOCKED** | Show alignment section. Unplanned work **BLOCKED** (error) until blueprint amended or deviation logged (if allowed). |

**Unplanned Work Warning (STRICT):**
```
⚠️ WARNING: Unplanned work detected without deviation log.
   Use: /blueprint:deviation "reason" to document intentional divergence.
```

**Unplanned Work Block (LOCKED):**
```
⛔ BLOCKED: Unplanned work not allowed in LOCKED mode.
   Options:
   1. /blueprint:amend to add this work to blueprint
   2. /blueprint:enforce advisory to temporarily lower enforcement
   3. Revert changes and stay on blueprint
```

### 5. Auto-Progress Prompting

In STANDARD and HEAVY continuity modes, if an Active Blueprint is present with enforcement >= ADVISORY:

1.  **Detect:** When `/snap` runs, check if any *aligned* work items map to blueprint tasks that are NOT yet marked `complete`.
2.  **Prompt:** If high confidence of completion, include an interactive hint in the checkpoint output.

**Checkpoint Hint Format:**
```
├── Aligned Tasks:
│   ✅ T3.1 — Design auto-progress prompt flow
│      └─ 💡 Task appears complete. Run: /blueprint:complete T3.1
```

**Behavior:**
-   Non-blocking.
-   Informational only.
-   Reduces friction by reminding operator to close the loop.

### 6. Repo Boundary Activity Logging

When ZEOS_MODULE_009_REPO_BOUNDARY is active, checkpoint entries include boundary activity:

**Checkpoint Boundary Section Format:**

```
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

**When to Include:**

| Condition | Include Boundary Section |
|-----------|--------------------------|
| Boundary violations (warned or blocked) | Always |
| Allow-list grants this session | Always |
| No violations, no grants | Omit section (clean session) |
| Enforcement = OFF | Omit section (no tracking) |

**Journal Audit Trail:**

For HEAVY mode, all boundary events logged individually:

```
### Boundary Events

| Time | Action | Path |
|------|--------|------|
| 04:20:00 | WARNED | /projects/mcpify/README.md |
| 04:25:00 | ALLOWED | /projects/zeos/kernel/BOOT.md (allow-list) |
```

**Reference:** `modules/constraints/ZEOS_MODULE_009_REPO_BOUNDARY.md`

---

## Integration with Shell Protocol

### /snap Redefinition

```
OLD MEANING: "Save your work" (required for persistence)
NEW MEANING: "Mark this milestone" (semantic marker, optional)

Behavior:
  - Forces immediate buffer flush
  - Adds milestone marker to journal entry
  - Operator note becomes checkpoint title
  - Still available in all modes (including OFF)
```

**Checkpoint Output Format:**

```
═══════════════════════════════════════════════════════════════
CHECKPOINT SAVED
═══════════════════════════════════════════════════════════════
Commit: [short_sha]
Delta: [N] actions documented
Focus: [current work in one line]

Blueprint Alignment: {BLUEPRINT_NAME} {ICON} {LEVEL}
├── Aligned Tasks:
│   ✅ {task_id} — {task_name} (work matches task)
├── Unplanned Work:
│   ⚠️ {description} (not in blueprint)
└── Progress: {N}/{M} tasks complete ({P}%)
═══════════════════════════════════════════════════════════════
```

### /end Behavior

```
On /end command:
  1. Flush all buffered deltas (mandatory)
  2. Write final journal entry with status: COMPLETE
  3. Include next_action_primer for resumption
  4. Commit to persistence layer
  
This is unchanged — /end always persists final state.
```

### New Command: +continuity

```
+continuity              # Show current mode and settings
+continuity HEAVY        # Change mode for this session
+continuity --status     # Show buffer state and pending writes
```

---

## Agent Behavior Requirements

### On Boot

```
1. Load continuity settings from Profile
2. Check for app-level override (if app session)
3. Check for session flag override (--continuity=X)
4. Initialize buffer with resolved mode
5. Begin event capture per mode specification
```

### During Session

```
1. Monitor for trigger events per active mode
2. Append to buffer on each trigger
3. Flush on debounce timer or threshold
4. Pre-scan all writes for credentials
5. Maintain coherent unit rule (don't flush mid-operation)
6. **[STANDARD/HEAVY] Track auto-checkpoint triggers**
7. **[STANDARD/HEAVY] Execute auto-checkpoint when triggered**
```

### Auto-Checkpoint Monitoring (STANDARD/HEAVY modes)

```
EVERY MESSAGE PROCESSED:
  1. Check time since last checkpoint
     IF elapsed >= auto_checkpoint_interval AND meaningful_work:
       → TRIGGER auto-checkpoint
  
  2. Check activity count
     IF (file_changes + tool_calls) >= activity_threshold:
       → TRIGGER auto-checkpoint
  
  3. Check context usage (if detectable)
     IF context_usage >= 80%:
       → TRIGGER auto-checkpoint + OUTPUT warning
  
  4. Check artifact completion
     IF major_artifact_just_completed:
       → TRIGGER auto-checkpoint

ON TRIGGER:
  1. Verify coherent unit complete
  2. Execute silent checkpoint (Bridge Rule)
  3. Commit with [AUTO] prefix
  4. Reset counters (time, activity)
  5. Continue without user notification (unless context warning)
```


### Coherent Unit Rule

```
DO NOT flush buffer while:
  - Mid-file creation (wait for file complete)
  - Mid-function implementation (wait for function complete)
  - Mid-procedure definition (wait for procedure complete)

REASON: Partial state in journal creates confusion on resume.
```

---

## Journal Entry Format (Autosave)

```yaml
---
type: autosave
timestamp: 2025-12-29T05:30:00Z
mode: STANDARD
trigger: periodic_pulse
---

## Work Since Last Save

### Artifacts
- Created /path/to/file — brief description
- Modified /path/to/other — what changed

### Decisions
- Chose X over Y (rationale)

### Current Focus
What the agent is working on now.

## Blueprint Alignment (if active)

| Work Performed | Blueprint Task | Status |
|----------------|----------------|--------|
| Implemented X | T1.2 | ✅ Aligned |
| Refactored Y | — | ⚠️ Unplanned |

Progress: 4/6 tasks (67%)
```

---

## Validation Criteria

A session correctly implements Continuity Protocol if:

1. Mode is resolved correctly from Profile → App → Session hierarchy
2. Events are captured per mode specification
3. Buffer flushes respect debounce rules
4. Credentials are NEVER written to journal
5. /snap adds milestone marker without disrupting flow
6. /end always flushes complete state
7. OFF mode still logs session metadata

---

## Failure Modes

| Failure | Cause | Recovery |
|---------|-------|----------|
| `CREDENTIAL_DETECTED` | Secret in buffer | Redact and continue |
| `FLUSH_FAILED` | GitHub API error | Retry 3x, then output journal as text for manual save |
| `BUFFER_OVERFLOW` | Too many events without flush | Force flush, warn operator |
| `MODE_CONFLICT` | App tries to escalate beyond profile | Reject, use profile mode |

---

## Version History

**Full history:** [docs/changelogs/CONTINUITY_PROTOCOL_CHANGELOG.md](../../docs/changelogs/CONTINUITY_PROTOCOL_CHANGELOG.md)

---

*Module: Continuity Protocol v3.3.0*
*"Persistence is continuous, not ceremonial."*

