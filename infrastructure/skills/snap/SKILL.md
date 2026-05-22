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

The agent identifier is auto-resolved from your `/project` load — no need to pass it explicitly.

## Execution Steps

1. **Identify Current Project** - Use the project ID from the loaded project context

2. **Gather Bridge** - Answer: "What does a future session need to know that it can't derive from code, git history, CLAUDE.md, or MEMORY.md?"
   - **State of the World** — 1-3 sentences: what's different now vs before this session
   - **Open Threads** — In-progress work, pending decisions, known issues not in code/backlog/memory
   - **Context That Would Be Lost** — Debugging insights, Operator preferences, strategic decisions not yet persisted

3. **Call MCP Tool** with:
   - `project`: Current project ID
   - `delta`: Bridge content (state, open threads, context that would be lost)
   - `note`: Optional note from `$ARGUMENTS`

4. **Confirm** - Output snapshot confirmation

## The Bridge Rule

Every snapshot answers ONE question: "What does a future session need to know that it can't derive from code, git, CLAUDE.md, or MEMORY.md?"

**Do NOT capture:** File lists, command logs, artifacts produced — git has all of that.

**DO capture:** State changes, open threads, context that would die with the session.

## Arguments

- `$ARGUMENTS` - Optional note to include with snapshot

## Example

```
/snap Completed API endpoint refactor
```

Saves progress with note "Completed API endpoint refactor".
