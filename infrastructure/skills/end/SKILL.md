---
name: end
description: End zeos session, update MEMORY.md with summary
argument-hint:
allowed-tools: mcp__zeos__zeos_end_session, Bash
---

# /end Command

End the current zeos session. Updates MEMORY.md with session summary.

## Preferred Method: zeos MCP

Use the `zeos_end_session` MCP tool:

> All fields are plain JSON strings. Do not wrap content in XML tags.

```
mcp__zeos__zeos_end_session({
  project: "PROJECT_ID",
  handoff: "The whole session handoff as one plain-text block: what changed and why, current state, open threads, verification, and the next concrete actions."
})
```

`handoff` is the preferred shape: write the full handoff as one prose block, the
way you would brief a human picking this up cold. The legacy structured fields
(`summary`, `delta`, `nextActions`, `objective`, `state`, `open_threads`,
`verified`, `assumed`, `blockers`, `dead_ends`, `next_tactical_move`) remain
accepted for backward compatibility; prefer `handoff`.

**Additional MEMORY parameters (all optional, apply with `handoff` too):**

- `title` - explicit one-line title for the MEMORY entry (default: first content line of summary)
- `tags` - array of retrieval tags for MEMORY entry
- `importance` - 1-5, defaults to 3 (4+ never auto-archived, surfaces as SOUL promotion candidate)
- `why` - operator-facing rationale (renders as `### Why` in MEMORY entry)
- `how_to_apply` - guidance for future sessions (renders as `### How to Apply`)
- `refs` - array of file paths, PR numbers, or SHAs the entry references

## Execution Steps

1. **Identify Current Project** - Use the project ID from loaded context

2. **Synthesize Session Summary** - Create a MEMORY-ready entry:
   - Outcome: what changed in the project state.
   - Decisions: choices made and the rationale.
   - Persistent concepts: rules, preferences, constraints, or patterns that should survive 10-20 sessions.
   - Verification: tests, checks, review state, and remaining risk.

3. **Gather Final Delta** - Write a final Continuity Packet:
   - Current objective.
   - State of the world.
   - Decisions and assumptions.
   - Open threads.
   - Verification state.
   - Next tactical move.
   - Redact secrets before calling the MCP tool.

4. **Define Next Actions** - Clear handoff for next session:
   - What should be done next?
   - Any blockers or dependencies?
   - Context the next agent needs?

5. **Call MCP Tool** with all four required fields

6. **Git Operations**:
   - Do not commit or push unless the operator explicitly asked for it or project doctrine specifically authorizes it.
   - Never use `--no-verify`.
   - If changes remain local, name that in the final confirmation.

7. **Confirm Session End** - Output confirmation with summary

## What Gets Updated

- **Session Journal**: Marked as `status: complete`, final entry added
- **MEMORY.md**: Structured summary, final bridge, next actions, source journal, and redaction notice appended

## Arguments

None required. The command will prompt for summary, delta, and next actions if not provided.

## Example

```
/end
```

Ends session, prompts for summary/delta/nextActions, updates MEMORY.md.
