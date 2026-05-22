# AGENT BRIEF — Overseer

## BLUF
Overseer is the inter-agent relay + Hive orchestration layer for zeos. It enforces **Team Isolation** (via numeric agent suffixes like `-1`, `-2`, `-3`) and exposes MCP tools for secure, partitioned communication.

## Critical Paths
- MCP entrypoint: `python -m overseer.server` (must use venv interpreter).
- Relay DB: `~/.overseer/relay.db` (table: `messages`).
- Teams: Delineated by tmux suffix (e.g., `claude-3` belongs to Team 3).

## Team Isolation & Security (Mandatory)
- **Identification:** All communication tools (`get_messages`, `subscribe`, `get_worker_heartbeats`) **REQUIRE** the `requesting_agent` parameter (e.g., `gemini-3`).
- **Access Denied:** Requests without a valid numeric team suffix or from unassigned agents are denied.
- **Strict Partitioning:** Teams cannot read or intercept messages from other teams.
- **Relay Hygiene:** Messages older than 24h are automatically purged. Legacy NULL `team_id` records are strictly forbidden and auto-deleted.

## Communication Governance (The Two-Step Rule)
When using `send_to_agent` to trigger command execution in another terminal, you MUST use a two-step process:
1.  **Instruction:** `send_to_agent(agent, message="command string")`
2.  **Execution (Enter):** `send_to_agent(agent, message="")`.
*Note: The server-side implementation of `send_to_agent` is hard-coded to always append a `tmux send-keys Enter` command. Sending an empty string in the second call ensures that only the 'Enter' key is sent, effectively triggering execution of the previously typed command string.*

## MCP Config (Required)
Use venv Python or system python with overseer installed.

Example:
```
"command": "~/projects/overseer/.venv/bin/python",
"args": ["-m", "overseer.server"]
```

## Heartbeat + Frozen Detection (Coordination Multiplier)
- Heartbeat interval default: 60s (task-aware; longer for expected_duration_sec > 300).
- STUCK threshold: 5 min static WORKING output.
- STALE threshold: 10 min no output changes.
- Loop detection: 5x identical tail line repeat.
- Worker heartbeat thread runs during task execution (non-blocking).

## Key Files
- MCP server: `src/overseer/server.py`
- Detector: `src/overseer/detector.py`
- Hive schema: `src/overseer/hive.py`
- Worker bootstrap: `src/overseer/agents/bootstrap_worker.py`
- Standard worker: `src/overseer/agents/claude_worker.py`

## Tests
- Run in venv: `.venv/bin/python -m pytest -q`
- If using system python: `PYTHONPATH=src python3 -m pytest -q`

## Direct Relay Access (MCP down)
SQLite read/write:
- DB: `~/.overseer/relay.db`
- Messages table: `messages(id, agent, content, type, ref_id, timestamp)`

## Known Friction Points
- `python` may not exist on PATH; use `.venv/bin/python` explicitly.
- System python cannot import `overseer` unless installed (editable or site-packages).

## Operating Doctrine
- GitHub is source of truth. No drift.
- Changes must be committed before deployment.
- Prefer reactive diagnosis: subscribe to heartbeats; only call detect_state/get_agent_output when late.
