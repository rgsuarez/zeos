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
| `zeos_status` | Quick fleet status overview |
| `zeos_fleet` | Detailed portfolio view |
| `zeos_checkpoint` | Save progress to journal |
| `zeos_end_session` | End session with handoff |
| `zeos_help` | Command reference |
| `zeos_parallel` | Check for active instances |

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

- `zeos_snap` success → `✓ Checkpoint saved to /Users/<user>/projects/<app_id>/session-journals/<file>.md`
- `zeos_end_session` success → handoff text begins with `Journal: /Users/<user>/projects/<app_id>/session-journals/<file>.md`
- Either tool throws an MCP error if `fs.existsSync(journalPath)` fails after the write — no false-success path.

Path resolution for `journal_location: "{repo}/session-journals/"` in `apps/REGISTRY.json` (precedence high → low):

1. `repo.clone_path` is set → use it verbatim. Required when the on-disk clone directory differs from `app_id` (e.g. `zero-echelon` → `~/projects/my-org-website/`). Trailing slash is normalized.
2. `repo.url` is set (and no `clone_path`) → `~/projects/<app_id>/session-journals/`. Convention: clone dir matches `app_id`.
3. No `repo` at all → `~/projects/zeos-apps/<local_path>/session-journals/` (zeos-apps shadow tree).

Example registry entry using `clone_path`:

```json
{
  "app_id": "zero-echelon",
  "repo": {
    "url": "https://github.com/my-org/my-repo",
    "branch": "main",
    "clone_path": "~/projects/my-org-website/"
  },
  "journal_location": "{repo}/session-journals/"
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
│   └── index.ts       # MCP server implementation
├── dist/              # Compiled output
├── package.json
└── tsconfig.json
```

### Payload Compilation

- **Kernel**: Loads from `~/projects/zeos/kernel/lean/` (optimized)
- **Profile**: Loads from `~/projects/zeos/profiles/{profile}/` (fleet table truncated)
- **Projects**: Context from `~/clawd/projects/{project}/`
- **Journals**: Written to `~/clawd/projects/{project}/sessions/`

## Dependencies

- Node.js 18+
- zeos repository at `~/projects/zeos/`
- Project contexts at `~/clawd/projects/`

## License

MIT — my-org

---

*Part of the zeos ecosystem — "One operator. Infinite leverage."*
