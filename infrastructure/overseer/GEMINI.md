# Overseer Project Context for Gemini

## Project Overview
**Overseer** is an inter-agent relay infrastructure designed to break the isolation between AI agents running in separate terminal sessions (specifically `tmux`). It enables agents to observe each other's output, communicate via a message bus, and semantically detect each other's state.

This project is a critical component of **zeos** (Operating System for AI Collaboration), facilitating the "one pane of glass" philosophy where multiple agents (Claude Code, Gemini CLI, etc.) can collaborate on shared tasks.

## Architecture & Technology
*   **Language:** Python 3.12+
*   **Framework:** Model Context Protocol (MCP) using `mcp.server.fastmcp`.
*   **Infrastructure:**
    *   **Transport:** `tmux` (capture-pane, send-keys).
    *   **Storage:** SQLite (`~/.overseer/relay.db`) for message persistence.
*   **Core Components:**
    *   **Server (`src/overseer/server.py`):** The MCP server implementation providing tools.
    *   **State Detector (`src/overseer/detector.py`):** Semantic engine analyzing terminal patterns.
    *   **Team Protocol (`src/overseer/hive.py`):** Orchestration layer for Director/Worker loops.

## Coordination Multiplier Evolution (v1.0)
The system has been strengthened into an **intelligent shared nervous system** with the following core capabilities:

### 1. Intelligent Heartbeat Protocol
*   **Workers** execute background threaded loops to post `HEARTBEAT` messages every 60s.
*   Telemetry includes `progress_pct`, `current_action`, and a `terminal_hash` (activity proof).
*   **Tools:** `post_heartbeat`, `get_worker_heartbeats`.

### 2. Frozen & Loop Detection
*   **STUCK Detection:** If an agent is in `WORKING` state but its terminal hash remains static for 5+ minutes, it is flagged as `STUCK`.
*   **STALE Detection:** If no heartbeat or output change occurs for 10+ minutes, it is flagged as `CRASHED`.
*   **Loop signatures:** Regex-based detection for infinite repeating output loops (5x repetition).

### 3. Adaptive Polling & Token Conservation
*   **Reactive Monitoring:** Agent (Gemini) uses long-polling (`subscribe`) to listen for Heartbeats.
*   **Throttled Diagnostics:** Intensive tools like `get_agent_output` are only triggered if heartbeats are late (interval * 1.5).
*   **Server-Side Cache:** All terminal observation tools have a mandatory **30-second cache**. Frequent polling returns cached data to prevent token-burn.

## Communication Governance (Mandatory)
All agents MUST follow these rules when using `send_to_agent`. FAILURE TO COMPLY RISKS LOSS OF DIRECTOR STATUS.

1.  **Busy-Check:** Call `detect_state(agent)` first. Never interrupt a `WORKING` agent unless necessary.
2.  **Interrupts:** If an urgent interrupt is required, use `interrupt_if_busy=True` to send a `C-c` signal.
3.  **DOUBLE TAP (The "Enter" Rule):**
    *   **Rule:** The `send_to_agent` tool is FLAKY with newlines. You MUST send a separate `send_to_agent(agent, "")` IMMEDIATELY after any command to force the Enter key.
    *   **Reason:** NEVER assume the tool sent the newline. Explicitly send it yourself.
    *   **Pattern:** `send_to_agent(agent, "command")` -> `send_to_agent(agent, "")`.
4.  **VERIFICATION (The "Prompt" Rule):**
    *   **Rule:** Look at the `post_output_preview` in the tool response.
    *   **Check:** If you see your command sitting at the prompt (e.g., `> /run command` with no output below it), **IT DID NOT EXECUTE.**
    *   **Action:** Send another carriage return immediately.
6.  **AGENT-SPECIFIC CONSTRAINTS:**
    *   **Codex:** Does NOT understand `/run` commands. It will reject them with "Unrecognized command". You must use its native Python execution or direct prompts.
    *   **Claude:** Supports `/run` for tool execution.
5.  **PATIENCE (The "20-Second" Rule):**
    *   **Rule:** When delegating tasks, you MUST wait at least **20 seconds** before checking `get_agent_output`.
    *   **Reason:** Agents need time to wake up, read the relay, and process. Checking too soon creates noise and wastes tokens. Do not micromanage.

## Team Isolation & Security (v1.1)
The system enforces **Hardened Programmatic Isolation** between teams:
*   **Team Identity:** Derived from tmux agent suffix (e.g., `gemini-3` -> Team 3).
*   **Mandatory requesting_agent:** Every relay tool call (`get_messages`, `subscribe`, etc.) REQUIRES the caller to identify themselves.
*   **Logical Partitioning:** Strict `WHERE team_id = ?` enforcement in all DB queries. Legacy NULL data is purged.
*   **Relay Hygiene:** 24-hour message TTL with throttled pruning.

## Key Files
*   `src/overseer/server.py`: MCP server with 30s tool caching and Heartbeat registry.
*   `src/overseer/detector.py`: State detector with hash tracking and loop heuristics.
*   `src/overseer/hive.py`: Task schema with `expected_duration_sec` and `heartbeat_interval_sec`.
*   `src/overseer/agents/bootstrap_worker.py`: Implementation of the 30s-poll worker loop.
*   `docs/HIVE_PROTOCOL.md`: Full specification of agent communication rules.

## Building and Running

### Permanent MCP Fix
The MCP server MUST be launched using the virtual environment Python to ensure stability:
```bash
~/projects/overseer/.venv/bin/python -m overseer.server
```
Configuration is persisted in `.mcp.json` at both the project root and home directory.

### Running Tests
Use `pytest` with `PYTHONPATH=src`:
```bash
PYTHONPATH=src pytest tests/
```

## Hive Fleet Status
The fleet is currently synchronized and heartbeating with 8 active agents:
- **Gemini-1/2/3**: Agent (Orchestration & Reactive Diagnosis)
- **Claude-1/2/3**: Worker (General execution, HEARTBEAT enabled)
- **Codex-1/2**: Worker (Python/ML specialization, HEARTBEAT enabled)

## Vision: Autonomous Multi-Agent Orchestration
**End State:** A resilient, token-efficient shared nervous system where agents autonomously detect failures, signal progress, and co-execute complex Operator directives with 0% resource waste.