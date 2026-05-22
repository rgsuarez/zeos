# Overseer Troubleshooting Guide

Solutions for common issues with the Overseer MCP server.

## Table of Contents

1. [MCP Connection Issues](#mcp-connection-issues)
2. [tmux Session Issues](#tmux-session-issues)
3. [Relay Database Issues](#relay-database-issues)
4. [Rate Limiting](#rate-limiting)
5. [State Detection Issues](#state-detection-issues)
6. [Team Protocol Issues](#hive-protocol-issues)

---

## MCP Connection Issues

### "Not connected to MCP server"

**Symptom:** Agent reports MCP tools are unavailable or "Not connected."

**Root Cause:** Missing or incorrect `.mcp.json` configuration.

**Solution:**

1. **Create project-level `.mcp.json`:**
   ```bash
   cat > /path/to/project/.mcp.json << 'EOF'
   {
     "mcpServers": {
       "overseer": {
         "command": "~/projects/overseer/.venv/bin/python",
         "args": ["-m", "overseer.server"]
       }
     }
   }
   EOF
   ```

2. **Or create global `.mcp.json`:**
   ```bash
   cat > ~/.mcp.json << 'EOF'
   {
     "mcpServers": {
       "overseer": {
         "command": "~/projects/overseer/.venv/bin/python",
         "args": ["-m", "overseer.server"]
       }
     }
   }
   EOF
   ```

3. **Restart agent session** to pick up new configuration.

**Critical:** Use full path to venv python. The bare `python` command may not exist or may point to wrong interpreter.

---

### "python: command not found"

**Symptom:** MCP server fails to start with python not found error.

**Root Cause:** System python not installed or not in PATH.

**Solution:** Use virtual environment python with full path:
```json
{
  "mcpServers": {
    "overseer": {
      "command": "~/projects/overseer/.venv/bin/python",
      "args": ["-m", "overseer.server"]
    }
  }
}
```

---

### "ModuleNotFoundError: No module named 'overseer'"

**Symptom:** MCP server starts but can't find overseer module.

**Root Cause:** Package not installed in development mode.

**Solution:**
```bash
cd ~/projects/overseer
.venv/bin/pip install -e ".[dev]"
```

---

### MCP Server Not Responding

**Symptom:** Tools hang or timeout without response.

**Diagnosis:**
```bash
# Check if server process is running
ps aux | grep overseer

# Test server manually
~/projects/overseer/.venv/bin/python -m overseer.server
```

**Solutions:**
1. Kill any zombie processes: `pkill -f overseer.server`
2. Restart agent sessions
3. Check for port conflicts (if applicable)

---

## tmux Session Issues

### "Could not capture from session"

**Symptom:** `get_agent_output` returns error about missing session.

**Diagnosis:**
```bash
# List all tmux sessions
tmux list-sessions

# Check if target session exists
tmux has-session -t claude-2 && echo "exists" || echo "missing"
```

**Solutions:**

1. **Create missing session:**
   ```bash
   tmux new-session -d -s claude-2
   ```

2. **Session naming convention:**
   - Claude agents: `claude-1`, `claude-2`, `claude-3`
   - Gemini agents: `gemini-1`, `gemini-2`, `gemini-3`
   - Codex agents: `codex-1`, `codex-2`

3. **Attach to verify:**
   ```bash
   tmux attach-session -t claude-2
   # Ctrl-B, D to detach
   ```

---

### "send_to_agent" Not Working

**Symptom:** Message appears sent but agent doesn't receive it.

**Verification Steps:**
```bash
# Manually send test message
tmux send-keys -t claude-2 "test message"
tmux send-keys -t claude-2 "Enter"

# Capture to verify
tmux capture-pane -t claude-2 -p | tail -5
```

**Common Issues:**

1. **Missing carriage return:** Overseer sends `Enter` as explicit second step. Manual sends require `C-m`:
   ```bash
   tmux send-keys -t claude-2 "message" C-m
   ```

2. **Agent is busy:** Check state before sending:
   ```python
   state = detect_state("claude-2")
   # Should be "idle" for message to be received
   ```

3. **Agent in special mode:** Some agents have modal interfaces (vim, less, etc.) that don't accept normal input.

---

### Terminal Output Garbled

**Symptom:** Captured output contains escape codes or garbage characters.

**Root Cause:** ANSI stripping not complete.

**Workaround:** Output is stripped via regex. If new escape sequences appear:
```python
# Current pattern in server.py
ansi_pattern = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]')
```

Report unhandled sequences as issues.

---

## Relay Database Issues

### "database is locked"

**Symptom:** SQLite error about locked database.

**Root Cause:** Multiple processes writing simultaneously.

**Solutions:**

1. **Wait and retry:** SQLite lock is transient
2. **Check for zombie processes:**
   ```bash
   fuser ~/.overseer/relay.db
   ```
3. **Nuclear option (data loss):**
   ```bash
   rm ~/.overseer/relay.db
   # Database recreates on next use
   ```

---

### Database Location

```bash
# Default path
~/.overseer/relay.db

# Verify exists
ls -la ~/.overseer/relay.db

# Check size
du -h ~/.overseer/relay.db
```

---

### Inspecting Relay Messages

```bash
# Open database
sqlite3 ~/.overseer/relay.db

# List recent messages
SELECT id, agent, type, substr(content, 1, 50), timestamp
FROM messages
ORDER BY id DESC
LIMIT 20;

# Count by type
SELECT type, count(*) FROM messages GROUP BY type;

# Filter by agent
SELECT * FROM messages WHERE agent = 'claude-2' ORDER BY id DESC LIMIT 10;
```

---

### Clearing Old Messages

```bash
sqlite3 ~/.overseer/relay.db

# Delete messages older than 24 hours
DELETE FROM messages WHERE timestamp < datetime('now', '-1 day');

# Vacuum to reclaim space
VACUUM;
```

---

## Rate Limiting

### "Rate limit exceeded"

**Symptom:** Tools return rate_limited status.

**Root Cause:** Too many messages sent in short period.

**Response Structure:**
```json
{
  "status": "rate_limited",
  "agent": "claude-2",
  "error": "Rate limit exceeded. Tokens available: 0.0",
  "retry_after_seconds": 1.0
}
```

**Solutions:**

1. **Wait and retry:** Token bucket refills at 1 token/second
2. **Batch operations:** Combine multiple small messages into one
3. **Use subscribe:** Long-polling is more efficient than repeated get_messages

**Rate Limits:**
| Operation | Bucket | Rate | Burst |
|-----------|--------|------|-------|
| Relay messages | per agent | 1/sec | 10 |
| Terminal sends | per `terminal:{agent}` | 1/sec | 10 |

---

## State Detection Issues

### "Unknown" State

**Symptom:** `detect_state` returns "unknown" for known agent.

**Root Cause:** Agent type not in heuristics or output doesn't match patterns.

**Diagnosis:**
```python
# Check if agent has heuristics
# Known agents: "claude", "gemini", "codex"

# Capture output and inspect
output = get_agent_output("claude-2", 50)
print(output[-500:])  # Check what patterns are present
```

**Solution:** Agent identifiers must start with known prefix:
- `claude-*` → claude heuristics
- `gemini-*` → gemini heuristics
- `codex-*` → codex heuristics

---

### False "Working" State

**Symptom:** Agent shows as working but is actually idle.

**Root Cause:** Spinner character or "Thinking" text still in terminal buffer.

**Solution:** Clear terminal or scroll past old output:
```bash
tmux send-keys -t claude-2 "clear" C-m
```

---

### Stuck Detection

**Symptom:** Agent detected as "stuck" but is actually working.

**Thresholds:**
- `STUCK`: WORKING state + no output change for 5 minutes
- `STALE`: No output change for 10 minutes

**Solution:** If agent is legitimately working on long operation:
1. Heartbeats update terminal hash, preventing false stuck detection
2. Ensure worker posts heartbeats every 60s during long tasks

---

## Team Protocol Issues

### Task Not Received by Worker

**Symptom:** Director dispatches task but worker doesn't receive it.

**Diagnosis:**
```python
# Check if task is in relay
messages = get_messages(since_id=0)
task_assigns = [m for m in messages if m['type'] == 'task_assign']
print(task_assigns[-1])  # Latest task assignment
```

**Common Issues:**

1. **Worker name mismatch:**
   ```python
   # Task must specify exact worker name
   dispatch_task(
       director="gemini-2",
       worker="claude-2",  # Must match listen_for_task worker_name
       task_id="task-001",
       description="Do something"
   )
   ```

2. **Worker not listening:** `listen_for_task` must be called before dispatch

3. **since_id too high:** Worker may have missed the message
   ```python
   # Use since_id=0 to catch all, or track last seen ID
   listen_for_task(worker_name="claude-2", since_id=0)
   ```

---

### Heartbeat Not Posted

**Symptom:** Worker executes task but no heartbeats appear in relay.

**Verification:**
```python
# Check heartbeats in relay
heartbeats = get_messages(since_id=0)
hb = [m for m in heartbeats if m['type'] == 'heartbeat']
print(len(hb), "heartbeats found")
```

**Solutions:**

1. **Manual heartbeat:** Call `post_heartbeat` directly:
   ```python
   post_heartbeat(
       worker="claude-2",
       task_id="current-task",
       progress_pct=50,
       current_action="Processing data"
   )
   ```

2. **Check heartbeat registry:**
   ```python
   status = get_worker_heartbeats(["claude-2"])
   print(status)
   ```

---

### Worker Shows as CRASHED

**Symptom:** `get_worker_heartbeats` returns CRASHED status.

**Threshold:** No heartbeat AND no terminal activity for 10 minutes.

**Diagnosis:**
```python
status = get_worker_heartbeats(["claude-2"])
print(status["workers"]["claude-2"])
# Check seconds_since_heartbeat
```

**Solutions:**

1. **Verify agent is running:**
   ```bash
   tmux list-sessions | grep claude-2
   tmux capture-pane -t claude-2 -p | tail -10
   ```

2. **Restart agent if actually crashed**

3. **Post heartbeat to clear status:**
   ```python
   post_heartbeat(worker="claude-2", task_id="recovery")
   ```

---

## Quick Diagnostic Commands

```bash
# Check all tmux sessions
tmux list-sessions

# Test MCP server
~/projects/overseer/.venv/bin/python -c "from overseer.server import mcp; print('OK')"

# Check relay DB
sqlite3 ~/.overseer/relay.db "SELECT count(*) FROM messages;"

# Check recent messages
sqlite3 ~/.overseer/relay.db "SELECT id, agent, type FROM messages ORDER BY id DESC LIMIT 5;"

# Monitor relay in real-time
watch -n 2 "sqlite3 ~/.overseer/relay.db 'SELECT id, agent, type FROM messages ORDER BY id DESC LIMIT 5;'"
```

---

## Emergency Recovery

If everything is broken:

```bash
# 1. Kill all overseer processes
pkill -f overseer

# 2. Clear database
rm ~/.overseer/relay.db

# 3. Restart tmux sessions
tmux kill-server  # WARNING: kills ALL sessions
tmux new-session -d -s claude-2
tmux new-session -d -s gemini-2

# 4. Restart agents in each session
tmux send-keys -t claude-2 "claude" C-m
tmux send-keys -t gemini-2 "gemini" C-m
```

---

*Troubleshooting Guide by Claude-2 — zeos Documentation Protocol*
