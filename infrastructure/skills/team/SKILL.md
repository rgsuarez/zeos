---
name: team
description: Multi-agent team orchestration — activate, status, disband, list, config
argument-hint: <subcommand> [args]
allowed-tools: mcp__overseer__activate_dev_team, mcp__overseer__send_to_agent, mcp__overseer__detect_state, mcp__overseer__get_worker_heartbeats, mcp__overseer__post_message, mcp__overseer__get_messages, mcp__overseer__clear_team_messages, mcp__overseer__list_agents, mcp__overseer__dispatch_task_sync, mcp__overseer__get_agent_output, mcp__overseer__register_team_agents
---

# /team Command

Multi-agent team orchestration for zeOS. Manages team lifecycle via Overseer MCP tools.

## Subcommands

Parse `$ARGUMENTS` to determine subcommand:

| Pattern | Subcommand |
|---------|------------|
| `activate <config>` | Activate team |
| `activate copilot <target>` | Activate copilot mode |
| `status` | Team status |
| `disband [--keep]` | Disband team |
| `list` | List configs |
| `config <name>` | Show config |

---

## /team activate <config>

1. **Load Config** — Read `~/projects/zeOS/profiles/{profile_id}/teams/{config}.yaml`
   - If not found: "CONFIG_NOT_FOUND — run `/team list` to see available configs"
   - **If `type: copilot`:** Branch to [Copilot Activation](#copilot-activation) below. Skip all standard activation steps.

2. **Load Governance** — Read these files into context:
   - `~/projects/zeOS/modules/constraints/ZEOS_MODULE_010_TEAM_PROTOCOL.md`
   - `~/projects/zeOS/modules/protocols/TEAM_STRATEGY_PROTOCOL.md`
   - `~/projects/zeOS/modules/commands/TEAM_COMMANDS.md`

3. **Clear Team Relay** — Prevent stale task re-delivery from previous activations:
   - Call `mcp__overseer__clear_team_messages(requesting_agent="{director_session_name}", team_id="{team_id}")`
   - Log result: "Relay cleared: {messages_deleted} stale messages removed"

4. **Determine Session Mode** from config:
   - If `session_mode: panes` — use **Pane Mode** (agents as panes in single session `team-{team_id}`)
   - If `session_mode: sessions` or not set — use **Session Mode** (one tmux session per agent, default)

5. **Derive Session Names** — For each `agent_key` in config `agents:` section:
   ```
   session_name = "{agent_key}-{team_id}"   # e.g., "o" + "-" + "4" = "o-4"
   ```
   VALIDATE: If any agent_key already contains a `-` followed by digits (e.g., `o-2`),
   strip the existing suffix and use `{prefix}-{team_id}` instead. WARN in output:
   "Legacy agent key '{agent_key}' auto-corrected to '{session_name}'."

   Use `session_name` (NOT raw `agent_key`) for ALL subsequent operations:
   tmux sessions, role cards, relay interactions, disband lists.

   The **director's session_name** is the one whose role is `director`.

6. **Detect Operator Environment** — determine how the director reports back to Operator:
   - Run via Bash: `tmux display-message -p '#{session_name}:#{pane_id}' 2>/dev/null`
   - If it returns a value (e.g., `claude:0`): parse as `{commander_session}:{commander_pane}`, set:
     - `commander_target = {commander_session}`
     - `delivery_method = "send_to_agent"`
   - If it fails (not in tmux or empty output): set:
     - `commander_target = "relay"`
     - `delivery_method = "relay"`

7. **For Each Agent** — using derived `session_name` from step 5:

   **Session Mode** (default):
   a. Check session exists: use `mcp__overseer__detect_state(agent="{session_name}")`
   b. If state is `"unknown"`, `"error"`, or detect_state returns an error — the session does NOT exist. Create it:
      - Use Bash: `tmux new-session -d -s {session_name}`
      - Use Bash: `tmux send-keys -t {session_name} 'unset CLAUDECODE' C-m`
      - Use Bash: `tmux send-keys -t {session_name} '{launch_command}' C-m`
      - Wait 10s for agent to initialize
      - If `tmux new-session` fails: report the error for THIS agent, continue with next agent. Do NOT abort activation.
   c. If state is `"idle"` or `"working"` — session exists and agent is alive. Skip creation, proceed to role card.

   **Pane Mode** (`session_mode: panes`):
   a. Before first agent — create parent session:
      - Use Bash: `tmux new-session -d -s team-{team_id}`
   b. For each agent:
      - Use Bash: `PANE_ID=$(tmux split-window -t team-{team_id} -d -P -F "#{pane_id}")`
      - Use Bash: `tmux select-layout -t team-{team_id} tiled`
      - Use Bash: `tmux select-pane -t $PANE_ID -T {session_name}`
      - Use Bash: `tmux send-keys -t $PANE_ID 'unset CLAUDECODE' C-m`
      - Use Bash: `tmux send-keys -t $PANE_ID '{launch_command}' C-m`
      - Wait 10s for agent to initialize
   c. After all agents created:
      - Kill the empty initial pane: `tmux kill-pane -t team-{team_id}:0.0`
      - Use Bash: `tmux select-layout -t team-{team_id} tiled`
   d. **Register pane agents with Overseer** — collect all `{session_name: pane_id}` mappings from step 7b and call:
      ```
      mcp__overseer__register_team_agents(
        requesting_agent="{director_session_name}",
        team_session="team-{team_id}",
        agents={"{session_name_1}": "{pane_id_1}", "{session_name_2}": "{pane_id_2}", ...}
      )
      ```
      Log: "Registered {count} pane agents with Overseer backend"
   e. Use `mcp__overseer__detect_state(agent="{session_name}")` — wait for IDLE (retry up to 3 times, 10s each)
   f. Build role card from Team Strategy Protocol template:
      ```
      You are {session_name}, role: {role} on {team_name} (Team {team_id}).
      Director: {director_session_name}.
      Write policy: {write_policy.default} (override requires {write_policy.override_requires}).
      Heartbeat: {activation.heartbeat_interval}s. ACK window: {ack_window_seconds}s.
      Subscribe: listen_for_task(worker_name="{session_name}", timeout={activation.subscribe_timeout}) x {activation.subscribe_cycles} cycles.
      After exhausting all cycles: announce idle on relay, then RE-ENTER subscribe loop.
      Only stop listening if the director explicitly tells you to go idle.
      {notes if present}
      Begin your subscribe loop now.
      ```
      If the agent's role is `director`:
      - Add to role card: `Report delivery: {delivery_method}. Target: {commander_target}.`
      - Append the **Mission Complete Protocol** to the role card.

      **Session Mode** Mission Complete Protocol:
      If `delivery_method == "send_to_agent"`, use:
      ```
      MISSION COMPLETE PROTOCOL:
      When your mission is fully complete:
      1. Deliver final report to Operator: send_to_agent(agent="{commander_target}", message="{final_report}")
      2. Post to relay: post_message(agent="{session_name}", content="TEAM_DISBAND: Mission complete. Self-destructing.", msg_type="status")
      3. For each non-director agent ({non_director_session_list}): run bash `tmux kill-session -t {session_name}`
      4. Kill your own session last: run bash `tmux kill-session -t {your_session_name}`
      Do NOT disband prematurely. Only execute after Operator has confirmed receipt of your final report.
      ```
      If `delivery_method == "relay"`, use:
      ```
      MISSION COMPLETE PROTOCOL:
      When your mission is fully complete:
      1. Deliver final report via relay: post_message(agent="{session_name}", content="FINAL_REPORT: {report_summary}", msg_type="response")
      2. Post to relay: post_message(agent="{session_name}", content="TEAM_DISBAND: Mission complete. Self-destructing.", msg_type="status")
      3. For each non-director agent ({non_director_session_list}): run bash `tmux kill-session -t {session_name}`
      4. Kill your own session last: run bash `tmux kill-session -t {your_session_name}`
      Do NOT disband prematurely. Only execute after delivering your final report.
      ```

      **Pane Mode** (`session_mode: panes`) Mission Complete Protocol:
      If `delivery_method == "send_to_agent"`, use:
      ```
      MISSION COMPLETE PROTOCOL:
      When your mission is fully complete:
      1. Deliver final report to Operator: send_to_agent(agent="{commander_target}", message="{final_report}")
      2. Post to relay: post_message(agent="{session_name}", content="TEAM_DISBAND: Mission complete. Self-destructing.", msg_type="status")
      3. Kill the entire team session: run bash `tmux kill-session -t team-{team_id}`
      Do NOT disband prematurely. Only execute after Operator has confirmed receipt of your final report.
      ```
      If `delivery_method == "relay"`, use:
      ```
      MISSION COMPLETE PROTOCOL:
      When your mission is fully complete:
      1. Deliver final report via relay: post_message(agent="{session_name}", content="FINAL_REPORT: {report_summary}", msg_type="response")
      2. Post to relay: post_message(agent="{session_name}", content="TEAM_DISBAND: Mission complete. Self-destructing.", msg_type="status")
      3. Kill the entire team session: run bash `tmux kill-session -t team-{team_id}`
      Do NOT disband prematurely. Only execute after delivering your final report.
      ```
      Build `{non_director_session_list}` from the derived session names (all agents except the director).
   g. Capture relay position: `mcp__overseer__get_messages(requesting_agent="{director_session_name}", since_id=0)` returns `{"status":"ok","messages":[...],"count":N,"timed_out":false}` — record highest `id` from `messages[]` as `{last_msg_id}`
   h. Inject via `mcp__overseer__send_to_agent(agent="{session_name}", message="{role_card}")`
   i. Check for ACK: `mcp__overseer__get_messages(requesting_agent="{director_session_name}", since_id={last_msg_id})` returns the same envelope — scan `messages[]` for TASK_ACCEPT within ACK window

8. **Load Context** (if `context:` block exists in config):
   - Read blueprint, spec, and additional files listed
   - Provide to director agent as initial context

9. **Output Activation Summary:**
   ```
   TEAM ACTIVATED: {name}
   Type: {type} | Runtime: {runtime}
   Agents: {list with status}
   Write Policy: {write_policy.default}
   Subscribe: {subscribe_timeout}s x {subscribe_cycles} cycles
   ```

### --dry-run flag

If `$ARGUMENTS` contains `--dry-run`:
- Parse config, check which tmux sessions exist
- Output plan WITHOUT executing any activation steps
- No sessions created, no role cards injected

---

## Copilot Activation

Triggered when config `type` is `copilot`. The current agent becomes the copilot. The worker is a pre-existing tmux session specified as `<target>` in the activate arguments.

1. **Parse Target** — Extract `<target-session>` from the remaining arguments after `copilot` in `$ARGUMENTS`.
   - If missing: output error — "USAGE: `/team activate copilot <target-tmux-session>`" and stop.

2. **Load Config** — Read `~/projects/zeOS/profiles/{profile_id}/teams/copilot.yaml`
   - Confirm `type: copilot`

3. **Validate Worker** — `mcp__overseer__detect_state(agent="{target-session}")`
   - If state is `"unknown"`, `"error"`, or detect_state returns an error: output "TARGET_NOT_FOUND — tmux session '{target-session}' does not exist or is not responding." and stop.
   - Record worker state for activation summary.

4. **Load Persona** — Read `~/projects/zeOS/profiles/{profile_id}/teams/{persona_file}` (from config's `persona_file` field).
   - Internalize the three-lens framework, synthesis protocol, output format, and constraints.

5. **Initial Snapshot** — `mcp__overseer__get_agent_output(agent="{target-session}", lines=200)`
   - Capture what the worker is currently doing.

6. **Store Session Context:**
   - `copilot_active = true`
   - `copilot_target = "{target-session}"`
   - `copilot_config = "copilot"`

7. **Output Activation Summary:**
   ```
   ===============================================================
   COPILOT ACTIVATED
   ===============================================================
   Target:  {target-session}
   State:   {worker state from step 3}
   Persona: CEO Strategic Advisor (Jobs/Musk/Huang)
   Mode:    Read-only observation — all advice to Operator

   Commands:
     /team status   → Fresh terminal capture + three-lens assessment
     /team disband  → Disengage copilot (worker unaffected)

   INITIAL SNAPSHOT:
   {summary of worker's current activity from step 5}
   ===============================================================
   ```

---

## /team status

**If `copilot_active` is true:**
1. Capture fresh terminal output: `mcp__overseer__get_agent_output(agent="{copilot_target}", lines=200)`
2. Check worker state: `mcp__overseer__detect_state(agent="{copilot_target}")`
3. Analyze output through the three CEO lenses (Jobs, Musk, Huang) per the loaded persona.
4. Output structured `COPILOT ASSESSMENT` per the persona's output format.
5. Stop. Do not execute standard status below.

**Standard status (non-copilot):**

1. **Get Active Team Config** — Read from most recently activated config (stored in session context)
2. **For Each Agent** (using derived `session_name = "{agent_key}-{team_id}"`):
   - `mcp__overseer__detect_state(agent="{session_name}")` — get current state
   - `mcp__overseer__get_worker_heartbeats(requesting_agent="{director_session_name}", workers=["{session_name}"])` — get heartbeat data
3. **Output Status Table:**
   ```
   TEAM STATUS: {name}
   Agent   Model    Role        State     Task           Last HB
   {per-agent rows}
   Warnings: {any STALE/STUCK agents}
   ```

---

## /team disband [--keep]

**If `copilot_active` is true:**
1. Confirm worker is still running: `mcp__overseer__detect_state(agent="{copilot_target}")`
2. Clear copilot state: `copilot_active = false`, `copilot_target = null`, `copilot_config = null`
3. Output:
   ```
   ===============================================================
   COPILOT DISENGAGED
   ===============================================================
   Target:  {copilot_target}
   Worker:  {RUNNING | NOT FOUND} (session not affected)
   ===============================================================
   ```
4. Stop. Do not execute standard disband below.

**Standard disband (non-copilot):**

1. **Read Disband Policy** from active config:
   - If `disband.default` is `"keep_sessions"`: default behavior = keep (equivalent to `--keep`)
   - If `disband.default` is `"kill_sessions"` or omitted: default behavior = kill
   - Explicit `--keep` flag always overrides to keep

2. **Post Disband Signal:**
   `mcp__overseer__post_message(agent="{director_session_name}", content="TEAM_DISBAND: All agents go idle.", msg_type="task")`

3. **For Each Non-Director Agent:**

   **Session Mode** (default) — using derived `session_name = "{agent_key}-{team_id}"`:
   a. `mcp__overseer__send_to_agent(agent="{session_name}", message="TEAM_DISBAND: Go idle and stop all work.", interrupt_if_busy=true)`
   b. Wait for idle state (`disband.ack_timeout` seconds)
   c. If kill policy applies (step 1 resolved to kill):
      - Use Bash: `tmux kill-session -t {session_name}`
   d. If unresponsive after `disband.ack_timeout` and kill policy applies:
      - Wait `disband.force_kill_timeout` seconds, then: `tmux kill-session -t {session_name}` (force)

   **Pane Mode** (`session_mode: panes`):
   a. If kill policy applies:
      - If `director_survives: true` — kill non-director panes individually via Overseer `kill_agent`
      - If full kill — Use Bash: `tmux kill-session -t team-{team_id}` (atomic, kills all including director)
   b. If keep policy (`--keep` or config default):
      - Post TEAM_DISBAND to relay but leave panes running

4. **Director survives** — Never kill the director session/pane (`director_survives: true`)

5. **Output Disband Summary** — include which policy was applied (config default or `--keep` override)

---

## /team list

1. **Glob** `~/projects/zeOS/profiles/{profile_id}/teams/*.yaml`
2. **Parse** each YAML for `name`, `type`, agent count
3. **Output** table of available configs

---

## /team config <name>

1. **Read** `~/projects/zeOS/profiles/{profile_id}/teams/{name}.yaml`
2. **Parse** and display all fields in structured format
3. **Do NOT activate** — display only

---

## Error Handling

| Error | Response |
|-------|----------|
| No subcommand | Show usage: `/team <activate\|status\|disband\|list\|config>` |
| Config not found | "Config '{name}' not found. Run `/team list` for available configs." |
| Overseer unavailable | "Overseer MCP server not connected. Check MCP configuration." |
| Agent launch failed | Report which agent failed, continue with remaining agents |

---

## Pair-aware mode (2026-05-05) — N-pair tmux intercom

For workflows that run **multiple simultaneous tmux pairs** (e.g., the a control plane
lane_pair runtime with 11 concurrent `pair_*` sessions on `tmux -L zeos-lanes`),
use the Overseer pair_registry (`LOE-zeos-overseer-npair-tmux-intercom`)
instead of reusing the same `claude-N`/`codex-N` numeric suffix across pairs.

### Activation flow with pair registration

1. **Resolve or assign `pair_id`.** Recommended: the tmux session name (e.g.,
   `pair_eleet_brand`).
2. **Register the pair via Overseer MCP:**
   ```
   mcp__overseer__register_pair(
       requesting_agent="bridge-0",   # or self-register from claude-<team_id>
       pair_id="<session-name>",
       claude_session="<pane-id-or-session>",
       codex_session="<pane-id-or-session>",
       socket="zeos-lanes",
       description="<LOE handle>",
       team_id=None,                 # auto-allocated >= 1000
   )
   ```
   Returns `{"status":"ok","team_id":"1042",...,"created":True}`.
3. **Inject role cards** with the allocated `team_id` baked into agent
   identity — `claude-<team_id>` and `codex-<team_id>` for every relay
   call. Pane-scope `send_to_agent` continues to use the tmux pane id.
4. **Idempotent re-activation.** Re-running `/team activate` for the same
   `pair_id` returns `{"created":False,"team_id":<existing>}` — no churn.

### Allocation rules (locked)

- Auto-allocated `team_id ≥ OVERSEER_PAIR_TEAM_ID_BASE` (default `1000`).
- Explicit `team_id < BASE` is **always denied — including for `bridge-0`**.
  Legacy low-ID interop (binding to existing team 1/2/42) is a separate LOE.
- `team_id` is immutable on an existing `pair_id`.
- Denial dicts NEVER expose `claude_session` / `codex_session` / `socket`.

### When to use pair-aware mode

| Workflow | Use pair mode? |
|---|---|
| One-off team activation (single pair, dev) | No — legacy `claude-1`/`codex-1` is fine. |
| Multiple concurrent tmux pairs | **Yes** — every pair must be registered before any pair-scoped relay traffic. |
| a control plane lane_pair runtime | Yes — register at lane bring-up; integration is a separate LOE. |
| Bridge / admin observation | `requesting_agent="bridge-0"` (with `OVERSEER_DEFAULT_TEAM_ID="0"`); `list_pairs(include_others=True)`. |
