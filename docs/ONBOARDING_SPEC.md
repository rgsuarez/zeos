---
document: "ONBOARDING_SPEC"
version: "1.0.0"
status: "ACTIVE"
created: "2025-12-22"
author: "Claude (system)"
classification: "DOCUMENTATION"
location: "docs/ONBOARDING_SPEC.md"
authority: "Operator directive 2025-12-22 (ChatGPT design input)"
---

# zeos Onboarding Specification

## Purpose

Defines the user experience when zeos boots without existing context. Implements ChatGPT's "calm, competent, already helping" design philosophy.

**Design Constraint:** Speed first. Demo needs to show session resume in < 30 seconds.

---

## Onboarding Triggers

| Scenario | Trigger | Flow |
|----------|---------|------|
| Fresh boot, no profile | `/zeos` with template profile | Full onboarding |
| Fresh boot, has profile | `/zeos` with operator profile | Returning user flow |
| App boot, has context | `/zeos` + app directive | session resume |
| Explicit new project | "new project" or "start building" | Project scaffolding |

---

## Flow 1: Fresh Boot (New User)

**Trigger:** `/zeos` with template profile, no prior sessions.

**Duration Target:** < 60 seconds to first action

### Step 1: Welcome + Establish Context

```
═══════════════════════════════════════════════════════════════
ZEOS INITIALIZED
═══════════════════════════════════════════════════════════════

Welcome. I'm zeos — I keep projects alive between sessions.

What are we working on today?

  [1] Load existing project (show fleet)
  [2] Start a new project
  [3] Just exploring — tell me more

═══════════════════════════════════════════════════════════════
```

### Step 2a: Existing Project Selected

```
═══════════════════════════════════════════════════════════════
YOUR PROJECTS
═══════════════════════════════════════════════════════════════
#  Project          Last Active    Next Action
───────────────────────────────────────────────────────────────
1  my-org     Dec 21         government-program demo prep
2  example-project       Dec 19         Maintenance mode
3  example-game  Dec 18         Feature dev paused
4  AI example-app     Dec 21         Orchestrator MVP
═══════════════════════════════════════════════════════════════

Which project? (enter number or name)
```

Then → session resume for selected project.

### Step 2b: New Project Selected

```
Two quick questions to set you up:

1. What are we building? (one sentence)
   > _

2. What does "done" look like? (one sentence)
   > _
```

Then → Project Card + optional scaffolding offer.

### Step 2c: Exploring Selected

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

## Flow 2: Returning User (session resume)

**Trigger:** `/zeos` with operator profile that has prior sessions.

**Duration Target:** < 10 seconds to context recovery

### Output: Resume Card

```
═══════════════════════════════════════════════════════════════
ZEOS BOOT COMPLETE
═══════════════════════════════════════════════════════════════
Agent: Claude (system)
Profile: {operator_id}
Phase: {current_phase}
Session: {new_session_id} (previous: {last_session})
═══════════════════════════════════════════════════════════════

Resume: {next_action_primer from last session}

Constraints carried:
• {constraint_1}
• {constraint_2}

Ready for directives.
```

**Key UX Principle:** The `next_action_primer` IS the magic. It tells the user exactly where we left off without them asking.

---

## Flow 3: App Boot (Specific Project)

**Trigger:** "Begin journaled session: {App}" or app-specific boot command.

### Output: App Resume Card

```
═══════════════════════════════════════════════════════════════
{APP NAME} SESSION LOADED
═══════════════════════════════════════════════════════════════
Agent: Claude (system)
Profile: {operator_id}
Application: {app_name}

{App-specific status line}
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
I can create a GitHub repo with standard structure:

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

## Setup Card Format (Standardized)

Used at project creation and major milestones.

```
═══════════════════════════════════════════════════════════════
PROJECT CARD: {Name}
═══════════════════════════════════════════════════════════════
Goal: {What are we building — one sentence}
Success: {What does done look like — one sentence}
Constraints: {Key limits: budget, time, tech, or "none"}
───────────────────────────────────────────────────────────────
Next Action: {Concrete step to take now}
Checkpoint: {When to save — default: "after any decision"}
═══════════════════════════════════════════════════════════════
```

**Design Rationale:**
- Fits on one screen (no scrolling)
- Answers: What? Why done? What limits? What now?
- Visual separators force attention

---

## Resume Card Format (Standardized)

Used on every boot with existing context.

```
═══════════════════════════════════════════════════════════════
{CONTEXT} BOOT COMPLETE
═══════════════════════════════════════════════════════════════
Agent: {Agent Name} ({Role})
Profile: {operator_id}
[Application: {app_name} — if app-specific]
Phase: {current_phase}
Session: {new_id} (previous: {last_id})
═══════════════════════════════════════════════════════════════

Resume: {next_action_primer}

Constraints:
• {constraint_1}
• {constraint_2}

[App-specific status lines if applicable]

Ready for directives.
```

---

## Proactive Behaviors (Future)

### Checkpoint Recommendation

**Trigger:** Significant decision made (detected via conversation analysis)

```
📌 Consider /snap — we just made a key decision worth saving.
```

**Not triggered by:** Timer, line count, or arbitrary thresholds.

### Token Warning

**Trigger:** Heuristic estimate of ~80% context used

```
📊 Context note: We've covered a lot this session.
   Consider /snap to preserve progress, or /end to start fresh.
```

**Tone:** Informational, not urgent. User decides.

---

## government-program Demo Script (Derived)

For the Dec 30 demo, this onboarding flow demonstrates:

1. **Speed of Recovery:** Boot → Resume Card in < 10 seconds
2. **Context Persistence:** `next_action_primer` shows we remember
3. **Cognitive Offload:** User doesn't re-explain; zeos already knows
4. **Professionalism:** Clean visual formatting, no clutter

**Demo Script:**
```
[Counselor watches]

Operator: "Boot zeos"
zeos: [Resume Card with next_action_primer]
Operator: "See? It remembers exactly where I left off."
zeos: [Continues seamlessly]
```

---

## Implementation Notes

### Where This Lives

- Onboarding logic: Encoded in BOOT_PROTOCOL behavior
- Card formats: Documented here, referenced by agents
- Proactive behaviors: Future module (not Day 1)

### What Changes

| Component | Change |
|-----------|--------|
| BOOT_PROTOCOL.md | Add onboarding flow reference |
| Shell Protocol | No change (commands already defined) |
| Session journals | Ensure `next_action_primer` always populated |

---

*ONBOARDING_SPEC v1.0.0 — Speed first, session resume*
*"The next_action_primer IS the magic."*
