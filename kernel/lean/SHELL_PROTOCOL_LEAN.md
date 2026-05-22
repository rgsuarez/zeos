---
module_id: "shell-protocol-lean"
version: "1.0.0"
lean_version_of: "modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md"
token_limit: "≤1,200 tokens"
updated: "2026-05-21"
---

# Shell Protocol — Lean

The compact command vocabulary loaded at lean-boot. Full spec: `modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md`.

## Trigger

- `/` prefix (Claude Code skill convention). First non-whitespace `/` plus a known command token.
- Implemented as Claude Code skills at `~/.claude/skills/`.

## v1.0.0 commands

| Command | Purpose |
|---|---|
| `/zeos [profile]` | Boot kernel + profile + governance. Usually implicit (called by `/project`). |
| `/project <id>` | Load a project. Auto-boots zeos if not loaded. |
| `/newproject <id> [opts]` | Register + scaffold a new project. Local-first; never pushes. |
| `/snap [note]` | Append a checkpoint to the active journal. |
| `/end` | Close the session: final journal + update MEMORY.md. |
| `/team <sub>` | Multi-agent orchestration (overseer MCP, optional). |

## Execution rules

- **Boot inviolability.** A session must be booted (`/zeos` or implicitly via `/project`) before any project-specific command runs. The inject MCP enforces this.
- **Checkpoint discipline.** `/snap` writes are append-only. Past entries are never rewritten.
- **The Bridge Rule.** Every `/snap` answers: *what does a future session need to know that it can't derive from code, git, the project's CLAUDE.md, or MEMORY.md?* No file lists. No command logs. Git has those.

## Command planes

- **Control plane** — slash commands. Machine-parsable, deterministic, never conversational.
- **Conversation plane** — natural language. Flexible.
- **Escape:** *"What does `/snap` do?"* = explain, not execute.

## MCP backing

Commands route through MCP tools provided by two servers:

- **`mcp__zeos__*`** — the inject MCP server (TypeScript). Tools: `zeos_boot`, `zeos_load_project`, `zeos_snap`, `zeos_end_session`, `zeos_fleet`, `zeos_help`, `zeos_memory_curate`.
- **`mcp__overseer__*`** — the overseer MCP server (Python). Tools for inter-agent messaging, team activation, paired-lane coordination. Used by `/team` and (optionally) by other skills.

Both are configured by the installer in `~/.claude.json` and `~/.mcp.json`.

## Failure modes

- `BOOT_REQUIRED` → run `/zeos` or `/project <id>` first.
- `PROJECT_NOT_FOUND` → `/newproject` or check `mcp__zeos__zeos_fleet`.
- `MCP_UNAVAILABLE` → re-run installer; check MCP config files.

---

*See full spec for argument reference, error codes, and the roadmap of deferred commands.*
