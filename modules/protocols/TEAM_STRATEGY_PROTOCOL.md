---
module_id: "team-strategy"
module_type: "protocol"
version: "1.0.0"
created: "2026-02-08"
updated: "2026-02-08"
author: "Claude (system)"
status: "active"
load_priority: 5
dependencies: ["team-protocol"]
conflicts: []
auto_load: false
load_trigger: "Loaded automatically with Module 010 during /team activate"
authority: "Operator directive 2026-02-08 — Native Team Orchestration"
---

# Team Strategy Protocol

## Purpose

**This file replaces Operator's orchestration paragraph.**

Every multi-agent team session previously required Operator to type instructions covering subscribe loops, ACK windows, write prevention, agent quirks, and idle behavior. This protocol codifies those patterns so they load automatically with `/team activate`.

**Audience:** All team agents. Director reads this to coordinate. Executors and validators read this to understand their operating constraints.

---

## Subscribe Loop Pattern

All non-director team agents operate in a subscribe loop — polling the Overseer relay for task assignments.

### Loop Structure

```
FOR cycle IN 1..subscribe_cycles:
    result = listen_for_task(worker_name=MY_NAME, timeout=subscribe_timeout)

    IF result.has_task:
        ACK task (post TASK_ACCEPT to relay)
        EXECUTE task
        POST completion (TASK_COMPLETE to relay)
        POST heartbeat (progress_pct=100)
        CONTINUE loop  # Ready for next task

    IF result.timeout:
        POST heartbeat (state="idle", current_action="awaiting task")
        CONTINUE loop  # Keep listening

AFTER all cycles exhausted:
    POST idle announcement to relay
    RE-ENTER subscribe loop (start new cycle batch)
    Only go fully idle if director explicitly instructs you to stop
```

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `subscribe_timeout` | 60s | How long each listen cycle waits |
| `subscribe_cycles` | 20 | Total cycles before idle announcement (minimum: 20) |
| `heartbeat_interval` | 60s | Heartbeat frequency during task execution |

**Total active window:** `subscribe_timeout * subscribe_cycles` = 20 minutes default.

### Idle Announcement

After exhausting all subscribe cycles without receiving a task:

```
POST to relay:
  type: "status"
  content: "{agent_name} idle — {subscribe_cycles} cycles exhausted, no tasks received. Re-entering subscribe loop."
```

The agent does NOT self-terminate and does NOT stop listening. It announces idle, then **re-enters the subscribe loop** for another batch of cycles. The agent only stops listening when the director explicitly sends a stop/idle command.

---

## Wake / ACK Protocol

When a task arrives, the executor has a **10-second ACK window**.

### Sequence

```
1. Director posts TASK_ASSIGN → relay
2. Executor receives task via subscribe loop
3. Executor has 10s to post TASK_ACCEPT → relay
4. Director confirms assignment
5. Executor begins work
```

### Timeout Handling

```
IF no ACK in 10s:
    Director retries ONCE (re-sends TASK_ASSIGN)

    IF still no ACK (10s):
        Mark agent as UNRESPONSIVE
        Reassign task to next available executor
        POST reassignment notice to relay
```

### ACK Message Format

```
POST to relay:
  type: "ack"
  content: "TASK_ACCEPT: {task_id} — {agent_name} acknowledges. Starting execution."
```

### TASK_COMPLETE Message Format

```
POST to relay:
  type: "response"
  ref_id: {original_task_assign_message_id}
  content: "TASK_COMPLETE: {task_id} — {agent_name} finished. <full deliverable content>"
```

Post your **complete deliverable** in the content field — not a summary, not a pointer to terminal output. The director and validator must be able to act on the content without reading your terminal.

Director reads TASK_COMPLETE to mark tasks done and route to validator if applicable.

### VALIDATION_RESULT Message Format

```
POST to relay:
  type: "status"
  content: "VALIDATION_RESULT: {task_id} — {validator_name}: {GO|NOGO|REWORK}. Findings: {summary}"
```

On NOGO or REWORK, director reassigns task with validator feedback attached.

---

## Write Prevention Policy

**Default: READ-ONLY for all team agents.**

### Rules

1. **No agent writes files unless the task description explicitly grants write permission**
2. Director coordination writes (relay messages, status updates) are always permitted
3. Validator never writes to project files — review output is posted to relay
4. Write permission is task-scoped, not session-scoped — it expires when the task completes

### Task Grant Format

When a director assigns a task requiring writes:

```
TASK_ASSIGN:
  description: "Implement retry logic in src/api/client.ts"
  write_access: ["src/api/client.ts", "src/api/client.test.ts"]
```

The executor may ONLY write to the specified files. Any other write is a policy violation.

### Enforcement

Write prevention is **advisory** — enforced via role card injection, not filesystem permissions. Agents that violate write policy (especially Gemini) will have violations documented in the audit log.

---

## Agent-Specific Operating Notes

### Claude (Executor)

- **Strengths:** Reliable execution, good at following structured instructions, strong code quality
- **Watch for:** Over-engineering, adding unnecessary abstractions, scope creep
- **Best practice:** Provide explicit Definition of Done. Keep task scope to 1-3 files.

### Gemini (Executor or Director)

- **Strengths:** Fast analysis, good at multi-file comprehension, strong at planning
- **Watch for:** Writes without permission. Will modify files it was only asked to read.
- **Best practice:** Always specify read-only unless write is required. Never grant blanket write access. Review all file modifications.

### Codex (Validator)

- **Strengths:** Deep reasoning, thorough code review, catches edge cases
- **Watch for:** Slow response times (30-60s for complex reasoning). May timeout on ACK.
- **Best practice:** Set ACK timeout to 30s for Codex. Provide explicit acceptance criteria. Don't assign time-sensitive tasks.

### Kimi (Executor)

- **Strengths:** Multilingual, novel perspective, capable executor
- **Watch for:** Newer to team operations. Behavior patterns still being established.
- **Best practice:** Start with bounded tasks. Monitor output quality. Document observed patterns for future reference.

### Grok (Executor or Validator) — via Goose CLI

- **CLI:** Goose CLI v1.24.0+ by Block, `--provider xai --model grok-4`
- **Strengths:** Contrarian analysis, finds failure modes others miss. Strong at adversarial review. Different training data surface blind spots.
- **Watch for:** May push back on task framing — this is a feature, not a bug. Can be blunt. ACK timing not yet calibrated (start conservative at 30s).
- **Best practice:** Channel into validation/review roles where pushback adds value. Document dissent as structured feedback. Pair with Claude for balanced analysis. Use `--no-profile` to prevent config pollution across sessions.
- **MCP:** Goose supports MCP via `--with-extension` flags on launch. Full Team Protocol participation (relay, heartbeats, task dispatch, subscribe loops).
- **Prefix:** `r` (for gRok) in team configs. Overseer maps `r-{team_id}` to goose heuristics.

---

## Heartbeat Protocol

### During Task Execution

Every active executor MUST post heartbeats at the configured interval:

```
POST heartbeat:
  worker: "{agent_name}"
  task_id: "{current_task}"
  progress_pct: 0-100 (estimate)
  current_action: "Brief description of current activity"
  state: "working"
```

### During Idle

Between tasks (in subscribe loop), executors post idle heartbeats:

```
POST heartbeat:
  worker: "{agent_name}"
  task_id: "idle"
  progress_pct: 0
  current_action: "Awaiting task assignment"
  state: "idle"
```

### Stall Detection Thresholds

| Missed Heartbeats | Status | Action |
|--------------------|--------|--------|
| 1 | Normal | No action (transient) |
| 2 | STALE | Director receives warning |
| 3 | STUCK | Auto-remediation: `C-c` interrupt, check state |
| 4+ | CRASHED | Force kill session, reassign task |

---

## Escalation Protocol

When an executor is blocked and cannot complete a task:

### Step 1: Self-Report

```
POST to relay:
  type: "status"
  content: "BLOCKED: {task_id} — {reason}. Requesting Director intervention."
```

### Step 2: Director Triage

Director reads block report and takes one of:
- **Unblock:** Provide missing information or context
- **Reassign:** Move task to different executor
- **Decompose:** Break blocked task into smaller sub-tasks
- **Escalate:** Post to Operator for decision

### Step 3: Operator Escalation (if needed)

```
POST to relay:
  type: "status"
  content: "ESCALATION: {task_id} — Director cannot resolve. Awaiting Operator decision."
```

Director NEVER silently drops a blocked task. Every block is documented.

---

## Role Card Template

Injected into each agent during `/team activate`:

```
═══════════════════════════════════════════════════════════════
TEAM ACTIVATION — {team_name}
═══════════════════════════════════════════════════════════════
You are: {agent_name}
Role: {role} on {team_name} (Team {team_id})
Director: {director_name}

Operating Constraints:
- Write policy: {write_policy} (override requires explicit task grant)
- Heartbeat interval: {heartbeat_interval}s
- ACK window: {ack_window_seconds}s (acknowledge tasks immediately)
- Subscribe timeout: {subscribe_timeout}s x {subscribe_cycles} cycles

Your subscribe loop:
  1. Call listen_for_task(worker_name="{agent_name}", timeout={subscribe_timeout})
  2. When task arrives: ACK within {ack_window_seconds}s, execute, then:
     - Post your FULL deliverable to relay:
       post_message(agent="{agent_name}", content="TASK_COMPLETE: {task_id} — {your complete response}", msg_type="response", ref_id=<task_assign_msg_id>)
     - Post completion heartbeat: post_heartbeat(worker="{agent_name}", task_id="{task_id}", progress_pct=100, state="idle")
  3. Between tasks: post idle heartbeat
  4. After {subscribe_cycles} cycles with no task: announce idle on relay, then RE-ENTER subscribe loop.
     Only stop listening if the director explicitly tells you to go idle.

{agent_specific_notes}

{IF role == director AND session_mode == "sessions":}
MISSION COMPLETE PROTOCOL:
When your mission is fully complete and you have posted your final report to Operator:
1. Post to relay: post_message(agent="{agent_name}", content="TEAM_DISBAND: Mission complete. Self-destructing.", msg_type="status")
2. Kill each worker session via Bash (one command):
   tmux kill-session -t {worker_1} && tmux kill-session -t {worker_2} && ...
3. Post to relay: post_message(agent="{agent_name}", content="DISBAND_COMPLETE: All workers terminated.", msg_type="status")
4. Kill your own session last via Bash: tmux kill-session -t {agent_name}
Do NOT disband prematurely. Only execute after Operator has received and acknowledged your final report.
{END IF}

{IF role == director AND session_mode == "panes":}
MISSION COMPLETE PROTOCOL:
When your mission is fully complete and you have posted your final report to Operator:
1. Post to relay: post_message(agent="{agent_name}", content="TEAM_DISBAND: Mission complete. Self-destructing.", msg_type="status")
2. Kill the entire team session via Bash: tmux kill-session -t team-{team_id}
Do NOT disband prematurely. Only execute after Operator has received and acknowledged your final report.
{END IF}

Governance: modules/constraints/ZEOS_MODULE_010_TEAM_PROTOCOL.md
═══════════════════════════════════════════════════════════════
```

---

## Director Operating Pattern

The director agent follows a different pattern from executors:

### Mission Delivery

Operator delivers the mission to the director via **relay message** (not `send_to_agent`), so the director's `get_messages` or `subscribe` loop picks it up naturally:

```
Operator posts:
  post_message(agent="operator", content="MISSION: {mission_description}", msg_type="mission")
```

The director's coordination loop begins by checking for `mission` type messages on the relay. This avoids the problem of `send_to_agent` terminal input queuing behind an active subscribe timeout.

**Fallback:** If relay delivery is not available (e.g., Operator is not on the same team_id), use `send_to_agent` with `interrupt_if_busy=true` to break the subscribe loop.

### Coordination Loop

```
1. RECEIVE mission from relay (msg_type="mission") or via send_to_agent
2. LOAD context (blueprint, spec, or task list)
3. DECOMPOSE work into assignable tasks
4. FOR EACH task:
   a. SELECT executor (round-robin or capability-based)
   b. DISPATCH task via dispatch_task_sync (waits for ACK)
   c. MONITOR progress via heartbeats
   d. ON completion: validate output or route to validator
5. BETWEEN dispatches: check heartbeat health, handle escalations
6. ON all tasks complete: report to Operator
7. ON mission acknowledged: execute Mission Complete Protocol (kill all team sessions including self)
```

### Director Message Monitoring

When monitoring for task completions, use **unfiltered** subscribe/get_messages:

```
DO:     subscribe(requesting_agent="d-{team_id}", since_id={last_id}, timeout=120)
        → Filter in code: check for TASK_COMPLETE in content or msg_type in ("response", "task_complete", "status")

DON'T:  subscribe(..., filter_type="response")
        → Misses executors who post as "status" or "task_complete"
```

### Fleet Monitoring (mandatory after initial dispatch)

After dispatching initial tasks, the director spawns a background Sonnet subagent to monitor fleet health. This keeps the director's main context clean for task decomposition and review.

Spawn a background Sonnet subagent (Task tool, model: sonnet, run_in_background: true) with prompt:

```
"You are the fleet monitor for team {team_id}. Your job:
1. Call watch_fleet_idle(requesting_agent='{session_name}', idle_threshold=120, timeout=300, check_interval=60).
2. If alerts returned, post to relay: post_message(agent='{session_name}', content='FLEET_ALERT: {alert_json}', msg_type='status').
3. Loop: call watch_fleet_idle again.
4. If 3 consecutive timeouts with no alerts, post FLEET_HEALTHY status and exit."
```

Monitor your relay for FLEET_ALERT messages. On receipt, dispatch tasks to idle workers or instruct them to stand down.

### Mission Complete Protocol

When the director has completed its mission and posted the final report to Operator:

**Session Mode** (default):
1. Post `TEAM_DISBAND: Mission complete. Self-destructing.` to relay (msg_type: status)
2. Kill each non-director agent session: `tmux kill-session -t {agent_name}`
3. Kill director's own session last: `tmux kill-session -t {director_session_name}`

**Pane Mode** (`session_mode: panes`):
1. Post `TEAM_DISBAND: Mission complete. Self-destructing.` to relay (msg_type: status)
2. Kill the entire team session: `tmux kill-session -t team-{team_id}`

**Critical:** Do NOT execute prematurely. Only after the final report has been posted to Operator and all tasks are verified complete.

### Director Constraints

- Director coordinates. Director does NOT execute tasks (unless explicitly assigned one by Operator).
- Director monitors all heartbeats and acts on stall detection.
- Director documents all task assignments, completions, and escalations.
- Director self-terminates only via Mission Complete Protocol after final report. Never self-terminates during active coordination.
- Director NEVER self-terminates on manual `/team disband` (handled by Operator).

---

*Team Strategy Protocol v1.0.0*
*"The paragraph is now a protocol."*
