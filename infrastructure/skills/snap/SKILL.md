---
name: snap
description: Save progress snapshot to session journal
argument-hint: [note]
allowed-tools: mcp__zeos__zeos_snap
---

# /snap Command

Save a progress snapshot to the current session journal.

## Preferred Method: zeos MCP

Use the `zeos_snap` MCP tool:

> All fields are plain JSON strings. Do not wrap content in XML tags.

```
mcp__zeos__zeos_snap({
  project: "PROJECT_ID",
  handoff: "The whole snapshot as one plain-text block: objective, state now, open threads, verified vs assumed, blockers, dead ends, and the next tactical move.",
  note: "$ARGUMENTS"
})
```

`handoff` is the preferred shape: write the full snapshot as one prose block. The
legacy structured fields (`delta`, `objective`, `state`, `open_threads`,
`verified`, `assumed`, `blockers`, `dead_ends`, `next_tactical_move`) remain
accepted for backward compatibility; prefer `handoff`.

The agent identifier is auto-resolved from your `/project` load; no need to pass it explicitly.

**Structured parameters (all optional, populate what applies):**

- `objective` - current mission in one sentence
- `state` - what is true now (1-3 sentences)
- `open_threads` - array of unresolved items
- `verified` - array of facts verified this session
- `assumed` - array of unverified premises with how to verify
- `blockers` - array of dependencies or blockers
- `dead_ends` - array of approaches tried that didn't work
- `next_tactical_move` - first action a cold next session should take
- `tags` - array of retrieval tags
- `delta` - catch-all bridge content (required if no structured fields provided)

## Execution Steps

1. **Identify Current Project** - Use the project ID from the loaded project context

2. **Gather Bridge** - Answer: "What does a future session need to know that it can't derive from code, git history, CLAUDE.md, SOUL.md, or MEMORY.md?"
   - Use the Continuity Packet format below.
   - Mark assumptions explicitly. Do not present guesses as facts.
   - Include exact blockers, owner dependencies, and next tactical move when known.
   - Redact secrets before calling the MCP tool.

3. **Call MCP Tool** with:
   - `project`: Current project ID
   - `delta`: Continuity Packet content
   - `note`: Optional note from `$ARGUMENTS`

4. **Confirm** - Output snapshot confirmation

## The Bridge Rule

Every snapshot answers ONE question: "What does a future session need to know that it can't derive from code, git, CLAUDE.md, SOUL.md, or MEMORY.md?"

**Do NOT capture:** File lists, command logs, artifacts produced. Git has all of that.

**DO capture:** State changes, decisions, assumptions, open threads, verification state, and context that would die with the session.

## Continuity Packet Format

```markdown
### Objective
`CURRENT_MISSION_ONE_SENTENCE`

### State of the World
`STATE_DESCRIPTION_1_TO_3_SENTENCES`

### Decisions and Assumptions
- Decision: `DECISION_AND_RATIONALE`
- Assumption: `UNVERIFIED_PREMISE_WITH_VERIFICATION_PLAN`

### Open Threads
- [ ] `PENDING_WORK_OR_BLOCKER`

### Verification State
- `COMPLETED_VERIFICATION`
- `MISSING_VERIFICATION`

### Next Tactical Move
`FIRST_ACTION_COLD_SESSION_TAKES`
```

## Arguments

- `$ARGUMENTS` - Optional note to include with snapshot

## Example

```
/snap Completed API endpoint refactor
```

Saves progress with note "Completed API endpoint refactor".
