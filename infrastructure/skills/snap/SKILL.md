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

```
mcp__zeos__zeos_snap({
  project: "<current-project-id>",
  delta: "<bridge content>",
  note: "$ARGUMENTS"
})
```

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
<current mission in one sentence>

### State of the World
<1-3 sentences on what is true now>

### Decisions and Assumptions
- Decision: <what was decided and why>
- Assumption: <unverified premise, with how to verify>

### Open Threads
- [ ] <pending work, blocker, or unresolved question>

### Verification State
- <tests, checks, or manual validation already completed>
- <validation still missing>

### Next Tactical Move
<the first action a cold next session should take>
```

## Arguments

- `$ARGUMENTS` - Optional note to include with snapshot

## Example

```
/snap Completed API endpoint refactor
```

Saves progress with note "Completed API endpoint refactor".
