# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Identity

Inter-agent relay infrastructure — enables AI agents to observe each other's terminal output via MCP. Bridges isolated terminal sessions running Claude Code, Gemini CLI, etc.

## Commands

```bash
# Run MCP server
.venv/bin/python -m overseer.server

# Run tests
pytest tests/

# Run single test
pytest tests/test_server.py::test_function_name -v

# Run fast tests only (skip 30s polling tests)
pytest tests/ -k "not subscribe_timeout and not subscribe_waits"

# Install in development mode
pip install -e ".[dev]"
```

## Architecture

```
              ┌─────────────┐
              │  Operator  │
              │  (Human)    │
              └──────┬──────┘
                     │ issues task
                     ▼
              ┌─────────────┐
              │  Director   │
              │  (Gemini)   │
              └──────┬──────┘
                     │ coordinates via relay
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Claude  │ │ Claude  │ │ Codex   │
   │ Worker  │ │ Worker  │ │ Worker  │
   └─────────┘ └─────────┘ └─────────┘
        │            │            │
        └────────────┴────────────┘
                     │
         ┌───────────▼───────────┐
         │   overseer-mcp        │
         │   ├─ server.py        │ ← FastMCP server (11 tools)
         │   ├─ detector.py      │ ← State detection heuristics
         │   ├─ hive.py          │ ← Task/Worker dataclasses
         │   └─ agents/          │ ← Worker implementations
         └───────────────────────┘
                     │
         ┌───────────▼───────────┐
         │  ~/.overseer/relay.db │ ← SQLite message relay
         └───────────────────────┘
```

**Data Flow:**
- `server.py` — FastMCP server exposing 11 MCP tools
- `detector.py` — StateDetector class with regex heuristics for Claude/Gemini state detection
- `hive.py` — Task, TaskContext, Heartbeat, Worker base class, and protocol dataclasses
- `agents/` — StandardWorker, ClaudeWorker, CodexWorker implementations with heartbeat support
- SQLite DB at `~/.overseer/relay.db` — message relay with threading (type, ref_id)

## MCP Tools

| Tool | Purpose |
|------|---------|
| `get_agent_output(agent, lines)` | Capture terminal via tmux capture-pane |
| `post_message(agent, content, msg_type, ref_id)` | Post to relay with optional threading |
| `get_messages(since_id, agent_filter)` | Retrieve messages from relay |
| `subscribe(since_id, timeout, filter_type, filter_agent)` | Long-poll for new messages with filtering |
| `send_to_agent(agent, message, interrupt_if_busy, verify)` | Type into agent's terminal with busy-check |
| `list_agents()` | List tmux sessions |
| `detect_state(agent)` | Detect IDLE/WORKING/WAITING/ERROR state |
| `listen_for_task(worker_name, timeout, since_id)` | Worker listens for TASK_ASSIGN |
| `dispatch_task(director, worker, task_id, description, priority)` | Director assigns task |
| `post_heartbeat(worker, task_id, progress_pct, current_action)` | Worker posts progress |
| `get_worker_heartbeats(workers)` | Director queries fleet health |

## Key Types

```python
# Message types for structured relay
MessageType: task | response | query | ack | status | raw
           | task_assign | task_accept | task_complete | task_blocked | heartbeat

# Agent states (priority: ERROR > WAITING > WORKING > IDLE)
AgentState: idle | working | waiting | error | unknown

# Worker health states (Coordination Multiplier Protocol)
Health: HEALTHY | STALE | STUCK | CRASHED
```

## Team Protocol

Director/Worker task flow:
1. Director calls `dispatch_task()` → posts TASK_ASSIGN
2. Worker calls `listen_for_task()` → receives assignment
3. Worker posts TASK_ACCEPT
4. Worker posts HEARTBEAT every 60s during execution
5. Worker posts TASK_COMPLETE with result

## Coordination Multiplier (Heartbeat Protocol)

Workers signal progress during long tasks:
- **HEALTHY**: Heartbeat within 2x interval
- **STALE**: No heartbeat for 2x interval
- **STUCK**: Heartbeat received but terminal_hash static 5+ min
- **CRASHED**: No heartbeat AND no activity 10+ min

## Team Isolation & Security (Mandatory)

The system enforces **Strict Team Isolation** based on tmux session suffixes (e.g., `claude-3` = Team 3).

*   **Identification:** All relay tools (`get_messages`, `subscribe`, `get_worker_heartbeats`) **REQUIRE** the `requesting_agent` parameter (e.g., `claude-3`).
*   **Enforcement:** Access is denied if the agent lacks a numeric team suffix.
*   **Partitioning:** All DB queries strictly filter by `team_id`. Teams cannot read cross-team traffic.
*   **Hygiene:** 24-hour message TTL; legacy NULL/empty `team_id` records are auto-purged on startup.

## Communication Governance (The Two-Step Rule)

When using `send_to_agent` to trigger command execution, you MUST use two separate calls:

1.  **Instruction:** `send_to_agent(agent, message="command")`
2.  **Execution:** `send_to_agent(agent, message="")`

*Mechanism: The server-side `send_to_agent` tool always appends a `tmux send-keys Enter` after the message. The second call with an empty message sends only the 'Enter' key, executing the command typed in step 1.*

## MCP Tools (v1.1 Updates)

| Tool | Usage Requirement |
|------|-------------------|
| `get_messages(requesting_agent, ...)` | `requesting_agent` is MANDATORY. |
| `subscribe(requesting_agent, ...)` | `requesting_agent` is MANDATORY. |
| `get_worker_heartbeats(requesting_agent, ...)` | `requesting_agent` is MANDATORY. |
| `post_message(agent, ...)` | `team_id` is auto-injected from `agent` name. |
| `listen_for_task(worker_name, ...)` | `worker_name` must have a numeric team suffix. |
| `dispatch_task(...)` | Validates Director/Worker are on the same team. |

## Codex Integration (2026-05-04)

Overseer's MCP surface is dual-client: Claude Code's TypeScript MCP client and
Codex's Rust MCP client (`rmcp`) both connect to the same FastMCP server. The
Rust client is stricter than the TS one about response envelopes, so a few
guardrails are in place specifically for Codex.

### Wire envelope (Codex-safe)

`get_messages`, `subscribe`, and `debug_get_messages` previously returned a
top-level `list[dict]`, which Codex rejected as **"Unexpected response type"**.
They now return:

```json
{"status":"ok","messages":[...],"count":N,"timed_out":false}
```

`subscribe` sets `timed_out:true` (and an empty `messages`) when the long-poll
elapses without a match. The denial path remains the legacy
`{"status":"denied","error":"..."}` dict — unchanged.

**Caller migration:** anything that previously did `for msg in result` must now
do `for msg in result.get("messages", [])`. Both clients still read the new
shape transparently.

### Team identity for Codex agents

Strict team isolation requires `requesting_agent` to carry a numeric suffix
(`codex-1`, `codex-3`, `bridge-0`). To bridge a Codex shell that doesn't run
inside a `codex-N` tmux session, set `OVERSEER_DEFAULT_TEAM_ID=N` in the
environment — bare agent names will resolve to that team for the requester
only (cross-team validation against a *target* still uses strict
`extract_team`). `OVERSEER_DEFAULT_TEAM_ID="0"` is honored only for the
explicit `bridge-0` agent.

Recommended canonical pairing: `claude-1` ↔ `codex-1`, `claude-2` ↔ `codex-2`.

### tmux multi-socket discovery

By default, agent discovery (`list_agents`, `send_to_agent`, `get_agent_output`,
state detection) enumerates the OS default tmux socket *and* the
`zeos-lanes` socket used by paired lanes — so codex panes inside a
paired lane are visible without extra config. Override the list via
`OVERSEER_TMUX_SOCKETS=<csv>` (priority order; first match wins). The literal
`default` token represents the unflagged socket; any other token is passed as
`tmux -L <token>`.

LOE: `LOE-zeos-overseer-codex-relay-compat`.

## N-Pair Intercom (2026-05-05)

The relay supports **N concurrent tmux pairs** with strict per-pair isolation
via the additive `pair_registry` table. Identity flows: operator-meaningful
`pair_id` (text, e.g., `pair_eleet_brand`) → unique numeric `team_id` ≥ 1000
(auto-allocated) → participant identities `claude-<team_id>` /
`codex-<team_id>` for every relay call.

**Capability vs fleet readiness:** this surface makes N-pair routing possible.
It does NOT auto-retrofit currently running paired lanes. Live retrofit
requires a separate lane launcher / operator registration LOE — each pair
must be `register_pair`-d, and its agents must use `claude-<team_id>` /
`codex-<team_id>` for every relay call.

### New MCP tools (all authenticated; all return Codex-safe dict envelopes)

| Tool | Purpose |
|------|---------|
| `register_pair(requesting_agent, pair_id, claude_session=None, codex_session=None, socket="zeos-lanes", description=None, team_id=None)` | Register or idempotently update a pair. Auto-allocates team_id ≥ `OVERSEER_PAIR_TEAM_ID_BASE` (default 1000) if not supplied. team_id is **immutable** post-creation. |
| `unregister_pair(requesting_agent, pair_id)` | Owner-only; bridge-0 may unregister any pair. **Tombstones** the row (active=0, unregistered_at=NOW) instead of DELETE — preserves evidence. **team_id is never recycled.** Reactivation of a tombstoned pair_id is denied; reactivation is a separate LOE. |
| `list_pairs(requesting_agent, include_others=False)` | Default returns ONLY the requester's own pair. `include_others=True` requires `bridge-0` and returns all pairs. |
| `resolve_pair(requesting_agent, pair_id=None, team_id=None)` | Authenticated metadata lookup. Cross-pair resolution requires `bridge-0`. |

### Allocation rules

- Auto-allocated team_ids are monotonic, ≥ `OVERSEER_PAIR_TEAM_ID_BASE` (env, default `1000`).
- The allocator scans **every team-scoped surface** — `pair_registry` (active and tombstoned), `messages`, `heartbeats`, `worker_cursors`, `pane_registry`, `audit_log`, and numeric `agent_aliases.team_id` — taking the max. **Pair team_ids are durable, non-recycled reservations.** Even when all message/heartbeat/cursor rows are empty, a tombstoned `pair_registry` row keeps the team_id permanently retired.
- Explicit `team_id < OVERSEER_PAIR_TEAM_ID_BASE` is **always denied — including for `bridge-0`**. There is no override env var. Legacy low-ID interop (binding a pair to existing team 1 / 2 / 42) requires a separate Operator-authorized LOE.
- Explicit `team_id` reuse is **denied when ANY team-scoped surface has rows for it without an active registry owner** (messages, heartbeats, worker_cursors, pane_registry, audit_log, agent_aliases). The denial cites the surface where evidence was found. Bridge-0 has no override.
- Non-numeric team_id → denied.
- `pair_id` is the PRIMARY KEY; `team_id` is UNIQUE — re-registering a pair with a different supplied team_id is denied. Re-registering a tombstoned `pair_id` is denied (out of scope for this LOE).

### Authorization model

| Caller | What they can do |
|---|---|
| `bridge-0` (with `OVERSEER_DEFAULT_TEAM_ID="0"`) | register / unregister / resolve / list any pair. Cross-pair admin surface. |
| `claude-<N>` / `codex-<N>` for `N ≥ BASE` (registered owner) | Self-registration; idempotent re-registration of own pair; resolve own pair; list own pair; unregister own pair. |
| Bare `codex` / `claude` (no team) | Denied unless `OVERSEER_DEFAULT_TEAM_ID` is set in the MCP-server env. Never granted bridge access. |
| Empty `requesting_agent` | Denied. No anonymous pair tools. |

### Denial dict shape (Codex-safe; metadata-leak-guarded)

```json
{"status":"denied","error":"<exact-message>","pair_id":"<echoed-from-input>"}
```

Denial dicts NEVER include `claude_session`, `codex_session`, or `socket`.
This invariant is locked by `test_pair_authorization::_assert_no_metadata_leak`.

### Examples

```python
# Operator (bridge-0) registers a pair with explicit team_id.
register_pair(
    requesting_agent="bridge-0",
    pair_id="pair_eleet_brand",
    claude_session="%7",
    codex_session="%6",
    socket="zeos-lanes",
    team_id="1042",
)
# → {"status":"ok","pair_id":"pair_eleet_brand","team_id":"1042","created":True,...}

# Self-registration with auto-allocation.
register_pair(
    requesting_agent="claude-1043",
    pair_id="pair_nwra_api",
)
# → {"status":"ok","team_id":"1043","auto_allocated":True,...}

# Pair-scoped relay traffic uses claude-<team_id> / codex-<team_id>.
post_message("claude-1042", "hello pair")
get_messages(requesting_agent="codex-1042", since_id=0)
# → only sees team-1042 messages; team-1043 is invisible by construction.

# Bridge view of all pairs.
list_pairs(requesting_agent="bridge-0", include_others=True)
```

### Env vars

- `OVERSEER_PAIR_TEAM_ID_BASE` — minimum auto-allocated team_id (default `1000`). Non-numeric or non-positive values fall back to default with a warning.

LOE: `LOE-zeos-overseer-npair-tmux-intercom`.

Phase 4 (Team Protocol) in progress:
- Phase 1: tmux capture MVP ✓
- Phase 2: Bidirectional comms + message threading ✓
- Phase 3: State detection + rate limiting + caching ✓
- Phase 4: Team Protocol v1.0 + Coordination Multiplier ✓
- Pending: Dynamic scaling, consensus/voting, session persistence

## Mandatory Context

@docs/MASTER_ROADMAP.md
