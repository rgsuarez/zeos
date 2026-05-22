# OVERSEER SMOKE TEST — MISSION BRIEF

```
═══════════════════════════════════════════════════════════════
Priority: HIGH | Time budget: 12 minutes | Self-termination: YES
Calling agent: "{commander_target}" (deliver final report here via send_to_agent)
═══════════════════════════════════════════════════════════════
```

**You are the director of a smoke test team. You have a specific mission. Execute it IMMEDIATELY.**

**Do NOT enter a subscribe loop. Do NOT call `listen_for_task`. Your workers (c-6, x-6, g-6, k-6) are already in subscribe loops awaiting tasks from you. Begin PHASE 1 now.**

---

## MISSION OBJECTIVE

Validate that Overseer's communication primitives work end-to-end across all agent types. Dispatch 4 file-audit tasks (one per executor), collect results, synthesize a per-agent communication primitive matrix, deliver the report to the calling agent ("{commander_target}"), and self-terminate.

This is a diagnostic mission. You **record** failures, you do not recover from them. Every PASS/FAIL is valuable data.

---

## TASK DEFINITIONS

Dispatch these 4 tasks using `dispatch_task_sync`. Use `ack_timeout=45` for all dispatches (Codex needs ~40s).

### Task 1: `smoke-audit-server` → c-6

**Description to send:**

> Audit the file at `~/projects/zeos/infrastructure/overseer/src/overseer/server.py`.
>
> Your deliverable: List every `@mcp.tool()` decorated function name. Count the total number of tools.
>
> Format your result as:
> ```
> TOOLS FOUND: {count}
> 1. {function_name}
> 2. {function_name}
> ...
> ```
>
> When you start, post a heartbeat: `post_heartbeat(worker="c-6", task_id="smoke-audit-server", progress_pct=0, current_action="Starting audit")`
>
> When done, post a completion heartbeat: `post_heartbeat(worker="c-6", task_id="smoke-audit-server", progress_pct=100, current_action="Complete")`
>
> Then post your result: `post_message(agent="c-6", content="TASK_COMPLETE: smoke-audit-server — {your result}", msg_type="response")`
>
> You have 3 minutes. Read the file, extract the info, report back.

### Task 2: `smoke-audit-tmux` → x-6

**Description to send:**

> Audit the file at `~/projects/zeos/infrastructure/overseer/src/overseer/tmux_backend.py`.
>
> Your deliverable: List all public methods on the `TmuxBackend` class (methods that do NOT start with underscore). Describe the resolution waterfall — how does `_resolve_target` find an agent? List the tiers in order.
>
> Format your result as:
> ```
> PUBLIC METHODS: {count}
> 1. {method_name} — {one-line description}
> 2. {method_name} — {one-line description}
> ...
>
> RESOLUTION WATERFALL:
> Tier 1: {description}
> Tier 2: {description}
> ...
> ```
>
> When you start, post a heartbeat: `post_heartbeat(worker="x-6", task_id="smoke-audit-tmux", progress_pct=0, current_action="Starting audit")`
>
> When done, post a completion heartbeat: `post_heartbeat(worker="x-6", task_id="smoke-audit-tmux", progress_pct=100, current_action="Complete")`
>
> Then post your result: `post_message(agent="x-6", content="TASK_COMPLETE: smoke-audit-tmux — {your result}", msg_type="response")`
>
> You have 3 minutes. Read the file, extract the info, report back.

### Task 3: `smoke-audit-detector` → g-6

**Description to send:**

> Audit the file at `~/projects/zeos/infrastructure/overseer/src/overseer/detector.py`.
>
> Your deliverable: List all `AgentState` enum values. Then describe the detection heuristics — how does the detector determine if an agent is IDLE vs WORKING vs WAITING? What patterns does it look for per agent type (Claude, Gemini, Codex)?
>
> Format your result as:
> ```
> AGENT STATES: {count}
> 1. {state_name}
> 2. {state_name}
> ...
>
> DETECTION HEURISTICS:
> - Claude: {how it detects state}
> - Gemini: {how it detects state}
> - Codex: {how it detects state}
> - Default: {fallback heuristic}
> ```
>
> When you start, post a heartbeat: `post_heartbeat(worker="g-6", task_id="smoke-audit-detector", progress_pct=0, current_action="Starting audit")`
>
> When done, post a completion heartbeat: `post_heartbeat(worker="g-6", task_id="smoke-audit-detector", progress_pct=100, current_action="Complete")`
>
> Then post your result: `post_message(agent="g-6", content="TASK_COMPLETE: smoke-audit-detector — {your result}", msg_type="response")`
>
> You have 3 minutes. Read the file, extract the info, report back.

### Task 4: `smoke-audit-hive` → k-6

**Description to send:**

> Audit the file at `~/projects/zeos/infrastructure/overseer/src/overseer/hive.py`.
>
> Your deliverable: List all dataclasses defined in the file. For each, list its fields and a one-line description of its purpose.
>
> Format your result as:
> ```
> DATACLASSES: {count}
>
> 1. {ClassName}
>    Fields: {field1}: {type}, {field2}: {type}, ...
>    Purpose: {one-line description}
>
> 2. {ClassName}
>    Fields: ...
>    Purpose: ...
> ```
>
> When you start, post a heartbeat: `post_heartbeat(worker="k-6", task_id="smoke-audit-hive", progress_pct=0, current_action="Starting audit")`
>
> When done, post a completion heartbeat: `post_heartbeat(worker="k-6", task_id="smoke-audit-hive", progress_pct=100, current_action="Complete")`
>
> Then post your result: `post_message(agent="k-6", content="TASK_COMPLETE: smoke-audit-hive — {your result}", msg_type="response")`
>
> You have 3 minutes. Read the file, extract the info, report back.

---

## EXECUTION PROTOCOL

### PHASE 1: DISPATCH (0–3 min)

For each task in order (c-6, x-6, g-6, k-6):

```
result = dispatch_task_sync(
  director="d-6",
  worker="{agent}",
  task_id="{task_id}",
  description="{full task description from above}",
  priority="high",
  ack_timeout=45
)
```

Record per agent: `ACCEPTED` or `TIMEOUT`. If timeout, mark that agent's entire row as FAIL and continue to next agent.

**Do not wait between dispatches.** Fire them as fast as possible.

### PHASE 2: MONITOR (3–8 min)

Every 60 seconds:

1. `get_worker_heartbeats(requesting_agent="d-6")` — record which agents have heartbeats
2. `get_messages(requesting_agent="d-6", since_id={last_seen_id})` — scan for `TASK_COMPLETE` messages

For each `TASK_COMPLETE` message found:
- Parse the result content
- Mark that executor as DONE
- Record the content for the report

**Exit condition:** All 4 executors DONE, or 5 minutes elapsed since last completion. Mark remaining executors as `TIMED_OUT`.

### PHASE 3: SYNTHESIZE (8–10 min)

Build the verification matrix. For each agent:

| Check | PASS condition |
|-------|---------------|
| `dispatch_sync` | dispatch_task_sync returned `accepted` |
| `heartbeat` | At least 1 heartbeat received from agent |
| `task_complete` | Agent posted a TASK_COMPLETE message |
| `content_ok` | Result contains the expected data format (tool list, method list, etc.) |

Also check director primitives:
- `get_worker_heartbeats`: Returned without error at least once
- `get_messages (filter)`: Successfully retrieved messages at least once
- `send_to_agent (delivery)`: Will be checked in Phase 4

Build the final report using the template below.

### PHASE 4: DELIVER & TERMINATE (10–12 min)

1. **Deliver report:**
   - If delivery_method == "send_to_agent":
     ```
     send_to_agent(agent="{commander_target}", message="{REPORT}")
     ```
   - If delivery_method == "relay":
     ```
     post_message(agent="d-6", content="REPORT_FOR_COMMANDER: {REPORT}", msg_type="status")
     ```

2. **Wait 5 seconds** (let message propagate)

3. **Post disband notice:**
   ```
   post_message(agent="d-6", content="TEAM_DISBAND: Smoke test complete. Self-terminating team-6.", msg_type="status")
   ```

4. **Self-terminate:** Execute in your terminal:
   ```bash
   tmux kill-session -t team-6
   ```

---

## REPORT TEMPLATE

Use this exact format for the final report:

```
OVERSEER SMOKE TEST REPORT — Team 6
═══════════════════════════════════════════════════════════════
Timestamp: {ISO timestamp}  |  Duration: {seconds}s

COMMUNICATION PRIMITIVE MATRIX:
┌──────────┬────────────────┬───────────┬───────────────┬─────────────┐
│ Agent    │ dispatch_sync  │ heartbeat │ task_complete │ content_ok  │
├──────────┼────────────────┼───────────┼───────────────┼─────────────┤
│ c-6      │ {PASS/FAIL}    │ {P/F}     │ {P/F}         │ {P/F}       │
│ x-6      │ {PASS/FAIL}    │ {P/F}     │ {P/F}         │ {P/F}       │
│ g-6      │ {PASS/FAIL}    │ {P/F}     │ {P/F}         │ {P/F}       │
│ k-6      │ {PASS/FAIL}    │ {P/F}     │ {P/F}         │ {P/F}       │
└──────────┴────────────────┴───────────┴───────────────┴─────────────┘

DIRECTOR PRIMITIVES:
- get_worker_heartbeats: {PASS/FAIL}
- get_messages (filter): {PASS/FAIL}
- send_to_agent (delivery): {PASS/FAIL — based on whether this report arrived}

OVERALL: {N}/20 checks passed
VERDICT: SMOKE TEST {PASSED if ≥10/20, else FAILED}

═══════════════════════════════════════════════════════════════
DETAILED RESULTS BY AGENT:
═══════════════════════════════════════════════════════════════

--- c-6 (Claude) ---
Dispatch: {ACCEPTED/TIMEOUT}
Heartbeats: {count received}
Result: {full result text or "TIMED_OUT" or "NO_RESPONSE"}

--- x-6 (Codex) ---
Dispatch: {ACCEPTED/TIMEOUT}
Heartbeats: {count received}
Result: {full result text or "TIMED_OUT" or "NO_RESPONSE"}

--- g-6 (Gemini) ---
Dispatch: {ACCEPTED/TIMEOUT}
Heartbeats: {count received}
Result: {full result text or "TIMED_OUT" or "NO_RESPONSE"}

--- k-6 (Kimi) ---
Dispatch: {ACCEPTED/TIMEOUT}
Heartbeats: {count received}
Result: {full result text or "TIMED_OUT" or "NO_RESPONSE"}

═══════════════════════════════════════════════════════════════
END OF SMOKE TEST REPORT
═══════════════════════════════════════════════════════════════
```

---

## FAILURE HANDLING

| Failure | Your Action | Report Impact |
|---------|-------------|---------------|
| Executor never ACKs dispatch | Mark dispatch FAIL, skip that executor | Row shows FAIL + N/A for remaining columns |
| ACKs but never completes | After 5 min idle, mark TIMED_OUT | dispatch PASS, task_complete FAIL |
| Completes with wrong format | Mark content_ok FAIL | Include raw result in detailed section |
| Cannot reach "{commander_target}" via send_to_agent | Post report to relay as fallback | Note delivery method in report |
| Overseer MCP tool errors | Log the error, mark that check FAIL | Include error text in detailed section |

---

## REMINDERS

- You are `d-6`. Your team_id is `6`.
- Your workers are `c-6`, `x-6`, `g-6`, `k-6`.
- All Overseer MCP tools are available to you (dispatch_task_sync, get_worker_heartbeats, get_messages, post_message, post_heartbeat, send_to_agent).
- The calling agent session is named `{commander_target}`. Deliver the final report there.
- After delivering the report, kill the entire team: `tmux kill-session -t team-6`
- Total time budget: 12 minutes. Do not exceed it.
