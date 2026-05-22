---
module_id: "team-commands"
module_type: "commands"
version: "1.0.0"
created: "2026-02-08"
updated: "2026-02-08"
author: "Claude (system)"
status: "active"
load_priority: 5
dependencies: ["shell-protocol", "team-protocol"]
conflicts: []
auto_load: false
load_condition: "Loaded automatically with Module 010 during /team activate"
authority: "Operator directive 2026-02-08 — Native Team Orchestration"
COMMAND_PREFIX: "/"
---

# Module: Team Commands

## Purpose

Shell Protocol extension defining the `/team` command family for multi-agent team orchestration. These commands interact with Overseer MCP tools to manage team lifecycle.

**Prerequisite:** Overseer MCP server must be running and accessible.

---

## Command Family

### /team activate

**Purpose:** Load team config, resolve agents, spawn sessions, inject roles, start listeners.

**Syntax:**
```
/team activate <config> [--dry-run]
/team activate copilot <target-session>
```

**Arguments:**
| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| config | Yes | — | Config name from `profiles/{operator}/teams/` (without .yaml) |
| --dry-run | No | false | Show what would happen without executing |

**Examples:**
```
/team activate team-2           → Activate Team 2 with full roster
/team activate cm-review        → Activate CM review team with context
/team activate team-2 --dry-run → Show activation plan without executing
/team activate copilot claude   → Activate copilot mode observing 'claude' session
```

**Execution:**
1. **LOAD** — Parse `profiles/{operator}/teams/{config}.yaml`
2. **VALIDATE** — Check required fields, resolve agent names
3. **LOAD MODULE** — Auto-load Module 010 (Team Protocol) if not loaded
4. **LOAD STRATEGY** — Auto-load Team Strategy Protocol
5. **DETERMINE SESSION MODE** — Check `session_mode` in config (`sessions` default, or `panes`)
6. **FOR EACH AGENT:**

   **Session Mode** (default):
   a. Check tmux session: `tmux has-session -t {agent}`
   b. If missing: `tmux new-session -d -s {agent}`
   c. Launch CLI: `tmux send-keys -t {agent} '{launch}' C-m`

   **Pane Mode** (`session_mode: panes`):
   a. First agent: `tmux new-session -d -s team-{team_id}`
   b. Per agent: `tmux split-window -t team-{team_id} -d -P -F "#{pane_id}"`
   c. Set title: `tmux select-pane -t {pane_id} -T {agent}`
   d. Launch CLI: `tmux send-keys -t {pane_id} '{launch}' C-m`
   e. After all: `tmux select-layout -t team-{team_id} tiled` + kill initial pane

   **Both modes:**
   d. Wait for IDLE state (30s timeout)
   e. Inject role card via `send_to_agent`
   f. Wait for ACK (10s)
6. **REPORT** — Output activation summary

**Output (Success):**
```
═══════════════════════════════════════════════════════════════
TEAM ACTIVATED: Team 2
═══════════════════════════════════════════════════════════════
Type:    director_executor_validator
Runtime: tmux | Session Mode: sessions
Agents (derived: {prefix}-{team_id}):
  o-2    claude     director    READY
  c-2    claude     executor    READY
  x-2    codex      validator   READY
  g-2    gemini     executor    READY
  k-2    kimi       executor    READY

Write Policy: read_only (override requires explicit task grant)
Subscribe:    60s x 20 cycles (20 min active window)
Heartbeat:    60s interval
═══════════════════════════════════════════════════════════════
All agents ACK'd. Team 2 is operational.
═══════════════════════════════════════════════════════════════
```

**Output (Partial):**
```
═══════════════════════════════════════════════════════════════
TEAM ACTIVATED: Team 2 (PARTIAL)
═══════════════════════════════════════════════════════════════
...
  k-2    kimi       executor    UNRESPONSIVE (no ACK after 2 attempts)

4/5 agents operational. Proceed or retry k-2?
═══════════════════════════════════════════════════════════════
```

**Output (--dry-run):**
```
═══════════════════════════════════════════════════════════════
DRY RUN: Team 2 Activation Plan
═══════════════════════════════════════════════════════════════
Session names derived: {prefix}-{team_id}
Would spawn/connect:
  o → o-2  → tmux session exists: YES → inject role card
  c → c-2  → tmux session exists: NO  → create session, launch "claude --dangerously-skip-permissions"
  x → x-2  → tmux session exists: NO  → create session, launch "codex"
  g → g-2  → tmux session exists: YES → inject role card
  k → k-2  → tmux session exists: NO  → create session, launch "kimi --yolo"

Config source: profiles/operator/teams/team-2.yaml
═══════════════════════════════════════════════════════════════
```

**Errors:**
| Error | Cause | Recovery |
|-------|-------|----------|
| CONFIG_NOT_FOUND | YAML file doesn't exist | Run `/team list` to see available configs |
| OVERSEER_UNAVAILABLE | MCP server not running | Start Overseer server |
| AGENT_LAUNCH_FAILED | CLI command failed | Check launch command in config |
| AGENT_UNRESPONSIVE | No ACK after retries | Retry manually or remove from roster |

---

### /team status

**Purpose:** Display real-time team health — heartbeats, roles, tasks, state per agent.

**Syntax:**
```
/team status
```

**Output:**
```
═══════════════════════════════════════════════════════════════
TEAM STATUS: Team 2
═══════════════════════════════════════════════════════════════
Agent   Model    Role        State     Task           Last HB
────────────────────────────────────────────────────────────────
o-2     claude   director    WORKING   coordinating   12s ago
c-2     claude   executor    WORKING   TASK-003       8s ago
x-2     codex    validator   IDLE      —              45s ago
g-2     gemini   executor    WORKING   TASK-004       15s ago
k-2     kimi     executor    STALE     TASK-002       185s ago

Write Policy: read_only
Active Tasks: 3/5 agents working
Warnings: k-2 STALE (3 missed heartbeats — remediation pending)
═══════════════════════════════════════════════════════════════
```

**State Values:**

| State | Description |
|-------|-------------|
| IDLE | Awaiting task assignment |
| WORKING | Executing a task |
| STALE | 2+ missed heartbeats |
| STUCK | 3+ missed heartbeats, remediation attempted |
| DEAD | Session not responding or killed |

**Copilot mode:** `/team status` captures worker terminal output via `get_agent_output` and delivers a three-lens CEO assessment (Jobs/Musk/Huang) with ACTION recommendation.

**Data Sources:**
- Heartbeats: `get_worker_heartbeats` MCP tool
- State: `detect_state` MCP tool
- Tasks: Relay messages filtered by team

---

### /team disband

**Purpose:** Graceful team shutdown. Default kills sessions; `--keep` preserves them.

**Syntax:**
```
/team disband [--keep]
```

**Arguments:**
| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| --keep | No | false | Send idle signal but leave tmux sessions/panes alive |

**Examples:**
```
/team disband          → Shutdown agents AND kill tmux sessions/panes
/team disband --keep   → Send idle signal, leave sessions/panes alive for reuse
```

**Copilot mode:** `/team disband` clears copilot state and confirms worker is still running. Worker session is NOT killed.

**Execution (default — kill):**
1. Post `TEAM_DISBAND` to relay
2. Wait for each agent to ACK idle (30s per agent)
3. Unresponsive: `C-c` interrupt, wait 10s, check again

**Session Mode:**
4. Still unresponsive: `tmux kill-session -t {agent}`
5. Responsive: `tmux kill-session -t {agent}`

**Pane Mode:**
4. Kill non-director panes: `tmux kill-pane -t {pane_id}`
5. Full disband: `tmux kill-session -t team-{team_id}` (atomic)

6. Post `TEAM_DISBANDED` to relay
7. Agent (o-2) NEVER killed

**Execution (--keep):**
1. Post `TEAM_DISBAND` to relay
2. Wait for each agent to ACK idle
3. Sessions remain alive, agents idle
4. Post `TEAM_IDLE` to relay

**Output:**
```
═══════════════════════════════════════════════════════════════
TEAM DISBANDED: Team 2
═══════════════════════════════════════════════════════════════
  o-2    director    SURVIVED (director never self-terminates)
  c-2    executor    SESSION KILLED
  x-2    validator   SESSION KILLED
  g-2    executor    SESSION KILLED
  k-2    executor    SESSION KILLED (force — unresponsive)
═══════════════════════════════════════════════════════════════
```

---

### /team list

**Purpose:** Show available team configs from operator's teams directory.

**Syntax:**
```
/team list
```

**Output:**
```
═══════════════════════════════════════════════════════════════
AVAILABLE TEAM CONFIGS
═══════════════════════════════════════════════════════════════
Config        Type                           Agents
──────────────────────────────────────────────────────
team-2        director_executor_validator     5
cm-review     director_executor_validator     5
═══════════════════════════════════════════════════════════════
Source: profiles/operator/teams/
Activate: /team activate <config>
═══════════════════════════════════════════════════════════════
```

**Data Source:** Glob `profiles/{operator}/teams/*.yaml`

---

### /team config

**Purpose:** Display parsed config without activating. Useful for review before activation.

**Syntax:**
```
/team config <name>
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| name | Yes | Config name (without .yaml) |

**Output:**
```
═══════════════════════════════════════════════════════════════
TEAM CONFIG: team-2
═══════════════════════════════════════════════════════════════
Name:     Team 2
Type:     director_executor_validator
Runtime:  tmux | Session Mode: sessions
Team ID:  2

Agents (prefix → session name = {prefix}-{team_id}):
  o → o-2    claude   director   launch: "claude --dangerously-skip-permissions"
  c → c-2    claude   executor   launch: "claude --dangerously-skip-permissions"
  x → x-2    codex    validator  launch: "codex"
                                 notes: "Slow reasoning. Provide explicit acceptance criteria."
  g → g-2    gemini   executor   launch: "gemini --yolo --model gemini-3-pro-preview"
                                 notes: "Writes without permission. Constrain task scope."
  k → k-2    kimi     executor   launch: "kimi --yolo"

Activation:
  Mode: visual | Handshake: required | Subscribe: 60s x 20 cycles
  Heartbeat: 60s

Write Policy: read_only (override: explicit_task_grant)
Idle Policy:  5 min → announce_idle
Disband:      kill_sessions (director survives)
═══════════════════════════════════════════════════════════════
```

**Errors:**
| Error | Cause | Recovery |
|-------|-------|----------|
| CONFIG_NOT_FOUND | YAML file doesn't exist | Run `/team list` |

---

## Integration with Shell Protocol

The `/team` command family extends Shell Protocol (Module 002). When Module 010 loads:

- `/team` subcommands become available in the command vocabulary
- `/help` output includes Team Commands section
- `/status` shows active team info when a team is running

### Help Output Addition

```
Team Commands: (CONDITIONAL - loaded with /team activate)
  /team activate <config>    Activate team from YAML config
  /team status               Team health and heartbeat dashboard
  /team disband [--keep]     Graceful team shutdown
  /team list                 Available team configs
  /team config <name>        Display config without activating
```

---

## Claude Native Implementation

The `/team` command is implemented as a Claude skill at `~/.claude/skills/team/SKILL.md`.

| Subcommand | Primary MCP Tool |
|------------|-----------------|
| activate | `activate_dev_team`, `send_to_agent`, `detect_state` |
| status | `get_worker_heartbeats`, `detect_state` |
| disband | `post_message`, `send_to_agent` |
| list | Filesystem glob (no MCP needed) |
| config | Filesystem read + YAML parse (no MCP needed) |

---

*Team Commands v1.0.0*
*Shell Protocol Extension for Native Team Orchestration*
