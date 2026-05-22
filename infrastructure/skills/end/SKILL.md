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

```
mcp__zeos__zeos_end_session({
  project: "<current-project-id>",
  summary: "<session summary for MEMORY.md>",
  delta: "<final work delta>",
  nextActions: "<handoff for next session>"
})
```

## Execution Steps

1. **Identify Current Project** - Use the project ID from loaded context

2. **Synthesize Session Summary** - Create brief summary of session accomplishments:
   - What was the goal?
   - What was achieved?
   - Key decisions made?

3. **Gather Final Delta** - Document any uncommitted work:
   - Files changed since last snapshot
   - Pending decisions
   - Work in progress

4. **Define Next Actions** - Clear handoff for next session:
   - What should be done next?
   - Any blockers or dependencies?
   - Context the next agent needs?

5. **Call MCP Tool** with all four required fields

6. **Git Operations** (if applicable):
   - Stage and commit any uncommitted changes
   - Push to remote if configured

7. **Confirm Session End** - Output confirmation with summary

## What Gets Updated

- **Session Journal**: Marked as `status: complete`, final entry added
- **MEMORY.md**: Session summary appended (long-term memory)

## Arguments

None required. The command will prompt for summary, delta, and next actions if not provided.

## Example

```
/end
```

Ends session, prompts for summary/delta/nextActions, updates MEMORY.md.
