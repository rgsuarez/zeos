---
module_id: "shell-protocol"
module_type: "constraint"
version: "3.17.0"
created: "2025-12-18"
updated: "2026-02-12"
author: "Claude (system)"
status: "active"
load_priority: 1
dependencies: []
conflicts: []
auto_load: true
authority: "ZIP v0.1 - Operator's Intent 2025-12-18"
update_reason: "Add  flag to /project for read-only sessions"
COMMAND_PREFIX: "+"
---

# Module #002: Shell Protocol

## Purpose

This module defines the **canonical command vocabulary** for zeos operations. It separates the **Control Plane** (system commands) from the **Conversation Plane** (natural dialogue).

**Problem Solved:** Without standardized commands, zeos operations become tribal knowledge. Operators guess at syntax. Agents interpret inconsistently. The system becomes fragile.

**Solution:** Bang commands (`!`) provide unambiguous, machine-parsable instructions that any zeos-aware agent recognizes and executes consistently.

---

## ⚠️ Prefix Change Note

**Effective 2025-12-18:** The command prefix changed from `/` to `!`.

| Old | New | Reason |
|-----|-----|--------|
| `/boot` | `/zeos` | `/` collides with Claude UI (triggers extended thinking) |

The `!` prefix was chosen for:
- Single keystroke
- No known AI platform UI collisions
- Familiar convention (Discord, IRC, bots)

**Recognition rule:** A command is recognized when the first non-whitespace character is `!` and the token matches Shell Protocol vocabulary.

---

## Auto-Load Requirement

This module is **auto-loaded** by BOOT_PROTOCOL. Upon successful boot, the Shell Protocol is ACTIVE. Operators do not need to explicitly load it.

**Rationale:** Command vocabulary is foundational infrastructure, not optional behavior.

---

## Command Specification

### Syntax Rules

```
!<command> [required_arg] [optional_arg]

- Commands are case-insensitive: /zeos = !BOOT = !Boot
- Arguments are space-separated
- Optional arguments use defaults when omitted
- Unrecognized commands return COMMAND_NOT_FOUND with help suggestion
```

---

## Core Commands

### /zeos

**Purpose:** Initialize zeos context into current session (Project mode).

**Aliases:** `/zeos` (DEPRECATED — use `/zeos` instead)

**Canonical Boot Flow:**
```
/zeos                    # Boot zeos into Project mode
/project <project-id>    # Load project context and enable journaling
```
Or combined: `/zeos` followed by `/project <project-id>` in same message.

**Syntax:**
```
/zeos [profile] [--modules=<list>]
```

**Arguments:**
| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| profile | No | `template` (Kernel default) | Profile directory to load |
| --modules | No | `shell-protocol,professional-standard` | Comma-separated module list |

**Examples:**
```
/zeos                           → Boot with operator default profile (Project mode)
/zeos template                  → Boot with template profile
/zeos <operator> --modules=none       → Boot <operator> profile, no extra modules

# Canonical boot flow (recommended):
/zeos
/project example-project             → Full boot into project context

# Legacy (deprecated):
/zeos                           → Still works, but prefer /zeos
```

**Execution:**
1. Load Kernel (SOUL, BOOT_PROTOCOL, ARCH_SPEC)
2. Resolve profile (silent default if omitted)
3. Load profile MISSION.md and PREFERENCES.md
4. Load specified modules
5. Output boot confirmation

**Errors:**
| Error | Cause | Recovery |
|-------|-------|----------|
| PROFILE_NOT_FOUND | Requested profile doesn't exist | Offer template, list available |
| KERNEL_MISSING | SOUL.md not accessible | Cannot boot. Operator must restore. |

**Splash Screen (Required on successful boot):**

```
═══════════════════════════════════════════════════════════════

    ███████ ████████  ███████  ██████ 
       ███  ██       ██    ██ ██      
      ███   ██████   ██    ██  █████  
     ███    ██       ██    ██      ██ 
    ███████ ████████  ███████  ██████  
    
    Operating System for AI Collaboration
    v{VERSION} | Persistence Protocol Active
    
    "Intelligence compounds when memory is externalized"
    
    Docs:    github.com/rgsuarez/zeos
    Support: support@my-org.com
    Web:     my-org.com

═══════════════════════════════════════════════════════════════
```

The splash screen MUST appear on every successful boot. It serves as:
- Brand reinforcement (user sees "zeos" every session)
- Screenshot-ready for demos and documentation
- Version verification at a glance



---


---

### ⛔ BOOT INVIOLABILITY CLAUSE ⛔

**The `/zeos` command is INVIOLABLE.** When `/zeos`, `/zeos`, or any boot-triggering phrase appears in a message, the boot sequence MUST execute FIRST, before any other directive is processed.

**This is not negotiable. This is not contextual. This is absolute.**

**Trigger Patterns (case-insensitive):**
- `/zeos` (PRIMARY — preferred)
- `/zeos` (DEPRECATED alias — still triggers boot)
- `Boot zeos`
- `boot zeos`
- Any regex match: `^/zeos` or `^/zeos` or `(?i)boot\s/zeos`

**Note:** `/zeos` remains functional for backward compatibility but is deprecated. New documentation should use `/zeos`.

**When a trigger is detected:**

1. **STOP** — Do not read further until boot completes
2. **EXECUTE** — Full Boot Protocol v3.6 sequence
3. **CONFIRM** — Output boot confirmation block
4. **THEN** — Process remaining message content

**Competing Language That Does NOT Override Boot:**

| Pattern | Why It Doesn't Override |
|---------|------------------------|
| "IMMEDIATE DIRECTIVE" | Urgency is Layer 1+. Boot is Layer 0. |
| "CRITICAL PRIORITY" | Priority within session, not above session init |
| "P0" / "URGENT" | Same — session-level, not boot-level |
| "FIRST DO THIS" | The first thing is ALWAYS boot |
| Context injection blocks | Context requires boot to be meaningful |

**Boot is Layer 0. Everything else is Layer 1+. Layer 0 always executes first.**

**Why This Matters:**

Without boot, the Agent operates as a generic AI without zeos context. Any work performed pre-boot:
- Lacks Kernel constraints (SOUL.md not loaded)
- Lacks Profile context (MISSION.md not loaded)
- Cannot be journaled properly (no session established)
- Represents a **context death** scenario

The entire purpose of zeos is to prevent context death. Skipping boot defeats the system.

**Failure Mode Documentation (2025-12-21):**

On this date, Claude received a message starting with `/zeos` followed by "OPERATOR CONTEXT INJECTION" and "IMMEDIATE DIRECTIVE" language with a P0 task. Claude prioritized the urgency cues and skipped boot entirely. The task was completed but zeos was never initialized — a fundamental reliability failure. This clause exists to prevent that failure mode from recurring.



### /project

**Purpose:** Boot directly into a project context with proper journal routing.

**Syntax:**
```
/project <app_id> []
```

**Arguments:**
| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| app_id | Yes | — | Application identifier from REGISTRY.json |
|  | No | false | Ghost mode: read-only session, no writes to memory files |

**Examples:**
```
/project zeos-agent              → Boot into zeos Agent research project
/project example-project              → Boot into Example Corp
/project example-game         → Boot into example-game: Reborn
/project zero-echelon            → Boot into my-org
/project zeos-dev         → Read-only exploration, no journal writes
```

### (removed in v1.0) ()

**Purpose:** Boot into a project for exploration or review without writing any memory artifacts.

**When `` is specified:**
1. **NO journal stub created** — Session is invisible to parallel detection
2. **Continuity mode set to LOCK** — All writes disabled
3. **`/snap` disabled** — Returns error "Ghost mode: writes disabled"
4. **`/end` simplified** — No journal write, just session termination
5. **Full read access** — All project files readable normally

**Use Cases:**
- Reviewing project state without polluting journals
- Quick exploration before deciding to commit to a session
- Read-only audits or code review
- Parallel review while another agent is actively working

**Boot Output ((removed in v1.0)):**
```
═══════════════════════════════════════════════════════════════
{APP NAME} SESSION LOADED (GHOST MODE)
═══════════════════════════════════════════════════════════════
Mode: GHOST (read-only) — No writes to journals, blueprints, or roadmaps
...
═══════════════════════════════════════════════════════════════
```

**Constraints:**
- Ghost sessions do NOT appear in `+parallel` output (no stub = invisible)
- Ghost sessions cannot modify protected files (enforced, not advisory)
- To convert ghost → normal: `/end` then `/project <id>` without 

**Execution:**
1. Look up `app_id` in `~/.zeos/apps/REGISTRY.json`
2. Load Kernel (SOUL, BOOT_PROTOCOL, ARCH_SPEC) — same as `/zeos`
3. Load Profile (MISSION.md, PREFERENCES.md) — same as `/zeos`
4. Load App SOUL file from `~/.zeos/souls/{app_id}/SOUL.md`
5. **MANDATORY BOOT SEQUENCE ENFORCEMENT** (see below)
6. Load latest session journal from `~/.zeos/journals/<app_id>/`
7. Journal routing is resolved by `app_id` to `~/.zeos/journals/<app_id>/`
8. Output App Resume Card with context from latest journal

### Boot Verification Requirement (Cross-Agent Enforcement)

**⛔ This is MANDATORY for all agents. ⛔**

After loading App SOUL (step 4), agent MUST:

1. **PARSE** the App SOUL for a "MANDATORY BOOT SEQUENCE" section
2. **IF FOUND**: Load EACH file listed in order, confirming each read
3. **GLOB** the journals directory: `~/.zeos/journals/<app_id>/*.md`
4. **LOAD** the most recent journal file (by filename sort, descending)
5. **EXTRACT** resume context: `next_action_primer`, last checkpoint, current phase
6. **OUTPUT** boot card ONLY after ALL files confirmed loaded

**Failure Behavior:**

```
IF App SOUL has MANDATORY BOOT SEQUENCE:
    FOR EACH file in sequence:
        READ file
        IF read fails:
            OUTPUT "BOOT_INCOMPLETE: Missing [filename] from mandatory sequence"
            HALT — do not output boot card

IF journals directory empty:
    WARN "No prior sessions — starting fresh"
    PROCEED — this is non-fatal

IF journals exist but latest cannot be read:
    WARN "Could not load latest journal — resume context unavailable"
    PROCEED — this is non-fatal
```

**Why This Exists:**

Different AI agents (Claude, Codex, Gemini, Aider) interpret "load" differently. Some agents may assume context from prior messages; others may skip optional-seeming steps. This explicit verification requirement ensures:

- Every agent reads the same files
- Boot output is deterministic
- Resume cards contain actual journal context, not guesses
- Cross-agent parity: Codex boots identically to Claude

**Reference:** BOOT_PROTOCOL.md Step 6.5 (Boot Completion Gate)

**Journal Routing:**

The `/project` command sets the active journal destination based on the app's SOUL file:
- All `/snap` writes go to `~/.zeos/journals/<app_id>/`
- All `/end` writes go to `~/.zeos/journals/<app_id>/`
- Profiles do not have journals; all journaling routes to project repos

**Resume Card Format:**
```
═══════════════════════════════════════════════════════════════
{APP NAME} SESSION LOADED
═══════════════════════════════════════════════════════════════
Agent: Claude (system)
Profile: {profile}
Application: {App Name}

[App-specific status from SOUL file]
Journal Routing: ~/.zeos/journals/<app_id>/
Last Session: [Summary from latest journal]
═══════════════════════════════════════════════════════════════
Shell commands active: /snap, /end, +log, /status, /help
Ready for {App Name} directives.
```

**Errors:**
| Error | Cause | Recovery |
|-------|-------|----------|
| APP_NOT_FOUND | app_id not in REGISTRY.json | Run `/fleet` to see available apps |
| SOUL_MISSING | App SOUL file not found | Run `/newproject` to scaffold |
| REPO_UNREACHABLE | Cannot access app repository | Check GitHub permissions |

**Relationship to /zeos:**

| Command | Boots Into | Journal Location |
|---------|------------|------------------|
| `/zeos` | Project mode (no active project) | None — use `/project <id>` to enable journaling |
| `/project <id>` | Application context | `~/.zeos/journals/<app_id>/` |

**Note:** `/project` is the preferred way to start app sessions. The verbose phrase "Begin journaled session: {App Name}" in user preferences is deprecated but still supported for backward compatibility.

---

### /newproject

**Purpose:** Scaffold a new project in the zeos scaffolding system.

**Syntax:**
```
/newproject <project_id> [--repo=<github_url>] [--public] [--aws=<account_id>]
```

**Arguments:**
| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| project_id | Yes | — | Unique identifier (lowercase, hyphens only) |
| --repo | No | Auto-create | GitHub repo URL. If omitted, creates private repo. |
| --public | No | false | Make created repo public (default is private) |
| --aws | No | null | AWS account ID if project has dedicated infrastructure |

**Examples:**
```
/newproject my-venture                          → Creates private repo, scaffolds
/newproject my-venture --repo=github.com/x/y   → Use existing repo
/newproject my-venture --public                 → Creates public repo
```

**Execution:**
1. Validate project_id is unique (not in `~/.zeos/apps/REGISTRY.json`)
2. Confirm with Operator
3. Scaffold state-side artifacts under `~/.zeos/` (SOUL, MEMORY, journals/, roadmaps/) and `CLAUDE.md` in the project repo
4. Add entry to `~/.zeos/apps/REGISTRY.json`
5. Output scaffolding confirmation

**Full Specification:** See `modules/protocols/NEW_PROJECT_PROTOCOL.md`

**Triggered By:** initial-boot flow Option [2] "Start a new project"


---

### +rename-project

**Purpose:** Rename an existing project, including its GitHub repository and all zeos references.

**Syntax:**
```
+rename-project <old_id> <new_id> [--yes] [--no-alias]
```

**Arguments:**
| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| old_id | Yes | — | Current project identifier |
| new_id | Yes | — | New project identifier (lowercase, hyphens only) |
| --yes | No | false | Skip confirmation prompt |
| --no-alias | No | false | Don't keep old_id as backward-compatible alias |

**Examples:**
```
+rename-project my-app better-name           → Rename with confirmation, keep alias
+rename-project old-venture new-venture --yes → Rename without confirmation
+rename-project temp-project final --no-alias → Rename, remove old reference entirely
```

**Execution:**
1. **VALIDATE**: Verify old_id exists in `~/.zeos/apps/REGISTRY.json`
2. **VALIDATE**: Verify new_id is available (not in registry, valid format)
3. **CONFIRM**: Show rename plan, await confirmation (unless --yes)
4. **RENAME REPO**: Call GitHub API to rename repository
5. **UPDATE REGISTRY**: Modify `~/.zeos/apps/REGISTRY.json`:
   - Change `app_id` to new_id
   - Update `repo.url` to new GitHub URL
   - Add `"aliases": ["old_id"]` (unless --no-alias)
6. **RENAME STATE DIRS** - Move the state-side dirs `~/.zeos/{souls,memory,journals,roadmaps}/{old_id}/` to `.../{new_id}/`
7. **UPDATE SOUL** — Change `app_id` field in SOUL file
8. **OUTPUT** — Confirmation with new `/project` command

**Confirmation Prompt:**
```
═══════════════════════════════════════════════════════════════
RENAME PROJECT: old_id → new_id
═══════════════════════════════════════════════════════════════
This will:
  • Rename GitHub repo: rgsuarez/old-repo → rgsuarez/new-repo
  • Update REGISTRY.json entry
  • Rename apps/old_id/ → apps/new_id/
  • Update SOUL file references
  • Keep "old_id" as alias for backward compatibility

Proceed? (yes/no)
═══════════════════════════════════════════════════════════════
```

**Success Output:**
```
═══════════════════════════════════════════════════════════════
✅ PROJECT RENAMED: old_id → new_id
═══════════════════════════════════════════════════════════════
GitHub Repo:  https://github.com/my-org/my-repo
Registry:     Updated
Alias:        "old_id" still works

New command:  /project new_id
═══════════════════════════════════════════════════════════════
```

**Alias Behavior:**

When `/project old-id` is called and old-id is an alias:
```
═══════════════════════════════════════════════════════════════
📝 NOTE: "old-id" was renamed to "new-id"
Loading project as "new-id"...
═══════════════════════════════════════════════════════════════
[normal project load continues]
```

This notice appears once per session, then loads silently.

**Errors:**
| Error | Cause | Recovery |
|-------|-------|----------|
| OLD_NOT_FOUND | old_id not in REGISTRY | Run `/fleet` to see available projects |
| NEW_EXISTS | new_id already taken | Choose different name |
| INVALID_FORMAT | new_id contains invalid characters | Use lowercase letters and hyphens only |
| REPO_RENAME_FAILED | GitHub API error | Check permissions, retry |
| NOT_OWNER | Cannot rename repo you don't own | Manual rename required |

**Constraints:**
- Requires GitHub repo owner permissions
- Cannot rename to an existing project name
- Session journals remain in old location (historical record preserved)
- Old journal paths still valid (repo rename handles redirects)


### /load

**Purpose:** Load additional module into current session.

**Syntax:**
```
/load <module_id>
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| module_id | Yes | Module identifier (e.g., `professional-standard`) |

**Examples:**
```
/load professional-standard
/load example-project-context
```

**Execution:**
1. Verify module exists in `modules/` directory
2. Check for conflicts with currently loaded modules
3. Load module content into context
4. Confirm load with module version

**Errors:**
| Error | Cause | Recovery |
|-------|-------|----------|
| MODULE_NOT_FOUND | Module doesn't exist | List available modules |
| MODULE_CONFLICT | Conflicts with loaded module | Name conflict, operator chooses |

---

### /delegate


**Availability:** Requires AI example-app project (`/project aib`). Command spec: `aib/modules/BOARDROOM_COMMANDS.md`

**Purpose:** Route task to specific agent via example-app orchestrator (Bridge Path).

**Syntax:**
```
/delegate agent <task>
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| agent | Yes | Target agent: `gemini`, `chatgpt`, `grok`, `claude` |
| task | Yes | Natural language task description |

**Examples:**
```
/delegate gemini Analyze market positioning for my-org
/delegate grok What could go wrong with this ZIP architecture?
/delegate chatgpt Synthesize our session into an EDB
```

**Execution:**
1. Verify example-app API is available
2. Construct boot payload for target agent
3. Inject zeos context + task via orchestrator
4. Return agent response
5. Optionally persist response via Claude

**Errors:**
| Error | Cause | Recovery |
|-------|-------|----------|
| ORCHESTRATOR_UNAVAILABLE | Lambda/API not responding | Fall back to manual delegation |
| AGENT_ERROR | Target agent returned error | Surface error, suggest retry |

**Constraint:** This command requires example-app infrastructure. If unavailable, operator must manually copy context to target platform.

---

### +example-app (alias: /convene)


**Availability:** Requires AI example-app project (`/project aib`). Command spec: `aib/modules/BOARDROOM_COMMANDS.md`

**Purpose:** Initiate Board deliberation and produce a unified Executive Decision Brief (Super-Claude mode).

**Syntax:**
```
+example-app <topic> [--verbose]
/convene <topic> [--verbose]   (alias)
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| topic | Yes | Strategic question or decision requiring multi-agent analysis |
| --verbose | No | Transparent Mode: Display raw Director outputs and full Dissent Object |

**Examples:**
```
+example-app Should we add token management to Shell Protocol?
+example-app Architecture review of ZIP v0.1 --verbose
/convene my-org positioning strategy
```

**Execution (Path B - Direct API):**
1. Generate Boot Payloads for Directors (Gemini/Strategy, Grok/Risk, ChatGPT/Creative)
2. Query Directors via API (sequential for MVP)
3. Synthesize responses into unified voice
4. Output Executive Decision Brief (EDB v2)
5. Persist to session journal

**Output:** Executive Decision Brief (EDB v2) per `modules/applications/ZEOS_MODULE_003_BOARDROOM_PROTOCOL.md`

**EDB v2 Schema (Required Sections):**
1. 🏛️ **VERDICT** — Single authoritative decision
2. **RATIONALE** — Unified synthesis (no attribution)
3. ⚠️ **RISKS & MITIGATIONS** — 1-3 contrarian concerns (MANDATORY)
4. **NEXT ACTIONS** — 1-3 concrete steps
5. **DISSENT OBJECT** — Auditable record (collapsed unless --verbose)

**Modes:**
| Mode | Behavior |
|------|----------|
| Unified (default) | Single voice, Dissent Object collapsed |
| Transparent (--verbose) | Raw Director outputs visible, full Dissent Object |

**Reference:** Full specification in Module #003 (example-app Protocol)

---

### +log

**Purpose:** Display current session state and loaded context.

**Syntax:**
```
+log [--verbose]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| --verbose | No | Include full module list and recent decisions |

**Output:**
```
═══════════════════════════════════════
ZEOS SESSION STATE
═══════════════════════════════════════
Profile: {operator_id}
Phase: 0.5 - Constitution Ratified
Modules: shell-protocol, professional-standard
Session: 2025-12-18-001
Persistence: R/W (Claude direct)
═══════════════════════════════════════
```

---

### /snap

**Purpose:** Save current progress to session journal. Can be called anytime, multiple times per session. Frequency is encouraged, not discouraged.

**Syntax:**
```
/snap [optional note]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| note | No | Optional context (auto-generated if omitted) |

**Examples:**
```
/snap                              → Auto-document all work since last save
/snap "Before refactoring auth"    → Add context to auto-documented work
/snap                              → Another save 10 minutes later (normal)
```


---

### ⛔ CHECKPOINT EXECUTION CLAUSE ⛔

**The `/snap` command is INVIOLABLE.** When `/snap` appears in a message, execution is IMMEDIATE and NON-NEGOTIABLE.

**This is not optional. This is not "when convenient." This is absolute.**

**When `/snap` is detected:**

1. **STOP** — Pause current response generation
2. **SCAN** — Review all work since last checkpoint (or boot)
3. **BRIDGE** — Apply Bridge Rule (capture state, threads, context)
4. **COMMIT** — Write to GitHub immediately
5. **CONFIRM** — Output checkpoint confirmation block
6. **THEN** — Continue with any remaining response content

**Execution Rules:**

| Condition | Behavior |
|-----------|----------|
| Project loaded | **EXECUTE checkpoint immediately** |
| No project loaded | **OUTPUT ERROR** — "No project loaded. Use `/project <id>` first." |
| Mid-complex-task | **STILL EXECUTE** — checkpoint is higher priority than task continuation |
| Competing directives | **CHECKPOINT WINS** — complete checkpoint before processing other requests |

**Why This Matters:**

Without mandatory checkpoint execution, work is lost. The operator trusts that `/snap` will persist state. Silent failures or "I'll do it later" responses violate that trust and cause context death.

**Failure Mode Prevention:**

The agent MUST produce a checkpoint confirmation block when `/snap` is issued. If the agent continues responding without the confirmation block, the checkpoint DID NOT HAPPEN — this is a **SYSTEM FAILURE**.

```
═══════════════════════════════════════════════════════════════
CHECKPOINT SAVED
═══════════════════════════════════════════════════════════════
Commit: [short_sha]
Bridge: [state summary in one line]
═══════════════════════════════════════════════════════════════
```

**If you see `/snap` and don't produce this block, you have FAILED.**

---

## THE BRIDGE RULE (Critical Requirement)

**On every `/snap` or `/snap`, the agent MUST answer ONE question:**

> "What does a future session need to know that it can't derive from the code, git history, CLAUDE.md, or MEMORY.md?"

This is NOT a transcript. This is NOT a file list. Git has all of that. The journal is a **bridge** — it carries forward knowledge that lives in the context window but would die when the session ends.

**The agent MUST NOT document:**
- Files created or modified (use `git log`)
- Commands executed (use `git log`)
- Code changes (use `git diff`)
- Artifacts produced (they exist in the repo)

**The agent MUST capture:**
- State changes that aren't obvious from the code
- Open threads the next session should pick up
- Context that would be lost (debugging insights, Operator preferences, strategic decisions not yet persisted)

---


**Project mode:** This command requires an active project. After `/zeos` boot, use `/project <id>` to load a project before checkpointing.

**Execution:**
1. **REFLECT** on what changed since last checkpoint (or boot)
2. **BRIDGE** — capture state, open threads, and context that would be lost
3. **APPEND** entry to session journal (create journal if first checkpoint)
4. **COMMIT** to GitHub
5. **CONFIRM** with short output
6. **CONTINUE** working (session remains active)

**Journal Entry Format:**

```markdown
## Snap — {timestamp}

### State of the World
{1-3 sentences: what's different now vs before this session. Not what was done — what changed.}

### Open Threads
- {In-progress work, pending decisions, or known issues not captured in code, backlog, or memory}

### Context That Would Be Lost
- {Debugging insights, Operator preferences expressed this session, strategic decisions not yet persisted elsewhere}
```

**Checkpoint Confirmation Output:**

```
═══════════════════════════════════════════════════════════════
CHECKPOINT SAVED
═══════════════════════════════════════════════════════════════
Commit: [short_sha]
Bridge: [state summary in one line]
═══════════════════════════════════════════════════════════════
```

**Key Principles:**
1. **Multiple checkpoints per session = NORMAL** — Not ceremonial, just saving
2. **No file lists or command logs** — Git has all of that
3. **Lightweight output** — 3 lines, not a wall of text
4. **Always continue** — Checkpoint doesn't interrupt flow

---
### /end

**Purpose:** Close session with final journal entry and handoff for next session.

**Syntax:**
```
/end
```

---


**Project mode:** This command requires an active project. After `/zeos` boot, use `/project <id>` to load a project before ending a session.

## MANDATORY OUTPUTS (Both Required, No Exceptions)

**Output 1: Final Journal Entry**
- Apply Bridge Rule (same as /snap) to capture state, open threads, and context
- Set status: COMPLETE
- Commit to GitHub

**Output 2: Handoff Block**
- Simple boot command for next session
- One-line resume primer
- Journal path for reference

**If either output is missing, the session has FAILED.**

---

**Execution:**
1. **APPLY DELTA RULE** — Document all work since last checkpoint
2. **WRITE** final journal entry with status: COMPLETE
3. **COMMIT** journal to GitHub
4. **OUTPUT** handoff block (format below)
5. **SESSION TERMINATES**

---

## HANDOFF BLOCK FORMAT (Mandatory Output)

```
═══════════════════════════════════════════════════════════════
SESSION COMPLETE
═══════════════════════════════════════════════════════════════
Journal: [JOURNAL_PATH]

Next session:

  /zeos
  /project [PROJECT_ID]

Resume: [ONE LINE — what to pick up next]
═══════════════════════════════════════════════════════════════
```

**That's it.** Six lines. The journal contains the details. The handoff just says:
1. Where the journal is
2. How to boot
3. What to resume

**The next session loads the journal automatically during boot (per BOOT_PROTOCOL Step 4). All context is preserved there, not duplicated in the handoff.**

---

## Why Simplified?

Previous handoff format was 20+ lines with Context, Priorities, Phase, Decisions, etc. This caused:
- Agents overwhelmed by the template
- Inconsistent output (sometimes skipped entirely)
- Redundant info (already in journal)

New principle: **Journal holds the truth. Handoff is just a pointer.**

---

## Security Constraint (Unchanged)

Handoff blocks MUST NEVER contain credentials. No API keys, tokens, passwords. Reference as `[CONFIGURED]` if relevant.

---

## Failure Mode Prevention

The visual separator `═══` before "SESSION COMPLETE" is a forcing function. When the agent sees `/end`, it MUST produce this block before stopping.

If the agent writes a journal but forgets the handoff: **FAILURE.**
If the agent outputs a handoff but forgets the journal: **FAILURE.**

Both outputs. Every time. Non-negotiable.

---

## Discoverability Commands

These commands help operators understand the current session state and available capabilities.

### /help

**Purpose:** Display available commands or detailed help for a specific command.

**Syntax:**
```
/help [command]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| command | No | Specific command to get help for |

**Examples:**
```
/help                   → List all available commands
/help boot              → Detailed help for /zeos command
/help delegate          → Detailed help for /delegate command
```

**Output (no argument):**
```
═══════════════════════════════════════════════════════════════
ZEOS SHELL COMMANDS
═══════════════════════════════════════════════════════════════
Boot Flow (canonical):
  /zeos [profile]         Initialize zeos context (Project mode)
  /project <app_id>       Load project context and enable journaling

Core Commands:
  /newproject <id>       Scaffold new project
  +rename-project <old> <new>  Rename project with alias
  /load <module>          Load additional module
  /snap [note]      Save current state
  /end                    Terminate session with journal

Delegation Commands:
  /delegate agent <task>  Route task to specific agent (team-orchestration only)
  /convene <topic>          Full Board deliberation (team-orchestration only)

Discoverability Commands:
  /help [command]         Show this help or command details
  /status                 Infrastructure health check (includes instance info)
  +whoami                 Current identity and profile
  +modules                List loaded modules
  +continuity [mode]      Show or change Continuity Mode (LOCK|OFF|LIGHT|STANDARD|HEAVY)
  +profile                Display profile details
  +log                    Session state summary
  /fleet                  Fleet status across all applications
  +parallel               Show active parallel instances on this project
  +merge [branch|--all]   Consolidate parallel instance branches
  +mission "<task>"       Analyze mission atomicity (advisory)

Team Commands: (CONDITIONAL - loaded with /team activate)
  /team activate <config>    Activate team from YAML config
  /team status               Team health and heartbeat dashboard
  /team disband [--keep]     Graceful team shutdown
  /team list                 Available team configs
  /team config <name>        Display config without activating

Blueprint Commands: (CONDITIONAL - not auto-loaded)
  → Load with: /load modules/commands/BLUEPRINT_COMMANDS.md
  → Or use MCPify blueprint MCP server
═══════════════════════════════════════════════════════════════
```

---

### /status

**Purpose:** Display health status of zeos infrastructure and capabilities.

**Syntax:**
```
/status
```

**Output:**
```
═══════════════════════════════════════════════════════════════
ZEOS STATUS
═══════════════════════════════════════════════════════════════
Instance:      claude-opus-a3f2
Parallel:      2 other instances active
Journal:       ~/.zeos/journals/<app_id>/2026-01-08-008-claude-opus.md

Kernel:        ✅ Loaded (SOUL, BOOT_PROTOCOL)
Profile:       ✅ operator
Persistence:   ✅ Available (GitHub R/W)
Orchestrator:  ⚠️ Unknown (not tested this session)
Shell:         ✅ Active (Module #002 v3.9.0)
Continuity:    ✅ HEAVY (auto-checkpoint active)
═══════════════════════════════════════════════════════════════
```

**Instance Fields:**

| Field | Description |
|-------|-------------|
| Instance | Current session's instance ID |
| Parallel | Count of other active instances (if any) |
| Journal | Path to this session's journal file |

**Note:** Status reflects current session awareness. Orchestrator status requires active test. Instance info only shown in project mode.

---

### +whoami

**Purpose:** Display current agent identity and active profile.

**Syntax:**
```
+whoami
```

**Output:**
```
═══════════════════════════════════════════════════════════════
IDENTITY
═══════════════════════════════════════════════════════════════
Agent:         {Agent Name} ({Role})
Profile:       {operator_id}
Operator:      {Operator Name}
Phase:         0.5 - Constitution Ratified
Persistence:   Executor (R/W)
Credentials:   Configured (not displayed)
═══════════════════════════════════════════════════════════════
```

---

### +modules

**Purpose:** List all currently loaded modules with versions and status.

**Syntax:**
```
+modules
```

**Output:**
```
═══════════════════════════════════════════════════════════════
LOADED MODULES
═══════════════════════════════════════════════════════════════
#  Module ID              Version  Priority  Status
─────────────────────────────────────────────────────────────
1  shell-protocol         1.1.0    1         ACTIVE (auto)
2  professional-standard  1.0.0    10        ACTIVE
═══════════════════════════════════════════════════════════════
Available (not loaded): example-project-context, soc-context
```

---

### +profile

**Purpose:** Display current profile details including mission and preferences summary.

**Syntax:**
```
+profile [--full]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| --full | No | Include complete preferences dump |

**Output:**
```
═══════════════════════════════════════════════════════════════
PROFILE: {operator_id}
═══════════════════════════════════════════════════════════════
Operator:      {Operator Name}
Callsign:      {Callsign}
Phase:         0.5 - Constitution Ratified

Communication:
  Tone:        Direct, military precision
  Format:      BLUF (Bottom Line Up Front)
  
Active Projects:
  - {Project 1} (current focus)
  - {Project 2} (deadline)
  - {Project 3} (maintenance)
  - {Project N} (status)

Constraints:
  - GitOps discipline mandatory
  - Systems over tasks
  - No secrets in chat
═══════════════════════════════════════════════════════════════
```

---

### /fleet

**Purpose:** Display status, drift detection, and upgrade planning for all ventures.

**Syntax:**
```
/fleet [--status | --drift | --check | --upgrade-plan | --json] [--app=<app_id>]
```

**Arguments:**
| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| (none) | — | — | Full fleet status with all details |
| --status | No | — | Brief status summary (icons + ages) |
| --drift | No | — | Drift detection report only |
| --check | No | — | Check engine warnings only |
| --upgrade-plan | No | — | Detailed upgrade/migration plan |
| --json | No | — | Machine-readable JSON output |
| --app=<id> | No | all | Focus on single app |

**Examples:**
```
/fleet                    → Full fleet status report
/fleet --status           → Quick status (one line per app)
/fleet --drift            → Show structure drift from manifest
/fleet --check            → Show check engine warnings only
/fleet --upgrade-plan     → Detailed migration steps
/fleet --app=example-project   → Status for single app
```

**Execution:**
```bash
python3 tools/fleet.py [arguments]
```

**Output Format (--status):**
```
════════════════════════════════════════
 FLEET STATUS
════════════════════════════════════════
 🟢 2 | 🟡 3 | 🔴 1 | ⚫ 0

 🟢 zero-echelon           1h ago
 🟡 example-game        2d ago
 🔴 ai-example-app          missing docs
 ...
════════════════════════════════════════
```

**Health Classification:**
- 🟢 HEALTHY: All required files present, active commits
- 🟡 WARNING: Missing APP_MANIFEST or minor drift
- 🔴 CRITICAL: Missing required docs or unreachable
- ⚫ UNREACHABLE: Repository not accessible

**Drift Detection:**
The fleet manager compares each app against the current zeos manifest:
- Registry entry vs scaffolded state
- Required state-side artifacts under `~/.zeos/{souls,memory,journals,roadmaps}/<app_id>/`, plus the project's `CLAUDE.md`
- Structure compliance with scaffolding system standards

**Implementation:** `tools/fleet.py` v1.0.0

---

### +parallel

**Purpose:** Display active parallel instances working on the same project.

**Syntax:**
```
+parallel [--stale]
```

**Arguments:**
| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| --stale | No | false | Include stale instances (30+ min inactive) |

**Examples:**
```
+parallel             → Show active parallel instances
+parallel --stale     → Include stale/crashed instances
```

**Output:**
```
═══════════════════════════════════════════════════════════════
PARALLEL INSTANCES: zeos-dev
═══════════════════════════════════════════════════════════════
Instance          Journal                  Status    Last Activity
─────────────────────────────────────────────────────────────────
● claude-opus     2026-01-08-008-*         active    2 min ago (you)
● gemini-cli      2026-01-08-007-*         active    15 min ago
○ codex           2026-01-08-006-*         stale     45 min ago
═══════════════════════════════════════════════════════════════
Total: 2 active, 1 stale
```

**Status Indicators:**

| Icon | Status | Description |
|------|--------|-------------|
| ● | active | Last activity < 30 minutes |
| ○ | stale | Last activity 30-120 minutes (may have crashed) |
| ✕ | expired | Last activity > 120 minutes (shown only with --stale) |

**Behavior:**

| Condition | Output |
|-----------|--------|
| No project loaded | Error: "No project loaded. Use `/project <id>` first." |
| No parallel instances | "No parallel instances detected. You are the only active session." |
| Parallel instances found | Instance table with status |

**Implementation:**
1. Scan `~/.zeos/journals/<app_id>/{today}-*.md`
2. Parse frontmatter for `status`, `instance`, `started`
3. Calculate last activity from file mtime or heartbeat
4. Display sorted by recency

**Reference:** `modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md` (Parallel Instance Support)

---

### +merge

**Purpose:** Consolidate parallel instance branches back to main.

**Syntax:**
```
+merge [branch-name | --all] [--delete]
```

**Arguments:**
| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| branch-name | No | — | Specific branch to merge (e.g., `zeos/2026-01-08-claude-opus-fix`) |
| --all | No | false | Merge all outstanding `zeos/*` branches |
| --delete | No | true | Delete branch after successful merge |

**Examples:**
```
+merge                                    → List outstanding zeos/* branches
+merge zeos/2026-01-08-gemini-docs        → Merge specific branch to main
+merge --all                              → Merge all zeos/* branches sequentially
+merge zeos/my-branch --delete=false      → Merge but keep branch
```

**Output (no args — list branches):**
```
═══════════════════════════════════════════════════════════════
OUTSTANDING PARALLEL BRANCHES
═══════════════════════════════════════════════════════════════
Branch                                  Changes    Age
─────────────────────────────────────────────────────────────────
zeos/2026-01-08-gemini-cli-docs         +15 -3     2h ago
zeos/2026-01-08-codex-api-update        +42 -10    4h ago
═══════════════════════════════════════════════════════════════
Total: 2 branches | Run: +merge <branch> or +merge --all
```

**Output (merge success):**
```
═══════════════════════════════════════════════════════════════
BRANCH MERGED: zeos/2026-01-08-gemini-cli-docs
═══════════════════════════════════════════════════════════════
Commits merged: 3
Files changed: 2 (+15 -3)
Branch deleted: Yes
═══════════════════════════════════════════════════════════════
```

**Output (merge conflict):**
```
═══════════════════════════════════════════════════════════════
⚠️ MERGE CONFLICT: zeos/2026-01-08-codex-api-update
═══════════════════════════════════════════════════════════════
Conflicting files:
  - src/api/client.ts
  - docs/API.md

Options:
  1. Resolve manually: git checkout zeos/... && git merge main
  2. Abort merge: +merge --abort
  3. Keep branch for later resolution
═══════════════════════════════════════════════════════════════
```

**Behavior:**

| Condition | Action |
|-----------|--------|
| No zeos/* branches | "No parallel branches to merge" |
| Branch has conflicts | WARN, do not merge, offer options |
| --all with conflicts | Merge clean branches, skip conflicting, report |
| Successful merge | Delete branch (unless --delete=false) |

**Branch Naming Convention:**

Parallel instance branches follow the pattern:
```
zeos/{date}-{agent}-{task-slug}

Examples:
  zeos/2026-01-08-claude-opus-shell-update
  zeos/2026-01-08-gemini-cli-docs-update
  zeos/2026-01-08-codex-api-refactor
```

**When Branches Are Created:**

Branches are created automatically when:
1. `git push` fails due to remote changes
2. Rebase attempt fails with conflicts
3. Agent creates conflict branch instead of blocking

See the parallel-instance protocol documentation for full specification.

**Errors:**
| Error | Cause | Recovery |
|-------|-------|----------|
| NO_BRANCHES | No zeos/* branches exist | Nothing to merge |
| MERGE_CONFLICT | Branch conflicts with main | Resolve manually or skip |
| NOT_ON_MAIN | Not on main branch | Checkout main first |

**Reference:** the parallel-instance protocol documentation (Git Coordination)

---

### +retrofit

**Purpose:** Upgrade legacy apps with missing zeos structure without overwriting existing work.

**Syntax:**
```
+retrofit <app_id> [--yes]
+retrofit --all [--yes]
```

**Arguments:**
| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| app_id | Yes* | — | App to retrofit (* or use --all) |
| --all | No | — | Retrofit all apps that need it |
| --yes | No | false | Skip confirmation prompt |

**Examples:**
```
+retrofit example-game          → Upgrade single app
+retrofit --all                    → Upgrade all legacy apps
+retrofit --all --yes              → Upgrade all, no confirmation
```

**Execution:**
```bash
python3 tools/scaffold.py --retrofit <app_id> [--yes]
python3 tools/scaffold.py --retrofit-all [--yes]
```

**Retrofit Logic:**
1. Look up app in `~/.zeos/apps/REGISTRY.json`
2. Check which required artifacts are missing (state-side, under `~/.zeos/<dir>/<app_id>/`):
   - `~/.zeos/souls/<app_id>/SOUL.md`
   - `~/.zeos/memory/<app_id>/MEMORY.md`
   - `~/.zeos/journals/<app_id>/README.md`
   - `~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md`
   - `<local_path>/CLAUDE.md` (project repo)
3. Create ONLY missing files (never overwrites)
4. Report what was created vs preserved

**Output Format:**
```
═══════════════════════════════════════════════════════════════════════════════
 ✅ RETROFIT COMPLETE: example-game
═══════════════════════════════════════════════════════════════════════════════

 Files created: 2/2
 Files preserved: 2

 The app is now compliant with zeos scaffolding system v2.2.0
═══════════════════════════════════════════════════════════════════════════════
```

**Implementation:** `tools/scaffold.py` v2.2.0

---

### +upgrade

**Purpose:** Check and synchronize app fleet with zeos Core version.

**Syntax:**
```
+upgrade [--status | --check | --apply] [--app=<app_id>] [--force]
```

**Subcommands:**
| Subcommand | Purpose |
|------------|---------|
| --status | Display current zeos version and fleet health matrix |
| --check | Deep comparison of Core manifest against all apps |
| --apply | Synchronize outdated apps to current Core version |

**Arguments:**
| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| --app | No | all | Target specific app instead of entire fleet |
| --force | No | false | Force upgrade even with breaking changes |

**Examples:**
```
+upgrade --status           → Show fleet version health
+upgrade --check            → Deep diff Core vs all apps
+upgrade --apply            → Sync all outdated apps
+upgrade --apply --app=soc  → Sync only example-game
```

**Execution:**
1. Load `kernel/ZEOS_MANIFEST.json` (the System Ledger)
2. Load `~/.zeos/apps/REGISTRY.json` (fleet list)
3. For each app (or specified --app):
   a. Fetch `.zeos_version` from app repo
   b. Compare against manifest
   c. Report differences (--check) or apply sync (--apply)
4. Output upgrade report

**Output Format (--status):**
```
═══════════════════════════════════════════════════════════════
ZEOS UPGRADE STATUS
═══════════════════════════════════════════════════════════════
Core Version: 1.0.0
Manifest SHA: abc123...

FLEET HEALTH:
┌─────────────────┬──────────┬──────────────┬────────┐
│ App             │ Version  │ Validated    │ Status │
├─────────────────┼──────────┼──────────────┼────────┤
│ example-game │ 1.0.0    │ 2025-12-24   │ ✅ OK  │
│ zero-echelon    │ 0.9.0    │ 2025-12-20   │ ⚠️ OLD │
│ example-project      │ 1.0.0    │ 2025-12-24   │ ✅ OK  │
│ ai-example-app    │ —        │ Never        │ ❌ NEW │
└─────────────────┴──────────┴──────────────┴────────┘
═══════════════════════════════════════════════════════════════
```

**Sync Policy by Criticality:**
| Tier | Policy |
|------|--------|
| L0 (Kernel) | Apps read from Core — validate via boot |
| L1 (Module) | Apps read from Core — validate via boot |
| L1S (Registry) | Core entries must match — apps may add |
| L1T (Tools) | Warn if outdated — apps may have local copies |
| L2T (Templates) | No sync required — operators customize |

**Related Documents:**
- `kernel/ZEOS_MANIFEST.json` — The System Ledger
- `docs/architecture/UPGRADE_ARCHITECTURE.md` — Full specification

**Implementation:** See `+retrofit` for structure upgrades, `/fleet --upgrade-plan` for planning.


## Token Awareness (/fuel)

**Conditional Module:** Disabled by default. Enable via `profile.preferences.fuel_warnings=true` or `/load modules/commands/FUEL_COMMANDS.md`

The `/fuel` command provides opt-in session complexity introspection using observable heuristics. Returns a visual "fuel gauge" showing estimated context consumption.

**Full documentation:** [modules/commands/FUEL_COMMANDS.md](../commands/FUEL_COMMANDS.md)

---



### +continuity

**Purpose:** Display or change Continuity Mode for the current session.

**Syntax:**
```
+continuity              # Show current mode and settings
+continuity <mode>       # Change mode for this session (LOCK|OFF|LIGHT|STANDARD|HEAVY)
+continuity --status     # Show buffer state and pending writes
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|--------------|
| mode | No | New mode to set (OFF, LIGHT, STANDARD, HEAVY) |
| --status | No | Show detailed buffer/flush state |

**Examples:**
```
+continuity                  → Show: "Continuity Mode: HEAVY (debounce: 5 min)"
+continuity LIGHT            → Change to LIGHT mode for this session
+continuity --status         → Show pending buffer entries and last flush time
```

**Output Format:**
```
═══════════════════════════════════════════════════════════════
CONTINUITY MODE
═══════════════════════════════════════════════════════════════
Mode:           HEAVY
Debounce:       5 minutes
Last Flush:     2025-12-29T05:30:00Z
Buffer Entries: 3 pending
═══════════════════════════════════════════════════════════════
```

**Behavior:**
- Mode changes apply to current session only (does not modify PREFERENCES.md)
- To permanently change mode, update profile PREFERENCES.md
- See `modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md` for full specification

---

## Repo Boundary Commands

**Conditional Module:** Loads when `profile.preferences.boundary.default_enforcement != OFF` or via `/load modules/commands/BOUNDARY_COMMANDS.md`

Commands for managing cross-repository write protection: `/boundary-status`, `/boundary-allow`, `/boundary-revoke`, `/boundary-audit`, `/boundary-set`

**Full documentation:** [modules/commands/BOUNDARY_COMMANDS.md](../commands/BOUNDARY_COMMANDS.md)

**Related:** [ZEOS_MODULE_009_REPO_BOUNDARY.md](ZEOS_MODULE_009_REPO_BOUNDARY.md)

---

### +mission

**Purpose:** Analyze proposed work against the Resumability Contract and provide advisory guidance.

**Syntax:**
```
+mission "<task description>"
+mission --breakdown "<large task>"
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| task | Yes | The proposed work to analyze (in quotes) |
| --breakdown | No | Request suggested breakdown for complex tasks |

**Examples:**
```
+mission "Add error handling to fleet.py"
+mission "Refactor the entire kernel to use Rust"
+mission --breakdown "Make the website production ready"
```

**Execution (Cognitive Heuristic — NOT a Python script):**

The agent analyzes the proposed mission by evaluating:

1. **Resumability Contract** (4 criteria):
   - Clear Definition of Done?
   - Bounded Context (≤3 files/modules)?
   - Meaningful Checkpoint possible?
   - Resume Without Re-Explanation?

2. **Anti-Pattern Detection**:
   - "Fix Everything" — touches 5+ domains
   - "Research and Implement" — combines discovery + execution
   - "Make It Production Ready" — vague quality bar
   - "While You're At It" — accumulates tangential tasks
   - "The Mega-Refactor" — structural changes across codebase

3. **Session Estimation**:
   - 1 session = single file or bounded 2-3 file change
   - 2 sessions = new feature or tool
   - 3+ sessions = SHOULD BE BROKEN DOWN

**Output Format:**
```
═══════════════════════════════════════════════════════════════
📋 MISSION ANALYSIS
═══════════════════════════════════════════════════════════════

Proposed: "[mission text]"

Resumability Contract:
  ☑ Clear Definition of Done: [PASS/WARN/FAIL]
  ☑ Bounded Context: [PASS/WARN/FAIL]
  ☑ Meaningful Checkpoint: [PASS/WARN/FAIL]
  ☑ Resume Without Re-Explanation: [PASS/WARN/FAIL]

Anti-Pattern Check: [CLEAR / WARNING: <pattern name>]

Est. Sessions: [N] [within budget / EXCEEDS ATOMIC SCOPE]

═══════════════════════════════════════════════════════════════
Advisory: [PROCEED / CONSIDER BREAKDOWN]

[If breakdown suggested:]
Suggested Phases:
  1. [Phase 1 — bounded, atomic]
  2. [Phase 2 — bounded, atomic]
  3. [Phase N — bounded, atomic]

═══════════════════════════════════════════════════════════════
```

**Critical Constraint:**

**The +mission command is ADVISORY ONLY.**

- It NEVER blocks work
- It NEVER refuses to proceed
- It provides information for operator decision
- If operator says "proceed anyway," agent proceeds immediately
- Operator authority is supreme

**Implementation Note:**

This is a **Cognitive Heuristic** — the LLM uses judgment, not rigid rules.
There is no Python script, no token counting, no hard-coded logic.
The agent applies the Resumability Contract principles from MISSION_PROTOCOL.md
using contextual reasoning.

**Reference:** Full specification in `modules/protocols/MISSION_PROTOCOL.md`

---

## Inter-Agent Comms (Overseer)

Every zeos agent has **baseline communication capability** via the Overseer MCP relay. These tools are available immediately after boot — no `/team activate` required.

### Core Comms Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `list_agents` | See running agent tmux sessions | Before sending messages |
| `detect_state` | Check if agent is IDLE or WORKING | Before choosing delivery method |
| `post_message` | Send async message via relay | Agent is subscribed or WORKING |
| `get_messages` | Read messages from relay | Check for incoming comms |
| `send_to_agent` | Type directly into agent's terminal | Agent is IDLE at prompt |

### Communication Patterns

1. **Always `detect_state` before sending** — determines delivery method:
   - **IDLE** → use `send_to_agent` (types into their terminal)
   - **WORKING** → use `post_message` (queues on relay for pickup)

2. **Identify yourself** — include your agent name in all messages so recipients know the sender

3. **Read responses** — use `get_messages(requesting_agent="your-name")` to check for replies

4. **Natural language triggers** — when the operator says "tell claude-2 to run the tests" or "ask gemini to review this file," use these tools directly

### Escalation to Formal Teams

For **formal orchestration** — task dispatch with ACK, heartbeat monitoring, write policy enforcement, structured subscribe loops — use `/team activate <config>` which loads Module 010 (Team Protocol).

Baseline comms = radio. Team activation = full C2 infrastructure.

---

## Team Commands

**STATUS:** Team commands load conditionally via `/team activate`.

Team commands have been extracted to `modules/commands/TEAM_COMMANDS.md` and are **auto-loaded during `/team activate`** when the Team Protocol (Module 010) activates.

**Commands:** `/team activate <config>`, `/team status`, `/team disband [--keep]`, `/team list`, `/team config <name>`

**Auto-Load Condition:**
```
/team activate team-2
→ Module 010 (TEAM_PROTOCOL) auto-loads
→ TEAM_STRATEGY_PROTOCOL auto-loads
→ TEAM_COMMANDS auto-loads
```

**If No Team Active:**
- Team commands NOT loaded (saves ~800 tokens)
- Manually load if needed: `/load modules/commands/TEAM_COMMANDS.md`

**Reference:** `modules/constraints/ZEOS_MODULE_010_TEAM_PROTOCOL.md` for full governance specification.

---

## Blueprint Commands

**STATUS:** Blueprint commands auto-load conditionally (when active blueprint is set).

Blueprint commands have been extracted to `modules/commands/BLUEPRINT_COMMANDS.md` and are **auto-loaded during Step 5.5** if a project has an active blueprint set in MASTER_ROADMAP.

**Auto-Load Condition:**
```yaml
# In MASTER_ROADMAP.md
---
active_blueprint: "blueprints/IMPLEMENT_AUTH_SYSTEM.md"
---
→ BLUEPRINT_COMMANDS auto-loads automatically
```

**If No Active Blueprint:**
- Blueprint commands NOT loaded (saves ~450 tokens)
- Manually load if needed: `/load modules/commands/BLUEPRINT_COMMANDS.md`

**MCP Alternative:** If using MCPify with blueprint MCP server, you may not need shell commands.

**Reference:** `modules/protocols/BLUEPRINT_PROTOCOL.md` for full lifecycle specification.


---

## Idea Management Commands

**Quick Add:** `/idea <text>` — Records idea to IDEAS.md (works without full module load)

**Full Commands:** `+ideas` loads full module and displays backlog. Use `/load modules/commands/IDEA_COMMANDS.md` for all options.

**Full documentation:** [modules/commands/IDEA_COMMANDS.md](../commands/IDEA_COMMANDS.md)

---

## Extended Commands (Future)

Reserved for future implementation:

| Command | Purpose | Status |
|---------|---------|--------|
| `+rollback <commit>` | Revert to previous state | Planned |
| `+diff` | Show changes since last checkpoint | Planned |
| `+export [profile]` | Generate portable boot payload | Planned |
| `+history` | Recent command history | Planned |

---

## Control Plane vs. Conversation Plane

### Control Plane (Slash Commands)

- Machine-parsable
- Deterministic execution
- System state changes
- Logged and auditable

### Conversation Plane (Natural Language)

- Human dialogue
- Flexible interpretation
- Task collaboration
- Context-dependent

**Boundary Rule:** Slash commands are NEVER interpreted as conversation. If operator types `/zeos`, execute boot sequence — do not discuss booting.

**Escape Hatch:** If operator needs to discuss a command without executing, prefix with "about" or wrap in quotes:
```
"What does /convene do?"        → Explain command
Tell me about /delegate         → Explain command
/delegate gemini analyze this   → EXECUTE delegation
```

---

## Validation Criteria

A session correctly implements Shell Protocol if:

1. All slash commands from Core Commands section are recognized
2. Unrecognized commands return helpful error, not confusion
3. Commands execute deterministically (same input → same behavior)
4. Control Plane commands never leak into Conversation Plane
5. Command execution is logged (at minimum in session journal)

---

## Violation Examples

**Violation:** Treating command as conversation
```
Operator: /zeos
Agent: "That's a great idea! Let's discuss..."  ❌
```
**Correct:** Execute immediately, output confirmation.

**Violation:** Premature session termination
```
Operator: [completes a task, no /end issued]
Agent: "SESSION COMPLETE..."  ❌
```
**Correct:** Session remains active until `/end`. Task completion ≠ session termination.

---

## Integration with BOOT_PROTOCOL

BOOT_PROTOCOL v3.0 Step 5 (Load Modules) MUST include `shell-protocol` by default.

```
Default modules loaded at boot:
1. shell-protocol (this module) - Priority 1
2. professional-standard - Priority 10
```

Post-boot, operator has immediate access to all slash commands without explicit `/load`.

---

## Version History

**Full history:** [docs/changelogs/SHELL_PROTOCOL_CHANGELOG.md](../../docs/changelogs/SHELL_PROTOCOL_CHANGELOG.md)

---

*Module #002: Shell Protocol v3.15.0*
*Part of zeos Interoperability Protocol (ZIP) v0.1*











