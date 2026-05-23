# Inject MCP Server

> Context injection infrastructure for zeos boot optimization

## Overview

Inject is an MCP (Model Context Protocol) server that compiles zeos context into optimized payloads, reducing boot from ~10 tool calls to 1-2 calls with 85% token reduction.

## Features

- **Optimized Boot**: Lean-based kernel loading (~16KB vs ~106KB)
- **Project Context**: SOUL, STATE, journals, and git status in one call
- **Fleet Management**: Portfolio overview with status grouping
- **Persistence**: Checkpoint and session journaling with Bridge Rule
- **Parallel Detection**: Identify concurrent agents on projects

## Tools (8)

| Tool | Purpose |
|------|---------|
| `zeos_boot` | Boot zeos into Project mode |
| `zeos_load_project` | Load project context |
| `zeos_fleet` | Detailed portfolio view |
| `zeos_snap` | Save structured progress to journal |
| `zeos_end_session` | End session, update MEMORY.md, and return handoff |
| `zeos_help` | Command reference |
| `zeos_parallel` | Check for active instances |
| `zeos_memory_curate` | Curate MEMORY.md entries (stats, list, pin, unpin, delete, promote, merge, find) |

## Installation

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "inject": {
      "command": "node",
      "args": ["/path/to/inject/dist/index.js"]
    }
  }
}
```

Or create a project-local `.mcp.json`:

```json
{
  "mcpServers": {
    "inject": {
      "command": "node",
      "args": ["~/projects/inject/dist/index.js"]
    }
  }
}
```

### Building

```bash
npm install
npm run build
```

### Testing

```bash
# Regression tests (path resolver, write verification)
npm test

# List tools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js

# Test boot
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"zeos_boot","arguments":{}}}' | node dist/index.js
```

### Persistence response format

`zeos_snap` and `zeos_end_session` return the **absolute resolved path** of the journal that was written, and verify file existence on disk before reporting success. Contract:

- `zeos_snap` success: `✓ Checkpoint saved to /Users/<user>/projects/zeos/journals/<app_id>/<file>.md`
- `zeos_end_session` success: handoff text begins with `Journal: /Users/<user>/projects/zeos/journals/<app_id>/<file>.md`
- Either tool throws an MCP error if `fs.existsSync(journalPath)` fails after the write. No false-success path.

Persistence paths are centralized by `path-resolver.ts`:

- Project SOUL: `~/projects/zeos/souls/<app_id>/SOUL.md`
- MEMORY.md: `~/projects/zeos/memory/<app_id>/MEMORY.md`
- Journals: `~/projects/zeos/journals/<app_id>/`
- Project operations doctrine: `<project_root>/CLAUDE.md`

Journal entries use `schema_version: "2.0.0"` frontmatter. `/snap` accepts a backward-compatible `delta` plus structured continuity fields: `objective`, `state`, `open_threads`, `verified`, `assumed`, `blockers`, `dead_ends`, `next_tactical_move`, and `tags`. `/end` writes a MEMORY.md entry with `decay`, `importance`, `tags`, optional `why`, optional `how_to_apply`, optional `refs`, source journal path, and a redaction notice when secrets were removed before persistence.

Example registry entry:

```json
{
  "app_id": "zero-echelon",
  "repo": {
    "url": "https://github.com/my-org/my-repo",
    "branch": "main",
    "clone_path": "~/projects/my-org-website/"
  }
}
```

## Usage

Once configured, use zeos commands in Claude Code:

```
/zeos              # Boot zeos
/project inject    # Load project
/snap        # Save progress
/status            # Fleet overview
/fleet             # Detailed view
/end               # End session
```

## Architecture

```
inject/
├── src/
│   ├── index.ts           # MCP server entry + tool handlers
│   ├── path-resolver.ts   # SOUL/journal/memory/project path resolution
│   └── lib/               # Pure helpers (independently unit-testable)
│       ├── redact.ts      # Generic secret redaction (env-style, Bearer, PEM)
│       ├── bridge.ts      # Continuity Packet sections + normalizers
│       ├── memory.ts      # MEMORY.md parse/format + curation + constants
│       ├── journal.ts     # Session journal scan + atomic stub creation
│       ├── digest.ts      # Continuity digest parse + carry-forward block
│       ├── git-snapshot.ts # execFileSync-based git status capture
│       └── memory-find.ts # Tag-based MEMORY search
├── tests/
│   ├── path-resolver.test.mjs
│   ├── redact.test.mjs
│   ├── bridge.test.mjs
│   ├── memory.test.mjs
│   ├── git-snapshot.test.mjs
│   ├── digest.test.mjs
│   ├── journal.test.mjs
│   └── memory-find.test.mjs
├── dist/                  # Compiled output (mirrors src/ structure)
├── package.json
└── tsconfig.json
```

### Module Layout

The MCP server entry (`src/index.ts`) is intentionally thin: configuration, tool registration, and handler dispatch. Pure helpers live under `src/lib/` with matching unit tests under `tests/<module>.test.mjs`. Tests import from compiled `dist/lib/<module>.js`. The split follows the existing `src/path-resolver.ts` precedent.

### Carry-Forward Continuity

When `/project` loads a project, the previous session's Continuity Digest (open threads, decisions, next actions) is now:

1. Rendered at the TOP of the `/project` payload (above SOUL.md) under `## Carry-Forward from Previous Session`.
2. Seeded into the new journal stub immediately after the standard separator, giving the agent immediate resume context inside its own journal without having to scroll the boot payload.

When no prior digest exists (first session, MEMORY.md is empty), the carry-forward section is omitted from both the payload and the stub (no placeholder noise).

The Continuity Digest is parsed once from `MEMORY.md` and stripped from the tier-1 Long-Term Memory rendering so it is not duplicated.

### Tag Search

`/memory-curate <project> find <tag1,tag2,...>` searches active and archived MEMORY entries by tag. AND semantics: an entry must carry every requested tag to match. Case-insensitive. Tags are set at `/end` time via the `tags` parameter. Results list each match with its active/archived status, date, title, decay, importance, and tags.

### Payload Compilation

- **Kernel**: Loads from `~/projects/zeos/kernel/lean/` (optimized)
- **Profile**: Loads from `~/projects/zeos/profiles/{profile}/` (fleet table truncated)
- **Projects**: Context from `apps/REGISTRY.json`, project SOUL, project CLAUDE.md, MEMORY.md, and latest journals
- **Journals**: Written to `~/projects/zeos/journals/<app_id>/`

## Dependencies

- Node.js 18+
- zeos repository at `~/projects/zeos/`
- Project contexts at `~/clawd/projects/`

## License

MIT - my-org

---

*Part of the zeos ecosystem — "One operator. Infinite leverage."*
