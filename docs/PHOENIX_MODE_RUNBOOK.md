# Phoenix Mode: Operator Runbook

## Setup (One-Time)

### 1. Overseer MCP Configured

Ensure all CLI tools have Overseer configured:

**Claude Code** (`~/.mcp.json` or project `.mcp.json`):
```json
{"mcpServers":{"overseer":{"command":"~/projects/zeos/infrastructure/overseer/.venv/bin/python","args":["-m","overseer.server"]}}}
```

**Gemini CLI** (`~/.gemini/settings.json`): Same structure.

### 2. tmux Sessions

All agents must run in named tmux sessions with team suffix:

```bash
tmux new-session -d -s claude-1      # Primary
tmux new-session -d -s gemini-1      # Monitor
tmux new-session -d -s claude2-1     # Shadow
```

All agents on same team (suffix `-1`) for relay visibility.

### 3. Agent Roles

| tmux Session | Agent | Role | Purpose |
|-------------|-------|------|---------|
| `claude-1` | Claude Code | Primary | Does the work |
| `gemini-1` | Gemini CLI | Monitor | Watches Primary, orchestrates rotation |
| `claude2-1` | Claude Code | Shadow | Fresh agent, receives handover |

## Starting a Phoenix Mode Session

### 1. Start Primary

In `claude-1` tmux pane:
```
/zeos
/project <project-id>
# Begin work normally
```

### 2. Start Monitor

In `gemini-1` tmux pane:
```
/zeos
# Load Phoenix Mode Monitor Orders
# Read: ~/projects/zeos/docs/PHOENIX_MODE_MONITOR_ORDERS.md
# Begin watch loop: estimate_context_usage("claude-1") every 2-3 min
```

### 3. Start Shadow

In `claude2-1` tmux pane:
```
/zeos
# Load Phoenix Mode Shadow Orders
# Read: ~/projects/zeos/docs/PHOENIX_MODE_SHADOW_ORDERS.md
# Call listen_for_warm_shadow(shadow_agent="claude2-1", timeout=3600)
# Agent blocks until WARM_SHADOW arrives
```

## During Work

- **Operator works with Primary normally** -- no change to workflow
- **Monitor observes silently** -- polls `estimate_context_usage` and `get_agent_output`
- **Shadow idles** -- waiting for WARM_SHADOW

## Rotation (Automated by Monitor)

When Monitor detects Primary at ~70%+ context:

1. Monitor calls `initiate_rotation` -> WARM_SHADOW sent to Shadow
2. Shadow pre-warms (loads zeos + project), calls `shadow_ready`
3. Monitor calls `synthesize_handoff_digest` (provides objective + decisions + next actions)
4. Monitor calls `send_handoff_digest` -> digest sent to Shadow
5. Shadow parses digest, calls `send_intent_statement` (proves understanding)
6. Monitor calls `send_final_ack` on behalf of Primary (approved=true)
7. Monitor calls `complete_rotation` -> SWITCH_ROUTE posted

### Operator's Only Action

**Switch tmux pane** from `claude-1` to `claude2-1`. That's it.

Shadow (now Primary) continues work from where claude-1 left off.

## Post-Rotation

1. Old Primary (`claude-1`) should run `/end` to close session cleanly
2. Old Primary becomes available as next Shadow
3. Restart the cycle: new Shadow calls `listen_for_warm_shadow`

## Manual Rotation

If you want to rotate without waiting for context exhaustion:

Tell Monitor: "Rotate now to claude2-1"

Monitor executes the same sequence with `reason="manual"`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Monitor can't see Primary output | Verify both agents are on same team (same `-N` suffix) |
| Shadow never receives WARM_SHADOW | Check team suffix matches. Run `get_messages` to verify relay |
| Digest rejected (size) | `synthesize_handoff_digest` auto-truncates. If still too large, reduce terminal capture |
| Agent disconnected from Overseer | Run `/mcp` in agent to reconnect |
| Monitor hitting own context limit | Take manual control. Tell Monitor to stop watching and rotate it out |

## Quick Reference

```
Rotation Flow:
  Monitor: initiate_rotation -> wait_for_shadow_ready -> synthesize_handoff_digest -> send_handoff_digest -> wait_for_intent -> send_final_ack -> complete_rotation
  Shadow:  listen_for_warm_shadow -> shadow_ready -> wait_for_digest -> send_intent_statement -> [becomes Primary]
  Primary: [works normally] -> [ACKs via Monitor] -> /end (background)
```
