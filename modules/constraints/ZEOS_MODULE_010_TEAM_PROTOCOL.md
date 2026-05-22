---
module_id: "team-protocol"
module_type: "constraint"
version: "1.0.0"
created: "2026-02-08"
updated: "2026-02-08"
author: "Claude (system)"
status: "active"
load_priority: 5
dependencies: ["shell-protocol"]
conflicts: []
auto_load: false
load_trigger: "/team activate"
authority: "Operator directive 2026-02-08 — Native Team Orchestration"
update_reason: "Initial creation — governance over multi-agent teams"
---

# Module #010: Team Protocol

## Purpose

This module defines **governance rules for multi-agent team operations** within zeos. It provides the constraint framework that replaces manual orchestration instructions with declarative configuration.

**Problem Solved:** Every team activation requires Operator to type a paragraph of orchestration instructions — agent names, subscribe loops, ACK requirements, write prevention, agent quirks, idle protocols. This is unsustainable, error-prone, and non-reproducible.

**Solution:** Declarative YAML team configs loaded by `/team activate <config>`. The governance rules in this module bind all team agents. The strategy protocol provides behavioral patterns. Operator types one command instead of a paragraph.

**Architecture Position:** This module governs Overseer (infrastructure) the same way zeos governs git — it doesn't replace Overseer, it defines HOW Overseer is used.

---

## Supremacy Hierarchy Compliance

```
KERNEL (SOUL.md, BOOT_PROTOCOL.md) — Immutable law
    ↓ supersedes
MODULE 010 (This file) — Team governance rules
    ↓ supersedes
TEAM CONFIG (profiles/{operator}/teams/*.yaml) — Operator preferences
    ↓ supersedes
SESSION (Ephemeral team coordination)
```

Team configs cannot override Module 010 constraints. Module 010 cannot override Kernel law.

---

## Team Types

| Type | Structure | Use Case |
|------|-----------|----------|
| `director_executor_validator` | Director decomposes + assigns. Executors build. Validator reviews. | Standard development workflow |
| `swarm` | Flat hierarchy, all peers. No central coordinator. | Brainstorming, parallel research |
| `hierarchical` | Multi-level: Lead Director → Sub-Directors → Executors | Large-scale coordination (future) |
| `copilot` | Current agent observes a pre-existing worker. No relay, no role cards. | Strategic advisory, quality judgment |

### Role Definitions

| Role | Permissions | Constraints |
|------|------------|-------------|
| **director** | Decompose tasks, assign work, monitor progress, read all repos | Self-terminates only via Mission Complete Protocol after final report. Never self-terminates during active coordination or manual disband. Coordination only — no direct code writes unless explicitly tasked. |
| **executor** | Execute assigned tasks, post heartbeats, request clarification | Operates under write policy. Must ACK tasks within window. Must post heartbeats. |
| **validator** | Review executor output, issue GO/NOGO, request rework | Read-only by default. Provides acceptance criteria in review, not implementation. |
| **peer** | Equal to all others. Read + write per policy. | Swarm mode only. Self-coordinates via relay. |
| **copilot** | Observe worker terminal, assess quality, advise Operator. | Read-only. Never contacts worker directly. |

---

## Team Config Schema

Team configurations are YAML files stored at `profiles/{operator}/teams/{config-name}.yaml`.

### Required Fields

```yaml
team_id: "2"                           # Unique identifier (matches Overseer team isolation)
name: "Team 2"                         # Human-readable name
type: "director_executor_validator"    # Team type (see table above)
runtime: "tmux"                        # Runtime: tmux (v1.0) | api (future) | process (future)
session_mode: "sessions"               # Optional: "sessions" (default) | "panes" (all agents in one tmux session)

agents:                                # Agent roster — keys are PREFIX only (no suffix)
  <prefix>:                            # Agent prefix (e.g., o, c, x, g, k). Session name derived: {prefix}-{team_id}
    model: "<model>"                   # claude | gemini | codex | kimi | grok
    role: "<role>"                     # director | executor | validator | peer
    launch: "<command>"                # CLI launch command
    notes: "<quirks>"                  # Optional: agent-specific operating notes
    ack_window_seconds: 10           # Optional: per-agent ACK window override (e.g., 30 for Codex)
```

**Session Name Derivation:** Agent keys in YAML are prefixes. The activation logic derives `session_name = "{prefix}-{team_id}"`. Example: key `o` in a config with `team_id: "4"` produces session name `o-4`. This ensures Overseer's `extract_team()` (which derives team from the session name suffix) always matches the config's `team_id`.

**Validation:** If an agent key contains a `-` followed by digits (legacy format like `o-2`), the activation logic strips the suffix and re-derives from `team_id`. A warning is emitted.

### Optional Fields

```yaml
activation:
  mode: "visual"                       # visual (interactive) | background (deprecated)
  require_handshake: true              # Require ACK before task assignment
  subscribe_timeout: 180               # Seconds per subscribe cycle
  subscribe_cycles: 20                 # Max cycles before idle announcement (minimum: 20)
  heartbeat_interval: 60               # Seconds between heartbeats
  ack_window_seconds: 10               # Default ACK window (seconds). Per-agent override via agents.{name}.ack_window_seconds

write_policy:
  default: "read_only"                 # read_only | read_write
  override_requires: "explicit_task_grant"  # How to override default

idle_policy:
  timeout_minutes: 5                   # Minutes without task before idle announcement
  action: "announce_idle"              # announce_idle | auto_disband

disband:
  default: "kill_sessions"             # kill_sessions | keep_sessions
  director_survives: true              # Director survives manual /team disband (Mission Complete Protocol overrides)
  ack_timeout: 30                      # Seconds to wait for idle ACK
  force_kill_timeout: 10               # Seconds after interrupt before force kill

context:                               # Optional: task context files
  blueprint: "<path>"                  # Blueprint to review/execute
  spec: "<path>"                       # Specification document
  files: ["<path>", ...]              # Additional context files
```

### Schema Defaults

When optional fields are omitted, these defaults apply:

| Field | Default |
|-------|---------|
| `activation.mode` | `visual` |
| `activation.require_handshake` | `true` |
| `activation.subscribe_timeout` | `60` (per cycle; each `listen_for_task` call capped at 50s by Overseer) |
| `activation.subscribe_cycles` | `20` (minimum: 20) |
| `activation.heartbeat_interval` | `60` |
| `write_policy.default` | `read_only` |
| `write_policy.override_requires` | `explicit_task_grant` |
| `idle_policy.timeout_minutes` | `5` |
| `idle_policy.action` | `announce_idle` |
| `disband.default` | `kill_sessions` |
| `disband.director_survives` | `true` |
| `disband.ack_timeout` | `30` |
| `activation.ack_window_seconds` | `10` |
| `disband.force_kill_timeout` | `10` |

---

## Team Lifecycle

### 1. Activate

```
/team activate <config>
```

Sequence:

0. **Clear team relay** — `clear_team_messages(team_id)` removes stale messages from previous activations. Prevents workers from picking up old TASK_ASSIGN messages before director can coordinate.

**Session Mode** (`session_mode: sessions`, default) — per agent in roster:
1. Check tmux session exists: `tmux has-session -t {agent}`
2. If missing: `tmux new-session -d -s {agent}` — spawn detached
3. Launch agent CLI: `tmux send-keys -t {agent} '{launch}' C-m`
4. Wait for IDLE state (30s timeout via `detect_state`)
5. Inject role card + subscribe instruction via `send_to_agent`
6. Confirm ACK via relay message (10s window)
7. If no ACK: retry once, then report agent as UNRESPONSIVE

**Pane Mode** (`session_mode: panes`) — all agents in one session:
1. Create parent session: `tmux new-session -d -s team-{team_id}`
2. Per agent: `tmux split-window -t team-{team_id} -d -P -F "#{pane_id}"`
3. Set pane title: `tmux select-pane -t {pane_id} -T {agent}`
4. Launch agent CLI: `tmux send-keys -t {pane_id} '{launch}' C-m`
5. After all agents: `tmux select-layout -t team-{team_id} tiled`
6. Kill empty initial pane: `tmux kill-pane -t team-{team_id}:0.0`
7. Inject role cards and confirm ACKs (same as session mode steps 4-7)

**Activation completes when:** All agents ACK'd, or Operator informed of unresponsive agents.

### 2. Coordinate

Active team operates under:
- **Write Policy** — Agents respect read_only default unless task grants write
- **Heartbeat Protocol** — Executors post heartbeats at configured interval
- **ACK Protocol** — Tasks require positive acknowledgment before considered assigned
- **Subscribe Loop** — Agents poll for tasks per strategy protocol
- **Idle Protocol** — Agents announce idle after configured timeout

### 3. Disband

```
/team disband [--keep]
```

Default sequence (manual `/team disband`):
1. Post `TEAM_DISBAND` to relay — all agents see it
2. Wait for each agent to ACK idle (`ack_timeout` seconds)
3. Unresponsive agents: `C-c` interrupt, wait `force_kill_timeout`, check again

**Session Mode** (default):
4. Still unresponsive: `tmux kill-session -t {agent}`
5. Responsive agents: `tmux kill-session -t {agent}`

**Pane Mode** (`session_mode: panes`):
4. Kill non-director panes: `tmux kill-pane -t {pane_id}` (or Overseer `kill_agent`)
5. Full disband: `tmux kill-session -t team-{team_id}` (atomic)

6. Post `TEAM_DISBANDED` to relay as final record
7. Director survives (`director_survives: true` applies to manual disband only)

`--keep` skips steps 4-5: sessions/panes stay alive, agents idle.

### 4. Mission Complete (Auto-Disband)

When the director's mission is fully complete and the final report has been posted to Operator, the director executes auto-disband:

**Session Mode:**
```
1. Post TEAM_DISBAND status to relay: "Mission complete. Self-destructing."
2. Kill each non-director agent session: tmux kill-session -t {agent}
3. Kill director's own session last: tmux kill-session -t {director}
```

**Pane Mode:**
```
1. Post TEAM_DISBAND status to relay: "Mission complete. Self-destructing."
2. Kill the entire team session: tmux kill-session -t team-{team_id}
```

**Constraints:**
- Auto-disband is triggered ONLY by the director after all tasks are verified complete
- The final report MUST be posted to Operator before auto-disband begins
- `disband.director_survives` does NOT apply to Mission Complete Protocol — the director self-terminates
- If any task is incomplete or pending validation, auto-disband MUST NOT execute

---

## Write Prevention Policy

**Default: All team agents operate in read-only mode.**

Write access is granted ONLY when:
1. A task explicitly includes write permission in its description
2. The agent's role permits writes (director coordination writes are always allowed)
3. Operator issues a direct override

**Enforcement:** Advisory — agents are instructed via role card. Not filesystem-level enforcement.

**Rationale:** Prevents agents (especially Gemini) from making unauthorized writes. Forces deliberate task scoping.

---

## ACK Protocol (Positive Acknowledgment)

**No task is considered assigned until the executor ACKs.**

| Step | Actor | Action | Timeout |
|------|-------|--------|---------|
| 1 | Director | Post `TASK_ASSIGN` via relay | — |
| 2 | Executor | Post `TASK_ACCEPT` via relay | 10s |
| 3 | Director | Confirm assignment | — |

**Timeout cap:** `listen_for_task` is capped at 50s per call by Overseer to stay safely under MCP client 60s transport limits. The `subscribe_timeout` config value represents total time across all cycles, not per-call.

**On timeout (no ACK in 10s):**
1. Retry once (re-send task)
2. If still no ACK: mark agent as UNRESPONSIVE
3. Reassign task to another available executor
4. Post relay message documenting reassignment

### Completion Protocol

| Step | Actor | Action | Timeout |
|------|-------|--------|---------|
| 1 | Executor | Post `TASK_COMPLETE` via relay | — |
| 2 | Director | Route to validator (if applicable) | — |
| 3 | Validator | Post `VALIDATION_RESULT` (GO/NOGO/REWORK) | Per-task |

On NOGO or REWORK: Director reassigns task to executor with validator feedback.

---

## Heartbeat Requirements

Active executors MUST post heartbeats at the configured interval (default: 60s).

**Heartbeat contains:**
- `worker`: Agent identifier
- `task_id`: Current task
- `progress_pct`: Estimated progress (0-100)
- `current_action`: Brief description
- `state`: idle | working | waiting

**Stall Detection:**
- 2 missed heartbeats → STALE (warning to director)
- 3 missed heartbeats → STUCK (auto-remediation triggered)
- Remediation: `C-c` interrupt → reassign if retries not exhausted

---

## Agent Quirks Register

Known behavioral patterns that team configs and directors must account for:

| Model | Quirk | Mitigation |
|-------|-------|------------|
| **Codex** | Slow reasoning mode. Extended thinking takes 30-60s. | Provide explicit acceptance criteria. Set longer ACK timeout (30s). |
| **Gemini** | Writes without permission. Will modify files unprompted. | Strict read-only default. Constrain task scope. Never grant blanket write access. |
| **Kimi** | New to team operations. Behavior patterns still being mapped. | Start with bounded, well-defined tasks. Monitor closely. |
| **Grok** | Contrarian tendencies. May push back on task framing. | Useful as validator/reviewer. Channel pushback into dissent documentation. |
| **Claude** | Reliable executor but can over-engineer. | Keep task scope tight. Prefer explicit definition of done. |

**Note:** This register is a living document. Update as new patterns emerge. Agent-specific notes in team YAML configs supplement these defaults.

---

## Integration Points

### Overseer (Infrastructure Backend)
- Team isolation via `team_id` in Overseer relay
- Heartbeat monitoring via `post_heartbeat` / `get_worker_heartbeats`
- Task dispatch via `dispatch_task_sync` (positive ACK loop)
- Stall detection via `auto_remediate_stalls`
- Agent state observation via `detect_state`, `get_agent_output`

### Continuous Memory (Phase 3.1)
- Team operations generate session artifacts (relay messages, heartbeats)
- These artifacts feed into Continuous Memory's snap broadcast system
- Cross-agent context sync leverages team relay as transport layer

### Phoenix Mode (Session Rotation)
- Team agents can be rotated individually without disbanding the team
- Rotation uses existing `initiate_rotation` → `shadow_ready` → `send_handoff_digest` flow
- Director coordinates rotation timing to minimize task interruption

### Blueprint Protocol
- Blueprints provide task decomposition that directors distribute to executors
- `/team activate` with `context.blueprint` pre-loads blueprint into director's context
- Task IDs from blueprint tiers map to Overseer `task_id` for progress tracking

---

## Runtime Abstraction

The `runtime` field in team configs abstracts the execution environment:

| Runtime | Status | Description |
|---------|--------|-------------|
| `tmux` | **Supported (v1.0)** | Interactive terminal sessions. Overseer observes via `capture-pane`. |
| `api` | Future | API-based agents. No terminal required. |
| `process` | Future | Subprocess agents. Managed by parent process. |

### Session Modes (tmux runtime)

The `session_mode` field controls how agents are organized within tmux:

| Mode | Status | Description |
|------|--------|-------------|
| `sessions` | **Default** | Each agent gets its own tmux session. Session-per-agent isolation. |
| `panes` | **Supported (v1.1)** | All agents run as panes in a single session (`team-{team_id}`). Visual monitoring, atomic disband. |

**Pane mode benefits:** Single `tmux attach` shows all agents. One `kill-session` disbands atomically. Pane IDs are globally unique and stable (tmux 3.x). Each pane has independent scroll buffers and process isolation.

**v1.0 constraint:** Only `tmux` runtime is implemented. The `session_mode` abstraction exists to support both session-per-agent and pane-per-agent topologies within the tmux runtime.

---

## Security Constraints

- Team configs MUST NOT contain credentials, tokens, or secrets
- Agent launch commands MUST NOT embed API keys (use environment variables)
- Relay messages are team-isolated (Overseer enforces via `team_id`)
- Audit log captures all team operations for post-session review

---

## Validation Criteria

A team session correctly implements Team Protocol if:

1. All agents ACK their role assignment before receiving tasks
2. Write policy is enforced — no unauthorized writes
3. Heartbeats flow at configured interval from active executors
4. Stall detection triggers remediation within 3 missed heartbeats
5. Disband sequence completes — all agents idle or killed
6. On manual disband: director survives. On mission complete: director self-terminates after final report
7. Operator types zero orchestration instructions beyond `/team activate`

---

*Module #010: Team Protocol v1.0.0*
*Part of zeos Native Team Orchestration*
