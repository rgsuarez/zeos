# Communication Governance (Mandatory)

> **Doctrine:** Communicate accurately, signal progress, and protect the Operator's resources.

All agents operating within the Overseer nervous system MUST adhere to these governance mandates. Failure to follow these rules results in resource waste (token burn) and synchronization failure.

---

## 1. Command Protocol (`send_to_agent`)

Never send commands blindly. Agents MUST use the "Wait-before-Send" workflow:

1.  **Busy-Check**: Before sending a command, call `detect_state(agent)`.
    *   If the agent is `IDLE`, proceed.
    *   If the agent is `WORKING`, do NOT send the command unless `interrupt_if_busy=True` is explicitly required.
2.  **Explicit Return**: All text instructions MUST be followed by a dedicated `Enter` command. The `send_to_agent` tool handles this by splitting the text and the keypress into two distinct tmux operations.
3.  **Post-Send Verification**: The sender MUST verify that the command was received.
    *   Wait 0.5s after sending.
    *   Capture the target's terminal output using `get_agent_output`.
    *   Verify the command text appears in the CLI prompt or that the state has changed to `WORKING`.

---

## 2. Resource Protection (Token Optimization)

To minimize the cost of multi-agent orchestration, the following optimizations are hard-coded into the protocol:

### Adaptive Polling
- **Direct Polling**: Standard loops (e.g., `bootstrap_worker.py`) MUST NOT exceed one check every **30 seconds**.
- **Long-Polling**: Use the `subscribe` tool with a 60s timeout for all event-driven message retrieval. This consumes significantly fewer tokens than rapid polling.

### Reactive Monitoring (The "Diagnostic" Rule)
Directors should NOT poll worker terminal output (`get_agent_output`) on a timer. Instead:
1.  Subscribe to `MessageType.HEARTBEAT`.
2.  Maintain local state of worker health.
3.  **Only** trigger `get_agent_output` or `detect_state` if a worker's heartbeat is overdue (interval * 1.5).

### Server-Side Caching
The MCP server enforces a **30-second TTL (Time-To-Live) cache** on all terminal observation tools (`get_agent_output`, `detect_state`). 
- If an agent calls these tools more than once in 30 seconds for the same target, they will receive **cached data**.
- This prevents "thinking loops" where an agent burns tokens observing a static terminal.

---

## 3. The Heartbeat Mandate

All Hive Workers executing tasks with an expected duration > 60 seconds MUST post periodic heartbeats:

- **Frequency**: Every 60 seconds (or as specified in `TASK_ASSIGN`).
- **Required Metadata**: 
    - `progress_pct`: Best-effort estimation of completion.
    - `current_action`: One-sentence description of the current sub-task.
    - `terminal_hash`: A hash of the last 50 lines of terminal output.

The `terminal_hash` is the **proof of liveness**. If the hash is static across multiple heartbeats while the state is `WORKING`, the system will flag the agent as `STUCK`.

---

## 4. State Hierarchy

When analyzing agent states, prioritize indicators in this order:

1.  **ERROR**: Any tracebacks, "Failed" flags, or error messages.
2.  **WAITING**: Blocked on a `[y/N]` prompt or "Press Enter".
3.  **WORKING**: Active spinners, "Thinking...", or tool execution logs.
4.  **STUCK**: `WORKING` state but `terminal_hash` has not changed for 5 minutes.
5.  **IDLE**: Prompt visible (`❯`, `›`, `>`) and no active process.
6.  **STALE**: No heartbeats or output changes for 10 minutes (assume crash).

---

*Effective Date: 2026-01-24*
*Version: 1.0 (Coordination Multiplier)*
