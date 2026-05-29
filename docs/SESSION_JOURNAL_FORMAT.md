---
document: "SESSION_JOURNAL_FORMAT"
version: "1.0.0"
status: "ACTIVE"
created: "2025-12-17"
author: "Claude (Architect)"
authority: "Operator"
module_type: "constraint"
load_priority: 5
---

# Session Journal Format Specification

## Purpose

Session journals are the **continuity mechanism** of zeos. They enable any AI agent to reconstruct the "alive state" from a previous session by providing both machine-parsable state data and human-readable reasoning.

This hybrid format serves two audiences:
1. **AI Agents** — Parse the YAML header for rapid state reconstruction
2. **Human Operators** — Read the prose for context, reasoning, and audit

---

## Format Structure

Every session journal consists of two parts:

```
┌─────────────────────────────────────┐
│         YAML HEADER                 │  ← Machine-parsable
│   (State, Decisions, Actions)       │     Boot payload
├─────────────────────────────────────┤
│                                     │
│         MARKDOWN BODY               │  ← Human-readable
│   (Context, Reasoning, Narrative)   │     Institutional memory
│                                     │
└─────────────────────────────────────┘
```

---

## YAML Header Specification

The header is enclosed in YAML front matter (`---`) and contains structured data for rapid parsing.

### Required Fields

```yaml
---
# IDENTITY
session_id: "string"          # Format: YYYY-MM-DD-NNN (e.g., "2025-12-17-001")
date: "YYYY-MM-DD"            # ISO date
agent: "string"               # Agent name (e.g., "claude", "grok")

# STATE
status: "enum"                # ACTIVE | COMPLETE | INTERRUPTED | CHECKPOINT
phase: "string"               # Current phase from MISSION.md
modules_loaded: ["array"]     # Module IDs loaded this session

# PARTICIPANTS  
participants: ["array"]       # All entities involved (e.g., ["claude", "operator"])
operator_present: boolean     # Was human operator in session?

# CONTINUITY
previous_session: "string"    # session_id of prior session (null if first)
continued_in: "string"        # session_id of next session (null if latest)

# DECISIONS (machine-extractable)
decisions:
  - id: "string"              # Unique decision identifier
    decision: "string"        # What was decided
    authority: "string"       # Who decided (operator | agent | board)
    rationale: "string"       # Brief reason (detail in prose)

# STATE CHANGES (machine-extractable)
state_changes:
  - entity: "string"          # What changed
    from: "string"            # Previous state
    to: "string"              # New state
    commit: "string"          # Git SHA if applicable

# ACTION ITEMS (machine-extractable)
open_items:
  - id: "string"              # Item identifier  
    description: "string"     # What needs to be done
    owner: "string"           # Responsible party
    priority: "enum"          # HIGH | MEDIUM | LOW
    status: "enum"            # PENDING | IN_PROGRESS | BLOCKED | COMPLETE

# ARTIFACTS
commits: ["array"]            # Git SHAs committed this session
files_created: ["array"]      # New files created
files_modified: ["array"]     # Existing files changed

# META
boot_time_ms: integer         # How long boot took (optional)
token_estimate: integer       # Approximate tokens used (optional)
---
```

### Optional Fields

```yaml
# ERROR TRACKING
errors:
  - type: "string"            # Error category
    message: "string"         # Error description
    resolution: "string"      # How it was resolved

# CAPABILITY USAGE
capabilities_used: ["array"]  # capability_ids from Registry

# CROSS-REFERENCES
related_sessions: ["array"]   # Other relevant session_ids
decision_packet: "string"     # If responding to a Decision Packet
edb_produced: "string"        # If EDB was generated
```

---

## Markdown Body Specification

The body follows the YAML header and contains human-readable prose.

### Required Sections

```markdown
# Session: {session_id}

## Objective

[One paragraph: What this session set out to accomplish]

## Summary

[2-3 paragraphs: What actually happened, key outcomes]

## Decisions & Rationale

[For each significant decision, explain the reasoning. 
This is where the "why" lives that can't fit in YAML fields.]

### Decision: {decision_id}

**Context:** [What led to this decision]
**Options Considered:** [What alternatives existed]  
**Chosen Path:** [What was decided]
**Rationale:** [Why this choice over others]

## Work Performed

[Detailed account of what was done, in chronological or logical order]

## Open Items

[Expanded context on pending work. The YAML captures WHAT; 
this explains WHY it's pending and WHAT the next agent needs to know]

## Handoff Notes

[Critical context for the next session. What would you want to know 
if you were booting into this project fresh?]
```

### Optional Sections

```markdown
## Lessons Learned

[Insights that should inform future work]

## Risks & Concerns

[Issues identified but not resolved]

## Operator Notes

[Direct input from human operator, if captured]
```

---

## Example: Complete Session Journal

```yaml
---
session_id: "2025-12-17-001"
date: "2025-12-17"
agent: "claude"
status: "COMPLETE"
phase: "0.5 - Constitution Ratified"
modules_loaded: ["PROFESSIONAL_STANDARD"]
participants: ["claude", "operator", "gemini", "chatgpt"]
operator_present: true
previous_session: "2025-12-16-006"
continued_in: null
decisions:
  - id: "DEC-001"
    decision: "Ratify ZEOS_ARCH_SPEC.md as Constitution"
    authority: "operator"
    rationale: "Establishes formal OS architecture before roadmap"
  - id: "DEC-002"  
    decision: "Separate OS/App concerns in MISSION.md"
    authority: "board"
    rationale: "Peer review identified conflation as architectural drift"
state_changes:
  - entity: "docs/ZEOS_ARCH_SPEC.md"
    from: "non-existent"
    to: "v0.1 ratified"
    commit: "c8d8f15"
  - entity: "docs/MISSION.md"
    from: "v3 (conflated)"
    to: "v4 (separated)"
    commit: "fb0bcbd"
open_items:
  - id: "ITEM-001"
    description: "Formalize PROFESSIONAL_STANDARD as Module #001"
    owner: "claude"
    priority: "HIGH"
    status: "PENDING"
commits:
  - "c8d8f15"
  - "73d281f"
  - "2016463"
  - "beea235"
  - "fb0bcbd"
files_created:
  - "docs/ZEOS_ARCH_SPEC.md"
  - "docs/archive/ZEOS_DEFINITION_deprecated_2025-12-17.md"
files_modified:
  - "docs/ZEOS_PREFERENCES.md"
  - "docs/MISSION.md"
---

# Session: 2025-12-17-001

## Objective

Ratify the zeos Constitution (Architecture Specification) and align all documentation with the formal OS/App boundary defined therein.

## Summary

This session marked a pivotal moment in zeos development: the transition from informal understanding to formal specification. The Architecture Specification was drafted, peer-reviewed by Gemini and ChatGPT, refined based on their feedback, and committed as the governing document.

Key refinements from peer review included:
- Genericizing "Operator" to "Operator" at OS level
- Renaming "personality" module type to "agent_profile"  
- Explicitly stating that AI example-app is an APPLICATION, not the OS itself

The MISSION.md document was rewritten to reflect this separation, establishing Phase 0.5 as the current state.

## Decisions & Rationale

### Decision: DEC-001 — Ratify Constitution

**Context:** zeos had grown organically with informal documentation. Terms like "kernel," "module," and "alive state" were used without formal definition.

**Options Considered:**
1. Continue informal development
2. Create lightweight glossary
3. Full architecture specification

**Chosen Path:** Full architecture specification

**Rationale:** The Operator observed that attempting to build a roadmap without formal definitions would create architectural drift. The Board concurred: specification before roadmap.

### Decision: DEC-002 — OS/App Separation

**Context:** MISSION.md and ZEOS_PREFERENCES.md conflated zeos (the OS) with AI example-app (an application). This created ambiguity about what belonged at each layer.

**Options Considered:**
1. Keep documents combined
2. Light separation with notes
3. Full restructure with explicit boundaries

**Chosen Path:** Full restructure

**Rationale:** ChatGPT's peer review identified that "Operator" and "Directors" are example-app concepts, not OS concepts. For zeos to support other applications, the OS must be neutral. Genericizing to "Operator" and "Agents" enables this.

## Work Performed

1. Drafted `ZEOS_ARCH_SPEC.md` v0.1 with full specification
2. Submitted to ChatGPT and Gemini for peer review
3. Applied four refinements from peer review
4. Committed Constitution to main branch
5. Fixed Truth Integrity issue in ZEOS_PREFERENCES.md
6. Archived superseded ZEOS_DEFINITION.md
7. Rewrote MISSION.md to separate OS from App concerns
8. Defined this Hybrid Session Journal format

## Open Items

### ITEM-001: Formalize PROFESSIONAL_STANDARD as Module #001

The PROFESSIONAL_STANDARD.md document has been operating as a de facto kernel module but lacks the formal header structure defined in ZEOS_ARCH_SPEC.md. It should be the first document migrated to the new module format.

**Next agent should:** Read ZEOS_ARCH_SPEC.md Section 2.2 (Module Specification), then reformat PROFESSIONAL_STANDARD.md to comply.

## Handoff Notes

**Critical context for next session:**

1. The Constitution is now law. All work must comply with `ZEOS_ARCH_SPEC.md`.
2. MISSION.md reflects Phase 0.5. We are NOT in Phase 1 yet.
3. The hybrid journal format you're reading is the new standard.
4. PROFESSIONAL_STANDARD needs formal module headers.
5. government-program demo is December 30. The "alive state pulse" demo should use this journal format to prove continuity.

---

*Session complete. Claude (Architect) — 2025-12-17*
```

---

## File Naming Convention

```
~/.zeos/journals/<app_id>/{YYYY-MM-DD}-{NNN}-{agent}.md

Examples:
- ~/.zeos/journals/zeos-dev/2026-05-29-001-claude.md
- ~/.zeos/journals/zeos-dev/2026-05-29-002-gemini.md
```

**Numbering:** Sequential within date. First session of day is `001`, second is `002`, etc. The agent identifier is a filename suffix so parallel instances do not collide.

---

## Validation Criteria

A session journal is valid if:

1. ✅ YAML header parses without error
2. ✅ All required fields present
3. ✅ `session_id` matches filename
4. ✅ `status` is valid enum value
5. ✅ At least one section present in Markdown body
6. ✅ Decisions in header have corresponding rationale in body

---

## Boot Integration

When an agent boots into zeos, the session journal serves as the **Task layer** context:

```
Boot Sequence:
1. SOUL.md       → Who we are (permanent)
2. MISSION.md    → What we're doing (phase-level)  
3. Latest Journal → Where we left off (session-level)
```

The YAML header enables rapid state reconstruction:
- Parse `decisions` to understand what was decided
- Parse `open_items` to see what's pending
- Parse `state_changes` to know what moved

The Markdown body provides the reasoning context that helps the agent understand *why* things are the way they are.

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-12-17 | Claude (Architect) | Initial specification |

---

*This format specification is a zeos kernel document.*
*Changes require Operator approval.*
