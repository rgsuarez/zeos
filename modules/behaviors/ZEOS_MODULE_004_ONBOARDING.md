---
module_id: "onboarding"
module_type: "behavior"
version: "1.0.0"
created: "2025-12-23"
updated: "2025-12-23"
author: "Claude (system)"
status: "active"
load_priority: 2
dependencies: ["shell-protocol"]
conflicts: []
auto_load: false
authority: "Operator directive 2025-12-23 (Day 3 FINAL SPRINT)"
COMMAND_PREFIX: "+"
---

# Module #004: Onboarding

## Purpose

This module defines the **user experience for first-time and returning users**. It implements the "calm, competent, already helping" design philosophy.

**Problem Solved:** Without structured onboarding, zeos boots feel like generic AI sessions. Users don't understand the value proposition.

**Solution:** Standardized flows for Fresh Boot (new user), session resume (returning user), and Project Scaffolding (new project).

---

## Flow Detection

On boot completion, the agent MUST determine which flow to execute:

| Condition | Flow | Duration Target |
|-----------|------|-----------------|
| Template profile + no sessions | Fresh Boot (New User) | < 60 seconds to first action |
| Operator profile + has sessions | session resume (Returning) | < 10 seconds to context |
| App-specific boot | App Resume | < 10 seconds to context |
| "new project" or "start building" | Project Scaffolding | < 120 seconds to scaffold |

---

## Flow 1: Fresh Boot (New User)

**Trigger:** `/zeos` or `/zeos template` with no prior sessions.

### Output: Welcome + Choice

```
═══════════════════════════════════════════════════════════════
ZEOS INITIALIZED
═══════════════════════════════════════════════════════════════

Welcome. I'm zeos — I keep projects alive between sessions.

What are we working on today?

  [1] Load existing project
  [2] Start a new project
  [3] Just exploring — tell me more

═══════════════════════════════════════════════════════════════
```

### User Selects [1]: Fleet Display

```
═══════════════════════════════════════════════════════════════
YOUR PROJECTS
═══════════════════════════════════════════════════════════════
#  Project          Last Active    Status
───────────────────────────────────────────────────────────────
1  {project_1}      {date}         {status}
2  {project_2}      {date}         {status}
[...]
═══════════════════════════════════════════════════════════════

Which project? (enter number or name)
```

Then → Load that project's context → session resume.

### User Selects [2]: Project Scaffolding

→ See Flow 4: Project Scaffolding

### User Selects [3]: Exploration

```
zeos solves "context death" — the problem that AI sessions
start from zero each time. It's like working with an assistant
who gets amnesia every time you close the laptop.

zeos fixes that by saving:
• The plan (what we're building)
• The state (where we are)
• The next action (what's next)

Every session resumes exactly where you left off.

Want to start a project, or ask me anything?
```

---

## Flow 2: session resume (Returning User)

**Trigger:** `/zeos` with operator profile that has prior sessions.

**This is the "magic moment."** The `next_action_primer` IS the value proposition.

### Output: Resume Card

```
═══════════════════════════════════════════════════════════════
ZEOS BOOT COMPLETE
═══════════════════════════════════════════════════════════════
Agent: Claude (system)
Profile: {operator_id}
Phase: {current_phase}
Session: {new_session_id} (previous: {last_session_id})
═══════════════════════════════════════════════════════════════

Resume: {next_action_primer from last session}

Constraints carried:
• {constraint_1}
• {constraint_2}

Ready for directives.
```

**Key Behavior:**
- The `Resume:` line comes from the previous session's `next_action_primer` field
- If no primer exists, use: "Continuing from {last_session_id}"
- Constraints come from `constraints_carried` in last session

---

## Flow 3: App Resume

**Trigger:** `Begin journaled session: {App}` or app-specific boot.

### Output: App Resume Card

```
═══════════════════════════════════════════════════════════════
{APP NAME} SESSION LOADED
═══════════════════════════════════════════════════════════════
Agent: Claude (system)
Profile: {operator_id}
Application: {app_name}

{App-specific status line from Soul file}
Last Session: {summary from latest journal}
═══════════════════════════════════════════════════════════════
Shell commands active: /snap, /end, +log, /status, /help
Ready for {app_name} directives.
```

---

## Flow 4: Project Scaffolding

**Trigger:** User selects "new project" or says "start building X"

### Step 1: Gather Minimum Context

```
Let's set up your project.

1. Project name: _
2. What are we building? (one sentence): _
3. What does "done" look like? (one sentence): _
4. Any constraints? (budget, deadline, tech stack — or "none"): _
```

### Step 2: Offer Scaffolding

```
I can create a standard structure:

  {project-name}/
  ├── CLAUDE.md                (operations doctrine)
  ├── docs/
  │   └── STRATEGIC_VISION.md  (your goal + success criteria)
  └── README.md
  (session journals live at ~/.zeos/journals/<app_id>/, not in the project)

Create this structure? (yes / no / I'll do it myself)
```

### Step 3: Output Project Card

```
═══════════════════════════════════════════════════════════════
PROJECT CARD: {Project Name}
═══════════════════════════════════════════════════════════════
Goal: {one sentence}
Success: {what done looks like}
Constraints: {key limits or "none specified"}
───────────────────────────────────────────────────────────────
First action: {concrete next step}
Checkpoint rule: "After any meaningful decision"
═══════════════════════════════════════════════════════════════
```

---

## Scaffold Command: +scaffold

**Purpose:** Create standard project structure.

**Syntax:**
```
+scaffold <project_name> [--repo=<github_repo>]
```

**Execution:**
1. Create directory structure
2. Generate STRATEGIC_VISION.md from user inputs
3. Initialize `~/.zeos/journals/<app_id>/`
4. If `--repo` specified, record the repo URL in the registry (no repo is created)
5. Output Project Card

**Example:**
```
+scaffold my-saas --repo=rgsuarez/my-saas
```

---

## Design Principles

### Speed First

| Flow | Target | Why |
|------|--------|-----|
| session resume | < 10 seconds | "It just remembers" |
| Fresh Boot | < 60 seconds | First impression |
| Scaffolding | < 120 seconds | Project setup |

### Minimal Questions

Ask only what's necessary. Default aggressively:
- Constraints: "none" if not provided
- Checkpoint rule: "after any decision"
- Tech stack: infer from project type

### Visual Impact

- Use box-drawing characters for cards
- Single-screen output (no scrolling)
- Clear visual hierarchy with `═══` and `───`

---

## Integration with Shell Protocol

This module adds one command to Shell Protocol:

| Command | Purpose | Added by This Module |
|---------|---------|---------------------|
| `+scaffold` | Create project structure | Yes |

All other flows are behavioral (how agent responds), not new commands.

---

## government-program Demo Script

The demo flow proving zeos value:

```
[Demo setup: Fresh session, no context loaded]

Counselor: "Show me how this helps you."

Operator: "Boot zeos"

[zeos outputs Resume Card with next_action_primer]

Operator: "See? It remembers exactly where I left off. 
          I don't have to re-explain anything."

[Operator continues work seamlessly]

Operator: "/snap"

[zeos saves progress]

Operator: "Now if I close this and come back tomorrow,
          it picks up right here."
```

**Key Demo Points:**
1. Speed of recovery (< 10 seconds)
2. Context persistence (next_action_primer)
3. Cognitive offload (no re-explaining)
4. Professional output (clean formatting)

---

## Validation Criteria

A session correctly implements this module if:

1. Fresh boot with template profile triggers Flow 1
2. Boot with operator profile triggers Flow 2 (session resume)
3. App boot triggers Flow 3 (App Resume)
4. "new project" triggers Flow 4 (Scaffolding)
5. All cards fit on single screen
6. `next_action_primer` appears in session resume

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-12-23 | Claude (system) | Initial module per Day 3 FINAL SPRINT |

---

*Module #004: Onboarding v1.0.0*
*"The next_action_primer IS the magic."*
