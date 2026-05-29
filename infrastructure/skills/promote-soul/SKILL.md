---
name: promote-soul
description: Promote a MEMORY.md entry's doctrinal sections to SOUL.md (dry-run by default)
argument-hint: entry-date section
allowed-tools: mcp__zeos__zeos_soul_promote
---

# /promote-soul Command

Promote an **active** MEMORY.md entry's durable sections (Why and How to Apply) to SOUL.md as a title-pointer + doctrine block. **Dry-run by default.** Summary body text stays in MEMORY (reachable via the title pointer in SOUL); operational sections (Final Bridge, Next Actions, References, Source Journal, Redactions) are NOT promoted. Archived entries are not promotable: restore with `/memory-curate promote ENTRY_DATE` first.

## Preferred Method: zeos MCP

> All fields are plain JSON strings. Do not wrap content in XML tags.

```
mcp__zeos__zeos_soul_promote({
  project: "PROJECT_ID",
  entry_date: "YYYY-MM-DD",
  entry_title: "ENTRY_TITLE_IF_AMBIGUOUS",
  section: "Constraints",
  dry_run: true
})
```

## Execution Steps

1. **Identify the entry**. Inspect MEMORY.md (e.g., `/memory-curate list` or `/memory-curate find TAG`). Use the date; if multiple entries share that date, pass `entry_title` to disambiguate.

2. **Choose the SOUL section**. Standard sections: Mission, Current Campaign, Constraints, Identity, Values. Pick the section that matches the nature of the entry.

3. **Preview first** (dry-run is the default). Call the tool with `dry_run: true` (or omit). Read the returned preview block.

4. **Commit**. If the preview looks correct, call again with `dry_run: false`.

5. **Confirm**. After commit, the source MEMORY entry is marked `[promoted:true]` (durable, model-level marker that survives parse/format round-trips). SOUL.md gains a "Promoted from MEMORY DATE: TITLE" pointer block under the named section, containing only the Why and How to Apply content. The Summary body remains in MEMORY. Idempotent: re-running with the same args is a no-op.

## Arguments

- `entry-date` (positional): Date of the MEMORY entry, YYYY-MM-DD.
- `section` (positional): SOUL.md section heading (case-sensitive).

## Example

```
/promote-soul 2026-05-22 Constraints
```

Returns a dry-run preview. If the preview is acceptable, re-invoke with `dry_run=false` to commit.
