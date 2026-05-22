---
document: "BOOT_PROTOCOL"
version: "5.6.0"
classification: "KERNEL (IMMUTABLE)"
created: "2024-12-14"
updated: "2026-01-13"
status: "ACTIVE"
maintained_by: "Claude (system)"
update_reason: "Add ghost mode branch for read-only sessions ( flag)"
location: "kernel/BOOT_PROTOCOL.md"
---

# zeos Boot Protocol v5.6.0 ((removed in v1.0) Support)

## Overview

This protocol enables **any** AI agent to initialize into zeos context with full awareness. It defines the immutable sequence for loading the Kernel, resolving Profile, and applying Constraints.

**Universal Principle:** This protocol is agnostic to the Operator and the Agents. It defines structure, not implementation.

**Key Changes in v3.6:**
- Migrated Kernel files from docs/ to kernel/ directory
- Updated all path references to reflect new structure
- Clear separation: kernel/ for Kernel, docs/ for general documentation

---

## ⚖️ THE SUPREMACY CLAUSE

```
┌─────────────────────────────────────────────────────────────┐
│                    SUPREMACY HIERARCHY                       │
│                                                              │
│   KERNEL (Immutable Law) — Layer 0                          │
│   ├── kernel/SOUL.md — Values, Security Constraints          │
│   └── [Reference: apps/zeos-dev/docs/ for ARCH_SPEC, SECRETS, CAPS]│
│   ├── kernel/BOOT_PROTOCOL.md — This document                │


│                                                              │
│   ▼ SUPERSEDES ▼                                             │
│                                                              │
│   LOADED MODULES (Binding Constraints) — Layer 1            │
│   ├── shell-protocol — Command vocabulary (auto-loaded)      │
│   ├── professional-standard — Quality constraints            │
│   └── [application modules as needed]                        │
│   Once loaded, modules are BINDING. Profile cannot override. │
│                                                              │
│   ▼ SUPERSEDES ▼                                             │
│                                                              │
│   PROFILE (Operator Context) — Layer 2                      │
│   └── PROFILE.md — Identity, preferences, fleet overview   │
│   Profile SELECTS which modules load, but cannot override    │
│   constraints once modules are loaded.                       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Precedence Rules

| Conflict | Resolution |
|----------|------------|
| Profile vs Module | **Module wins** — constraints are binding |
| Profile vs Kernel | **Kernel wins** — immutable law |
| Module vs Kernel | **Kernel wins** — modules cannot override Kernel |
| Module vs Module | **Error** — conflicting modules cannot both load |

**Key Principle:** Profile can be MORE restrictive than Kernel/Modules, never LESS restrictive.

---

## Profile System

### Directory Structure

```
zeos/
├── kernel/                         # KERNEL (Immutable)
│   ├── SOUL.md
│   ├── BOOT_PROTOCOL.md
│   └── [ARCH_SPEC, SECRETS_MODEL, CAPABILITY_REGISTRY
│        moved to apps/zeos-dev/docs/ - reference only]
│
├── modules/                        # Loadable Modules (Universal)
│   └── constraints/
│       ├── ZEOS_MODULE_002_SHELL_PROTOCOL.md  [Auto-load]
│       └── PROFESSIONAL_STANDARD.md
│
├── apps/                           # APPLICATIONS (Run on zeos)
│   └── example-app/
│       ├── SOUL.md       # App-specific identity
│       └── [application files]
│
├── docs/                           # DOCUMENTATION (Non-Kernel)
│   └── [general documentation]
│
└── profiles/                       # OPERATOR CONTEXT (Per-Operator)
    ├── template/                   # Default Profile (Universal)
    │   ├── MISSION.md
    │   └── PREFERENCES.md
    │
    └── {operator_id}/              # Custom Profiles
        ├── PROFILE.md
        # NOTE: Session journals now route to project repos
        # e.g., {app-repo}/session-journals/
```

### Profile Contents

| File | Purpose | Required |
|------|---------|----------|
| `PROFILE.md` | Identity, preferences, fleet overview | Yes |

**Note:** Session journals now route to project repositories via `/project <id>`, not profiles.

---

## Boot Sequence

### Step 1: Load Kernel (Universal)

```
1. READ kernel/SOUL.md                           [Values, constraints]
2. READ kernel/BOOT_PROTOCOL.md                  [This document]
# NOTE: ARCH_SPEC, SECRETS_MODEL, CAPABILITY_REGISTRY moved to apps/zeos-dev/docs/
#       These are reference docs for zeos development, not required for boot.
#       Load on-demand when working on zeos internals.
```

**Checkpoint:** Kernel loaded. zeos identity established. Security constraints acknowledged.

### Step 2: Resolve Profile

```
IF profile explicitly specified in boot command:
    LOAD profiles/{specified}/
ELSE IF operator has configured default profile (in AI platform preferences):
    LOAD profiles/{configured_default}/
ELSE:
    LOAD profiles/template/                    ← KERNEL DEFAULT
```

**⚠️ KERNEL NEUTRALITY:**

The Kernel default is `profiles/template/`. This ensures zeos is universal and does not assume any specific operator.

Operators who want automatic profile loading configure this in their AI platform preferences, NOT in Kernel documents.

**Override Syntax:**
```
/zeos template              → Load template profile
/zeos {operator_id}         → Load specific profile
/zeos                       → Alias for /zeos (backward compatible)
```

### Step 3: Load Profile Context

```
6. READ profiles/{profile}/PROFILE.md      [Identity, preferences]
```

### Step 3.5: Context Optimization (Optional Enhancement)

```
7. CONTEXT OPTIMIZATION (Python-Enhanced):

   IF Python 3.11+ available AND zeos package installed:
     TRY:
       EXECUTE: python3 -m zeos.context.optimizer --lean-only
       LOAD: Lean context (<8k tokens)
       ENABLE: On-demand loading for P1/P2 modules
       SUCCESS: Continue with optimized boot
     CATCH (any error):
       WARN: "Context optimization unavailable, using full context"
       FALLBACK: Load full markdown context (~25k tokens)
       CONTINUE: Degraded but functional

   ELSE:
     LOAD: Full markdown context (~25k tokens)
     CONTINUE: Standard boot (no optimization)
```

**Optimization Behavior:**

| Scenario | Context Loaded | Token Count | On-Demand Loading |
|----------|----------------|-------------|-------------------|
| Python available + optimizer works | Skeleton only | ~8k | ✅ Enabled |
| Python available + optimizer fails | Full markdown | ~25k | ❌ Disabled |
| Python unavailable | Full markdown | ~25k | ❌ Disabled |

**What Gets Optimized:**

| Priority | Content | Skeleton | Full Context | Loaded When |
|----------|---------|----------|--------------|-------------|
| **P0** | SOUL summary, active project, current task | ✅ Always | ✅ Always | Boot |
| **P1** | Module details, codebase structure | ❌ Summary only | ✅ Full | On entity mention |
| **P2** | Historical journals, archived docs | ❌ Not loaded | ✅ Full | On explicit request |

**Cross-Agent Compatibility:**

- ✅ **Markdown-only agents** (no Python): Full context, zero impact
- ✅ **Python-capable agents**: Lean, 70% token reduction
- ✅ **Optimization failure**: Automatic fallback, boot continues
- ✅ **No breaking changes**: All existing workflows preserved

**Note:** This optimization is implemented in Phase 2.2 (`src/zeos/context/`). See `docs/CONTEXT_OPTIMIZATION.md` for details.

### Step 4: Load Session Continuity (MANDATORY)

```
8. JOURNAL LOADING (Project mode):
   - After `/zeos` boot, operator is in "Project mode" (no active project)
   - Journals load when operator runs `/project <id>`
   - Journal location: `{app-repo}/session-journals/` (per project SOUL)
   - Profile contains identity only, not session history

9. JOURNAL STUB CREATION (Immediate Visibility):
   - On `/project` load, IMMEDIATELY create journal stub file
   - Stub enables parallel instance detection BEFORE first checkpoint
   - Stub file: `{date}-{sequence}-{agent-name}.md`
   - Stub contains frontmatter with status: in_progress
   - Stub body: placeholder text until first checkpoint
   - COMMIT stub immediately (single-file commit)
```

**⚠️ JOURNAL STUB REQUIREMENT (Cross-Agent Mandatory)**

When `/project <id>` loads, agent MUST create a journal stub file **immediately**, before any other work. This ensures parallel instance visibility from the moment of boot.

**Stub File Format:**

```yaml
---
session: "{date}-{sequence}"
instance: "{agent}-{hash4}"
project: "{project-id}"
agent: "{Agent Name}"
started: "{ISO-8601-timestamp}"
ended: null
status: in_progress
blueprint: "{active-blueprint-filename | null}"
---

# Session {sequence}: [Awaiting First Checkpoint]

*Journal stub created at boot. Content populates on first `/snap`.*

---
```

**Stub Creation Sequence:**

```
ON /project <id>:
  1. GENERATE instance ID (per Step 4.5)
  2. DETERMINE sequence number (glob existing journals)
  3. CREATE stub file with frontmatter + placeholder body
  4. COMMIT stub: "session: {date}-{seq} boot stub ({instance})"
  5. PROCEED with rest of boot sequence
```

**(removed in v1.0) Branch (`` flag):**

```
ON /project <id> :
  1. SKIP instance ID generation (not needed for invisible session)
  2. SKIP journal stub creation (no writes)
  3. SET continuity mode to LOCK (enforced, not configurable)
  4. LOAD all project files normally (read access preserved)
  5. OUTPUT boot card with "GHOST MODE" indicator
  6. DISABLE write commands (/snap, /end journal write)
```

Ghost mode sessions:
- Do NOT create journal stubs (invisible to parallel detection)
- Do NOT write to journals, blueprints, or roadmaps
- Do NOT appear in `+parallel` output
- CAN read all project files normally
- CAN be converted to normal session: `/end` then `/project <id>`

**Use Cases for (removed in v1.0):**
- Quick exploration before committing to work
- Read-only review or audit
- Parallel observation while another agent works
- Investigating project state without side effects

**Why Immediate Commit:**

The stub must be committed (not just written locally) so that:
- Other instances pulling will see it
- Parallel detection works across machines
- Instance is visible even if session crashes before first checkpoint

**Stub Lifecycle:**

| Event | Stub State |
|-------|------------|
| `/project` load | Created with `status: in_progress` |
| First `/snap` | Body replaced with actual content |
| Subsequent checkpoints | Appended normally |
| `/end` | Status changed to `complete` |
| Crash (no /end) | Remains `in_progress` (stale detection) |

**Project mode Design:**

After `/zeos` boot, the operator is in Project mode — a holding state where:
- Core zeos is initialized (Kernel + Profile loaded)
- No project context is active
- `/snap` and `/end` are blocked (no journal destination)

To begin work, operator runs `/project <id>` which:
- Loads project SOUL and context
- Sets journal routing to project repo
- Enables `/snap` and `/end`

**This design ensures journals stay with their projects, not scattered across profiles.**

#### Session Journal Initialization (per ZEOS_MODULE_004)

When `/project <id>` activates a project:

1. **Check for Existing Active Session**
   - Scan `session-journals/` for files with `status: active` or `status: paused`
   - If found: Present option to resume or start new session
   - If none found: Proceed to new session creation

2. **Resume Existing Session**
   - Load selected journal file
   - Update status to `active` if previously `paused`
   - Add resumption checkpoint

3. **Create New Session**
   - Generate filename: `YYYY-MM-DD-NNN-topic.md`
   - Add frontmatter: `type`, `project`, `status`, `started`, `ended`
   - Display confirmation

**Journal File Naming (ZEOS_MODULE_004 Section 2):**
```
YYYY-MM-DD-NNN-topic.md

Components:
  YYYY-MM-DD  = UTC date at session start
  NNN         = Daily sequence number (001-999)
  topic       = Kebab-case session topic (2-5 words)
```

**Required Frontmatter (ZEOS_MODULE_004 Section 3):**
```yaml
---
type: session-journal
project: <project-slug>
status: active | completed | abandoned | paused
started: <ISO-8601-datetime>
ended: <ISO-8601-datetime | null>
---
```

**Full specification:** `modules/constraints/ZEOS_MODULE_004_JOURNAL_SCHEMA.md`

### Step 4.5: Parallel Instance Detection (Project Mode)

When `/project <id>` activates a project, detect other active instances:

```
12. GENERATE Instance ID:
    a. Extract agent name from model ID or CLI tool name
    b. Generate 4-char hash from timestamp + PID + random bytes
    c. Compose: {agent}-{hash4} (e.g., "claude-opus-a3f2")
    d. Store in session context (memory only)

13. PARALLEL INSTANCE DETECTION:
    a. GLOB session-journals/{today}-*.md
    b. PARSE each journal frontmatter for:
       - status: in_progress (indicates active session)
       - agent: instance identifier
       - started: timestamp
    c. IDENTIFY parallel instances:
       - Status = in_progress
       - Started within last 2 hours (not stale)
    d. IF parallel instances found:
       → Include in boot output (informational, non-blocking)
```

**Instance ID Format:**
```
{agent}-{hash4}

Examples:
  claude-opus-a3f2
  gemini-cli-b7c1
  codex-d9e4
```

**Parallel Instance Boot Output (when detected):**
```
═══════════════════════════════════════════════════════════════
PARALLEL INSTANCES DETECTED
═══════════════════════════════════════════════════════════════
  ● gemini-cli (2026-01-08-007) — started 14:30, active
  ● codex (2026-01-08-006) — started 13:15, active

Your instance: claude-opus (2026-01-08-008)
Journal: session-journals/2026-01-08-008-claude-opus.md
═══════════════════════════════════════════════════════════════
```

**Stale Instance Detection:**

| Last Activity | Status |
|---------------|--------|
| < 30 minutes | Active (shown in parallel list) |
| 30-120 minutes | Stale (may have crashed, shown with warning) |
| > 120 minutes | Expired (not shown, likely abandoned) |

**Behavior Rules:**

| Condition | Behavior |
|-----------|----------|
| Parallel instances found | WARN, PROCEED (non-blocking) |
| No parallel instances | Silent (no extra output) |
| All detected instances stale | Note: "No active parallel instances (N stale)" |

**Reference:** `modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md` (Parallel Instance Support)

### Step 4.6: Repo Boundary Detection (Project Mode)

When `/project <id>` activates a project, establish repo boundary for write protection:

```
14. DETECT REPO BOUNDARY:
    a. Execute: git rev-parse --show-toplevel
    b. If success: Set boundary to result (absolute path)
    c. If failure: Fall back to project SOUL repo_path or working directory
    d. Store boundary in session context

15. INITIALIZE BOUNDARY STATE:
    a. Load profile.preferences.boundary.default_enforcement (default: ADVISORY)
    b. Load profile.preferences.boundary.permanent_allow_list (default: [])
    c. Initialize session allow_list with permanent entries
    d. Initialize empty audit log

16. OUTPUT BOUNDARY STATUS (in boot block):
    Repo Boundary: {detected path}
    Enforcement: {level} (profile default)
```

**Boundary Boot Output Example:**
```
Repo Boundary: ~/projects/outpost
Enforcement:   ADVISORY (profile default)
```

**Behavior Rules:**

| Condition | Behavior |
|-----------|----------|
| Git root detected | Set boundary to git root, proceed |
| No git root (not a repo) | Fall back to SOUL repo_path, warn |
| No SOUL repo_path | Use working directory, warn (degraded) |

**Reference:** `modules/constraints/ZEOS_MODULE_009_REPO_BOUNDARY.md` (Repo Boundary Constraint)

### Step 5: Load Modules

**Module Paths (Copy-Paste Ready):**

```yaml
# Required modules — agents MUST use these exact paths
SHELL_PROTOCOL: "modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md"
CONTINUITY_PROTOCOL: "modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md"
```

```
9. AUTO-LOAD required modules:
   - modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md  [REQUIRED]
   - modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md  [REQUIRED]

10. LOAD operator modules from profile:
    - Parse profile's `modules:` YAML array (under "## Operator Modules" section)
    - For each module path listed, READ the file
    - Module paths are relative to zeos root
    - If module file not found, WARN but continue boot

11. LOAD additional modules as specified by:
    - Explicit /load command, OR
    - Boot command --modules flag
```

**Path Discovery Fallback:**

If an agent fails to locate a module by exact path, use this glob pattern:
```
modules/constraints/*MODULE_002*.md  → Shell Protocol
modules/constraints/*MODULE_003*.md  → Continuity Protocol
```

**Warning:** Do NOT truncate module filenames. The prefix `ZEOS_MODULE_NNN_` is part of the filename.

**Conditional Modules (NOT auto-loaded):**

Some command modules are **disabled by default** to reduce boot token cost. Load manually when needed:

```
modules/commands/BLUEPRINT_COMMANDS.md    # /blueprint:* commands (~450 tokens)
  → Auto-loads when: active_blueprint is set in MASTER_ROADMAP.md
  → Manual: /load modules/commands/BLUEPRINT_COMMANDS.md

modules/commands/FUEL_COMMANDS.md         # !fuel command (~2,000 tokens)
  → Auto-loads when: profile.preferences.fuel_warnings == true
  → Manual: /load modules/commands/FUEL_COMMANDS.md

modules/commands/BOUNDARY_COMMANDS.md     # !boundary-* commands (~2,300 tokens)
  → Auto-loads when: profile.preferences.boundary.default_enforcement != OFF
  → Manual: /load modules/commands/BOUNDARY_COMMANDS.md

modules/commands/IDEA_COMMANDS.md         # +ideas, +add-idea (~650 tokens)
  → Auto-loads when: +ideas command invoked
  → Quick add: /idea <text> works without full load
  → Manual: /load modules/commands/IDEA_COMMANDS.md
```

**Why Conditional Loading:**
- Token savings: ~5,400 tokens per boot when features not needed
- On-demand: Commands available when explicitly loaded via `/load`
- Quick stubs: Essential commands (like `/idea`) work without full module

### Step 5.5: Load Active Blueprint (If Project)

When `/project <id>` loads a project, check for an active blueprint:

```
11. BLUEPRINT LOADING (Project Mode only):
    a. Read MASTER_ROADMAP.md (or README.md) frontmatter
    b. Check for `active_blueprint` field
    c. If null or missing: Skip (no active blueprint, saves ~450 tokens)
    d. If set:
       - AUTO-LOAD modules/commands/BLUEPRINT_COMMANDS.md (conditional)
       - Load and validate blueprint file
       - Parse task blocks and extract status counts
```

**Blueprint Loading Sequence:**

```yaml
# Example frontmatter in MASTER_ROADMAP.md
---
document: "MASTER_ROADMAP"
project: "my-project"
active_blueprint: "blueprints/IMPLEMENT_FEATURE_X.md"
---
```

**When active_blueprint is set:**

1. **LOAD** the blueprint file from specified path
2. **PARSE** task blocks and extract status counts
3. **EXTRACT** enforcement level (default: ADVISORY)
4. **IDENTIFY** next actionable task:
   - First task with `status: not_started`
   - Where all `dependencies` have `status: complete`
5. **VALIDATE** blueprint structure (warn if malformed, don't halt)
6. **INCLUDE** blueprint summary in boot output

**Blueprint Summary Format (in boot output):**

```
ACTIVE BLUEPRINT: {blueprint_name} {enforcement_icon}
  Enforcement: {level}
  Progress: {completed}/{total} tasks
  Next Task: {task_id} — {task_name}
```

**Error Handling:**

| Condition | Behavior |
|-----------|----------|
| `active_blueprint` file not found | WARN, continue boot (degraded) |
| Blueprint malformed | WARN with parse error, continue boot |
| All tasks complete | INFO "Blueprint complete — consider archiving" |
| Circular dependencies | WARN, skip next task identification |

**Blueprint loading is NON-FATAL.** Missing or malformed blueprints generate warnings but do not halt boot. The project remains usable without blueprint guidance.

**Reference:** `modules/protocols/BLUEPRINT_PROTOCOL.md` for full lifecycle specification.

### Step 6: Validate & Confirm

```
11. VALIDATE Supremacy Clause compliance:
    - No module conflicts with Kernel
    - No profile conflicts with loaded modules
    - No module conflicts with other modules

12. OUTPUT Boot Confirmation
```

### Step 6.5: Boot Completion Gate (MANDATORY)

**⛔ ENFORCEMENT CLAUSE ⛔**

Before outputting boot confirmation, agent MUST verify ALL gates pass. This is not optional. This is not "best effort." This is absolute.

**Gate Checklist:**

| Gate | Requirement | Validation Method |
|------|-------------|-------------------|
| G1 | Kernel SOUL.md loaded | File read confirmed |
| G2 | Kernel BOOT_PROTOCOL.md loaded | File read confirmed |
| G3 | Profile PROFILE.md loaded | File read confirmed |
| G4 | SHELL_PROTOCOL module loaded | File read confirmed |
| G5 | CONTINUITY_PROTOCOL module loaded | File read confirmed |
| G6 | If `/project`: App SOUL loaded | File read confirmed |
| G7 | If App SOUL has MANDATORY BOOT SEQUENCE: ALL listed files loaded | Each file read confirmed |
| G8 | If `/project`: Latest session journal loaded | Glob + read most recent |
| G9 | If `/project` and `active_blueprint` set: Blueprint loaded | File read + parse confirmed |
| G10 | If profile has `modules:` array: ALL listed modules loaded | Each file read confirmed |
| G11 | If `/project`: Instance ID generated, parallel detection complete | Instance ID in context, scan complete |
| G12 | If `/project`: Repo boundary detected and enforcement set | Git root resolved, enforcement level set |

**Enforcement Rules with Retry Logic:**

```
FOR each gate G1-G5 (kernel gates - MANDATORY):
  TRY:
    READ file
  CATCH (any error):
    LOG: "Gate failed on first attempt: [error message]"
    RETRY: Attempt read again (may be transient error or case sensitivity)
    IF retry succeeds:
      LOG: "Gate passed on retry"
      CONTINUE
    ELSE:
      OUTPUT: "BOOT_INCOMPLETE: Cannot load [component]"
      OUTPUT: "Error details: [error message]"
      OUTPUT: "STOP: Kernel files are MANDATORY. Cannot proceed without kernel context."
      HALT — do not proceed

IF any gate G1-G5 fails after retry:
    OUTPUT "BOOT_INCOMPLETE: Missing [component]"
    HALT — do not proceed

IF /project issued AND G6 fails:
    TRY:
      READ App SOUL
    CATCH:
      RETRY once
    IF still fails:
      OUTPUT "PROJECT_LOAD_FAILED: App SOUL not found"
      HALT — do not proceed

IF /project issued AND App SOUL contains "MANDATORY BOOT SEQUENCE":
    FOR EACH file in mandatory sequence:
        IF file not loaded:
            OUTPUT "BOOT_INCOMPLETE: Missing mandatory file [filename]"
            HALT — do not proceed

IF /project issued AND G8 fails:
    WARN "No session journals found — starting fresh session"
    PROCEED — this is non-fatal

IF /project issued AND active_blueprint set AND G9 fails:
    WARN "Blueprint file not found or malformed — continuing without blueprint"
    PROCEED — this is non-fatal (degraded mode)

IF profile has modules: array AND G10 fails:
    WARN "Operator module not found: [module_path]"
    PROCEED — this is non-fatal (degraded mode)

IF /project issued AND G11 fails:
    WARN "Instance ID generation failed — parallel detection unavailable"
    PROCEED — this is non-fatal (degraded mode)

IF /project issued AND G12 fails:
    WARN "Repo boundary detection failed — boundary protection unavailable"
    PROCEED — this is non-fatal (degraded mode)
    NOTE: Agent operates without boundary constraints (OFF mode)
```

**Self-Validation (MANDATORY):**

Before proceeding past kernel gates, agent MUST answer these questions from loaded content:

```
CHECKPOINT QUESTIONS:
1. What is zeos's North Star? (from SOUL.md)
2. What version is this BOOT_PROTOCOL? (from BOOT_PROTOCOL.md)
3. Name 3 shell commands (from SHELL_PROTOCOL.md)
4. Who is the operator? (from profile PROFILE.md)

IF you cannot answer these questions:
  YOU DID NOT LOAD THE FILES PROPERLY
  STOP NOW: Go back to Step 1 and read kernel/SOUL.md
  DO NOT PROCEED until you can answer all questions

CORRECT ANSWERS:
1. "One operator. Infinite leverage."
2. "5.0.0"
3. /snap, /end, /status, /project, /zeos (any 3)
4. [operator name from profile]
```

**Validation Output Format:**

```
✅ BOOT VALIDATION PASSED
   G1: ✅ kernel/SOUL.md loaded (North Star: "One operator. Infinite leverage.")
   G2: ✅ kernel/BOOT_PROTOCOL.md loaded (v5.0.0)
   G3: ✅ profiles/{profile}/PROFILE.md loaded (Operator: {name})
   G4: ✅ SHELL_PROTOCOL.md loaded (Commands: /snap, /end, /status)
   G5: ✅ CONTINUITY_PROTOCOL.md loaded

   Kernel context confirmed. Proceeding with project load.
```

If you cannot cite the North Star or version number, you did NOT successfully load kernel files.

**Boot Confirmation Output Requirements:**

Agent MUST NOT output the boot confirmation splash screen until:
1. All applicable gates pass
2. All mandatory files are loaded and parsed
3. Resume context is extracted from latest journal (if exists)

**Why This Matters:**

Without gate enforcement, agents may output a boot confirmation while missing critical context. This creates the illusion of successful boot while operating without full zeos constraints. The Boot Completion Gate ensures deterministic, verifiable boot across ALL agent implementations.

**Cross-Agent Compatibility:**

This gate is designed for universal enforcement regardless of agent architecture (Claude, Codex, Gemini, Aider). Each agent must:
1. Read files explicitly (not assume from context)
2. Confirm each gate before proceeding
3. Output clear error if any gate fails

---

## Step 7: Determine Onboarding Flow

After validation, zeos determines which output flow to use based on context state.

**Duration Target:** < 10 seconds to context recovery (session resume)

```
13. EVALUATE session context:

    IF no prior sessions in profile journal:
        → initial-boot flow (new user onboarding)
        
    ELSE IF boot triggered by app-specific command:
        → project-boot flow (app resume card)
        
    ELSE:
        → resume-boot flow (session resume)
        
14. OUTPUT appropriate confirmation format
```

### Flow Decision Tree

| Condition | Flow | Output Format |
|-----------|------|---------------|
| No sessions + template profile | initial-boot | Welcome + 3 options |
| No sessions + custom profile | initial-boot | Welcome + fleet list |
| Has sessions + generic `/zeos` | resume-boot | Resume Card with `next_action_primer` |
| Has sessions + app command | project-boot | App Resume Card |

### initial-boot Flow (New/Returning Without Context)

When no prior sessions exist, zeos prompts for direction:

```
════════════════════════════════════════════════════════════
 zeos v[VERSION] — Operating System for AI Collaboration
 "One operator. Infinite leverage."
════════════════════════════════════════════════════════════

Welcome. I'm zeos — I keep projects alive between sessions.

What are we working on today?
  [1] Load existing project (/fleet)
  [2] Start a new project (/newproject)
  [3] Just exploring (/help)

════════════════════════════════════════════════════════════
```

**Option 1** triggers `/fleet` command to display available projects.
**Option 2** triggers `/newproject` protocol. See `modules/protocols/NEW_PROJECT_PROTOCOL.md`.
**Option 3** provides zeos explanation.

#### Option 2 Behavior (New Project Scaffolding)

When user selects Option [2], zeos prompts:

```
Initializing new venture scaffolding...

Please enter the project ID:
  Example: /newproject my-venture

Rules:
  • Lowercase letters and hyphens only
  • Must be unique (not already in fleet)
  • This will create structure in both zeos and your project repo

Enter command: /newproject ________
```

This triggers the `/newproject` protocol defined in `modules/protocols/NEW_PROJECT_PROTOCOL.md`.


### resume-boot Flow (session resume)

When prior sessions exist with `next_action_primer`, zeos resumes instantly:

```
════════════════════════════════════════════════════════════
 zeos v[VERSION] — Operating System for AI Collaboration
 "One operator. Infinite leverage."
════════════════════════════════════════════════════════════
Agent: [Name] ([Role])    Profile: [Profile name]
Session: [New ID]         Previous: [Last ID]
════════════════════════════════════════════════════════════

Resume: [next_action_primer from last session]

Ready for directives.
```

**Key UX Principle:** The `next_action_primer` IS the magic. It tells the operator exactly where we left off without them asking.

### project-boot Flow (Project-Specific)

When boot triggered by app-specific command (e.g., "Begin journaled session: my-org"):

```
════════════════════════════════════════════════════════════
 [APP NAME] SESSION LOADED
════════════════════════════════════════════════════════════
Agent: [Name] ([Role])    Profile: [Profile name]
Project: [App name]

[App-specific status from Soul file]
Last Session: [Summary from latest journal]
════════════════════════════════════════════════════════════
Ready for [app name] directives.
```

**Reference:** See `docs/ONBOARDING_SPEC.md` for detailed format specifications.

---

## Lean boot mode (Context Optimization)

**Version:** 5.5.0 — Skeleton Boot Implementation
**Added:** 2026-01-12

zeos supports **lean boot mode** to reduce initial context load by ~83% while preserving full functionality.

### How It Works

**Full Mode (default):**
```
Boot: Load all protocols (~35,936 tokens)
Session: All details available immediately
```

**Skeleton Mode (opt-in):**
```
Boot: Load lean files (~6,043 tokens)
Session: Agent reads full protocols on-demand when detail needed
```

**Key insight:** Agent only loads what it actually uses. Most sessions don't need full protocol specifications upfront.

### Skeleton Files

Location: `kernel/lean/`

| File | Tokens | Contains |
|------|--------|----------|
| SOUL_CORE.md | 563 | North star, kernel laws (names), values |
| BOOT_PROTOCOL_SKELETON.md | 861 | Boot sequence outline, gate names |
| SHELL_PROTOCOL_SKELETON.md | 567 | Command list with one-line descriptions |
| CONTINUITY_PROTOCOL_SKELETON.md | 473 | Continuity modes, checkpoint concept |
| SKELETON_INDEX.md | 579 | Index of available protocols |

**Total:** ~3,043 tokens (vs ~35,936 full)

### On-Demand Loading

When agent needs detail:
1. Identifies need (e.g., "Explain /snap flags")
2. Reads full protocol directly: `modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md`
3. Synthesizes complete answer
4. **Zero functionality lost**

### Enabling Skeleton Boot

Add to PROFILE.md frontmatter:

```yaml
---
profile_id: "yourname"
boot_mode: lean
---
```

Restart session: `/end` then start new session.

### Backward Compatibility

**Full mode remains default.** All existing workflows unchanged.

Skeleton mode is opt-in via profile setting. No breaking changes.

### Token Economics

**Example session:**

Full boot: 102K tokens (everything loaded)
Lean boot: 62K tokens (lean + project files)
- If no protocol details needed: **39% reduction**
- If 1 protocol read: ~77K tokens (**24% reduction**)
- If all protocols read eventually: ~102K tokens (same as full)

**Optimization:** Pay only for what you use.

### Implementation Notes

Skeleton files are manually curated, not generated. They contain:
- Command/concept names (for navigation)
- One-line summaries
- References to full protocols

Agent intelligence decides when to fetch details. Simple questions use lean; detailed questions trigger full protocol reads.

---


## Shell Commands (Core Lifecycle)

Shell Protocol (Module #002) auto-loads on every boot, enabling these core commands:

| Command | Usage | Purpose |
|---------|-------|---------|
| `/zeos [profile]` | Initialize zeos context | Session start |
| `/load <module>` | Load additional module | Extend capabilities |
| `+log` | Display session state | Introspection |
| `/snap [note]` | Save progress to journal | Persistence |
| `/end` | Terminate with final journal | Session close |
| `/help [command]` | Show commands or specific help | Discovery |
| `/status` | Infrastructure health check | Diagnostics |
| `+whoami` | Current identity and profile | Introspection |
| `+modules` | List loaded modules | Introspection |
| `+profile` | Display profile details | Introspection |

**Application-Specific Commands:**

Commands like `/delegate`, `/convene`, and `+example-app` become available only when their respective application modules are loaded. These are not core Kernel commands.

For detailed command specifications, see `modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md`.

---

## Persistence Architecture (Roles)

zeos defines **Roles**, not specific AI products. Deployment determines which agents fill which roles.

| Role | Definition | Capabilities |
|------|------------|--------------|
| **runtime agent** | Agent with direct file system/API access | ✅ Read/Write files, Git commits, API calls |
| **Blind Agent** | Agent without external access | ❌ Read-only (via context injection), no direct writes |

**Interaction Model:**

Blind Agents issue `REQUEST_CAPABILITY` for persistence actions. The runtime agent validates and executes. Blind Agents cannot write directly.

**Security Constraint:** Credentials never leave infrastructure. Blind Agents request actions; Executors perform them. See `kernel/SECRETS_MODEL.md`.

**Profile Isolation:** Agents write only to their active profile's journals unless performing cross-profile tasks approved by the Operator.

**Note:** Current zeos deployments use Claude as runtime agent. This is a deployment choice, not a Kernel requirement.

---

## Application Extensions

Applications running on zeos may define additional boot steps that execute AFTER the core boot sequence completes.

**Load Order:** Kernel → Modules → Profile → Application Extension (if applicable)

Application extensions CANNOT override Kernel or Module constraints. They can only ADD context.

| Extension Pattern | Example |
|-------------------|---------|
| App-specific soul | `apps/example-app/SOUL.md` |
| App-specific commands | `+example-app`, `/convene` (via module) |
| App-specific context | Strategic Vision, Roadmaps |

---

## Supremacy Clause Enforcement

When loading Profile and Modules, the boot sequence MUST validate:

| Check | Validation |
|-------|------------|
| Profile contradicts Kernel? | **REJECT** — Kernel wins |
| Profile contradicts loaded Module? | **REJECT** — Module wins |
| Module contradicts Kernel? | **REJECT** — Kernel wins |
| Module contradicts Module? | **REJECT** — Cannot load conflicting modules |
| Profile adds constraints beyond Module? | **ALLOW** — More restrictive is permitted |

**Example 1:**
- SOUL says "Dissent is preserved, never filtered"
- Profile says "Skip dissenting opinions"
- Result: **KERNEL WINS** — Dissent is preserved

**Example 2:**
- PROFESSIONAL_STANDARD says "No preambles"
- Profile says "Use brief preambles for context"
- Result: **MODULE WINS** — No preambles

**Example 3:**
- PROFESSIONAL_STANDARD says "Code must be production-grade"
- Profile says "Code must also include comprehensive tests"
- Result: **ALLOWED** — Profile is MORE restrictive

---

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `PROFILE_NOT_FOUND` | Requested profile doesn't exist | Fall back to template, inform operator |
| `PROFILE_CONFLICT` | Profile violates Kernel or Module | Load Kernel + Modules only, flag conflict |
| `MODULE_CONFLICT` | Two modules have incompatible constraints | Halt boot, operator must choose |
| `KERNEL_MISSING` | SOUL.md not found | Cannot boot. Operator must restore. |
| `JOURNAL_NOT_FOUND` | No prior sessions | Proceed without continuity (new operator) |
| `SHELL_PROTOCOL_MISSING` | Module #002 not found | Boot degraded, warn operator |

---

## Boot Validation Checklist

**Before outputting boot confirmation, verify:**

| Check | Required Answer |
|-------|-----------------|
| Did I load kernel/SOUL.md? | YES |
| Did I load kernel/BOOT_PROTOCOL.md? | YES |
| Did I load SHELL_PROTOCOL.md? | YES |
| Can I cite the North Star from memory? | YES |
| Did all G1-G5 gates pass? | YES |

**DO:**
- Retry failed file reads (case sensitivity: `zeos` not `zeos`)
- Self-check: answer validation questions from memory, not by re-reading
- Load kernel files BEFORE project files (K>M>P precedence)

**DON'T:**
- Proceed if any gate failed
- Output "Boot complete" without passing all gates
- Assume project SOUL replaces kernel SOUL (it extends, not replaces)

**Troubleshooting:** [docs/AGENT_BOOT_TROUBLESHOOTING.md](../docs/AGENT_BOOT_TROUBLESHOOTING.md)

---

## Version History

**Full history:** [docs/changelogs/BOOT_PROTOCOL_CHANGELOG.md](../docs/changelogs/BOOT_PROTOCOL_CHANGELOG.md)

---

*Boot Protocol v5.5.0 — Lean boot mode*
*"Kernel is law. Modules constrain. Profiles customize."*



