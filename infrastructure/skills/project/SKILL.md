---
name: project
description: Load zeos project context and enable journaling
argument-hint: <project-name>
allowed-tools: Read, Glob, Bash, Write, mcp__zeos__zeos_boot, mcp__zeos__zeos_load_project
---

# /project Command

Load a specific project into the zeos session.

## Execution Steps

1. **Auto-Boot zeos** (if not already booted in this conversation):
   - If kernel context (SOUL, BOOT_PROTOCOL, SHELL_PROTOCOL) is NOT already loaded in this conversation:
     - Call `mcp__zeos__zeos_boot({ profile: "operator" })`
     - Display the boot splash output
   - If kernel context IS already present: skip boot, proceed to step 2

2. **Load Project:**
   - Call `mcp__zeos__zeos_load_project({ project: "$ARGUMENTS", agent: "claude" })`
   - This returns: SOUL, 3-tier memory (MEMORY.md + recent sessions + latest journal), journal stub, parallel instance check, git status

3. **Output Project Card:**
   Display project status from the MCP response:
   ```
   ┌─────────────────────────────────────────┐
   │ PROJECT: <name>                         │
   │ Status: <status>                        │
   │ Repo: <repo-path>                       │
   │ Context: <context-path>                 │
   │ Active Blueprint: <blueprint or none>   │
   │ Last Session: <date>                    │
   │ Journal: <journal-path>                 │
   └─────────────────────────────────────────┘
   ```

## Fallback: Manual File Reading

If the zeos MCP server is unavailable, follow these manual steps:

1. **Auto-Boot zeos** — same as above, but read kernel files manually per `/zeos` SKILL.md fallback

2. **Lookup Project** in PROFILE.md fleet table:
   - Read `~/projects/zeos/profiles/operator/PROFILE.md`
   - Find project entry matching `$ARGUMENTS`
   - Extract: repo path, context path, status

3. **Load Project Context:**
   - Read project SOUL.md from context path (e.g., `~/projects/zeos-apps/<name>/SOUL.md`)
   - Read project STATE.md if exists
   - Read latest session journal from `session-journals/`

4. **Create Journal Stub** (parallel instance detection):
   ```bash
   JOURNAL_DIR="<context-path>/session-journals"
   DATE=$(date +%Y-%m-%d)
   SEQUENCE=$(ls $JOURNAL_DIR/$DATE-* 2>/dev/null | wc -l | tr -d ' ')
   SEQUENCE=$((SEQUENCE + 1))
   STUB="$JOURNAL_DIR/$DATE-$(printf %03d $SEQUENCE)-claude.md"
   ```

   Write stub with frontmatter:
   ```yaml
   ---
   date: YYYY-MM-DD
   sequence: N
   instance: claude
   status: active
   ---
   # Session Journal
   ```

5. **Load Active Blueprint** if set in STATE.md

6. **Output Project Card** (same format as step 3 above)

## Arguments

- `$ARGUMENTS` - Required project name (e.g., `example-project`, `zeos-dev`)

## Example

```
/project example-project
```

Auto-boots zeos if needed, loads example-project project context, creates journal stub, ready for work.
