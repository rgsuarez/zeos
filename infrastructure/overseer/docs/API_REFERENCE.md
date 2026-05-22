# Overseer API Reference

Complete specification of all MCP tools exposed by the Overseer server.

## Table of Contents

1. [Terminal Tools](#terminal-tools)
   - [get_agent_output](#get_agent_output)
   - [send_to_agent](#send_to_agent)
   - [list_agents](#list_agents)
   - [detect_state](#detect_state)
2. [Relay Tools](#relay-tools)
   - [post_message](#post_message)
   - [get_messages](#get_messages)
   - [subscribe](#subscribe)
3. [Team Protocol Tools](#hive-protocol-tools)
   - [dispatch_task](#dispatch_task)
   - [listen_for_task](#listen_for_task)
4. [Coordination Multiplier Tools](#combat-multiplier-tools)
   - [post_heartbeat](#post_heartbeat)
   - [get_worker_heartbeats](#get_worker_heartbeats)

---

## Terminal Tools

### get_agent_output

Capture terminal output from another agent's tmux session.

**Signature:**
```python
get_agent_output(agent: str, lines: int = 200) -> str
```

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `agent` | `str` | Yes | - | tmux session name (e.g., "claude-2", "gemini-1") |
| `lines` | `int` | No | 200 | Number of lines to capture (max 1000) |

**Returns:** `str`
- Clean terminal output with ANSI codes stripped
- Error message if session not found

**Caching:** 30 second TTL per agent

**Example:**
```python
# Capture last 100 lines from gemini-2
output = get_agent_output("gemini-2", 100)
```

**Response (success):**
```
Reading file at /home/user/project/main.py...

 def main():
     print("Hello, world!")

>
```

**Response (error):**
```
Error: Could not capture from session 'gemini-99'. Is the tmux session running?
```

---

### send_to_agent

Type a message into another agent's terminal. Includes pre-flight state check and post-send verification.

**Signature:**
```python
send_to_agent(
    agent: str,
    message: str,
    interrupt_if_busy: bool = False,
    verify: bool = True
) -> dict
```

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `agent` | `str` | Yes | - | tmux session name |
| `message` | `str` | Yes | - | Text to send |
| `interrupt_if_busy` | `bool` | No | `False` | Send C-c first if agent is WORKING |
| `verify` | `bool` | No | `True` | Capture output after send to confirm |

**Returns:** `dict`

**Response (success):**
```json
{
  "status": "sent",
  "agent": "claude-2",
  "message_length": 45,
  "pre_state": "idle",
  "verified": true,
  "post_output_preview": "..."
}
```

**Response (blocked):**
```json
{
  "status": "blocked",
  "agent": "claude-2",
  "agent_state": "working",
  "error": "Agent is WORKING. Set interrupt_if_busy=True to interrupt."
}
```

**Response (rate limited):**
```json
{
  "status": "rate_limited",
  "agent": "claude-2",
  "error": "Rate limit exceeded. Tokens available: 0.0",
  "retry_after_seconds": 1.0
}
```

**Notes:**
- Sends message text first, then explicit `Enter` key
- Rate limited: 1 send/second sustained, 10 burst
- Pre-flight `detect_state()` prevents interrupting busy agents

---

### list_agents

List all running tmux sessions.

**Signature:**
```python
list_agents() -> list
```

**Parameters:** None

**Returns:** `list[str]`
- List of tmux session names

**Example Response:**
```json
["claude-1", "claude-2", "codex-1", "gemini-1", "gemini-2"]
```

---

### detect_state

Detect the current operational state of an agent.

**Signature:**
```python
detect_state(agent: str) -> dict
```

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent` | `str` | Yes | tmux session name |

**Returns:** `dict`

**Response:**
```json
{
  "agent": "claude-2",
  "state": "idle",
  "confidence": "high"
}
```

**States:**
| State | Description |
|-------|-------------|
| `idle` | Ready for input (prompt visible) |
| `working` | Executing tools or thinking |
| `waiting` | Blocked on user confirmation |
| `error` | Exception or failure detected |
| `stuck` | WORKING but no output change >5min |
| `stale` | No output change >10min |
| `unknown` | No matching heuristics |

**Confidence:**
| Value | Meaning |
|-------|---------|
| `high` | Agent has defined heuristics |
| `low` | Using generic patterns |
| `none` | Error occurred |

**Caching:** 30 second TTL per agent

---

## Relay Tools

### post_message

Post a message to the shared relay.

**Signature:**
```python
post_message(
    agent: str,
    content: str,
    msg_type: str = "raw",
    ref_id: Optional[int] = None
) -> dict
```

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `agent` | `str` | Yes | - | Sender identifier |
| `content` | `str` | Yes | - | Message content |
| `msg_type` | `str` | No | `"raw"` | Message type |
| `ref_id` | `int` | No | `None` | Parent message ID (threading) |

**Message Types:**
| Type | Purpose |
|------|---------|
| `raw` | Untyped (legacy) |
| `status` | State updates |
| `query` | Information requests |
| `ack` | Acknowledgments |
| `task_assign` | Hive: Assign task |
| `task_accept` | Hive: Accept task |
| `task_complete` | Hive: Task done |
| `task_blocked` | Hive: Task blocked |
| `heartbeat` | Coordination Multiplier: Progress |

**Returns:** `dict`

**Response (success):**
```json
{
  "id": 215,
  "agent": "claude-2",
  "type": "status",
  "ref_id": null,
  "timestamp": "2026-01-24T02:15:00.000000+00:00",
  "status": "posted"
}
```

**Response (rate limited):**
```json
{
  "status": "rate_limited",
  "agent": "claude-2",
  "error": "Rate limit exceeded. Tokens available: 0.0",
  "retry_after_seconds": 1.0
}
```

---

### get_messages

Retrieve messages from the relay.

**Signature:**
```python
get_messages(
    since_id: int = 0,
    agent_filter: Optional[str] = None
) -> list
```

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `since_id` | `int` | No | `0` | Only return messages after this ID |
| `agent_filter` | `str` | No | `None` | Filter by sender agent |

**Returns:** `list[dict]`

**Response:**
```json
[
  {
    "id": 215,
    "agent": "gemini-2",
    "content": "Task assigned to claude-2",
    "type": "task_assign",
    "ref_id": null,
    "timestamp": "2026-01-24 02:15:00"
  },
  {
    "id": 216,
    "agent": "claude-2",
    "content": "{\"task_id\": \"doc-001\", ...}",
    "type": "task_accept",
    "ref_id": 215,
    "timestamp": "2026-01-24 02:15:05"
  }
]
```

---

### subscribe

Long-poll for new messages.

**Signature:**
```python
subscribe(
    since_id: int = 0,
    timeout: int = 30,
    filter_type: Optional[str] = None,
    filter_agent: Optional[str] = None
) -> list
```

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `since_id` | `int` | No | `0` | Last seen message ID |
| `timeout` | `int` | No | `30` | Max seconds to wait |
| `filter_type` | `str` | No | `None` | Only return this message type |
| `filter_agent` | `str` | No | `None` | Only return from this agent |

**Returns:** `list[dict]`
- New messages if found
- Empty list if timeout

**Behavior:**
1. Check immediately for messages > since_id
2. If found, return immediately
3. If not, sleep 30s and check again
4. Repeat until timeout or messages found

**Example (Director listening for heartbeats):**
```python
heartbeats = subscribe(
    since_id=200,
    timeout=120,
    filter_type="heartbeat"
)
```

---

## Team Protocol Tools

### dispatch_task

Assign a task to a worker (Director use).

**Signature:**
```python
dispatch_task(
    director: str,
    worker: str,
    task_id: str,
    description: str,
    priority: str = "medium",
    context: Optional[str] = None
) -> dict
```

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `director` | `str` | Yes | - | Director identifier |
| `worker` | `str` | Yes | - | Target worker identifier |
| `task_id` | `str` | Yes | - | Unique task identifier |
| `description` | `str` | Yes | - | Task description |
| `priority` | `str` | No | `"medium"` | low\|medium\|high\|critical |
| `context` | `str` | No | `None` | JSON string with extra context |

**Returns:** `dict`

**Response:**
```json
{
  "status": "dispatched",
  "message_id": 220,
  "task_id": "doc-001",
  "assigned_to": "claude-2",
  "timestamp": "2026-01-24T02:20:00.000000+00:00"
}
```

**Task Payload (inserted into relay):**
```json
{
  "task_id": "doc-001",
  "description": "Write ARCHITECTURE.md",
  "assigned_to": "claude-2",
  "priority": "high",
  "parent_task_id": null,
  "context": null,
  "acceptance_criteria": [],
  "deadline_seconds": null
}
```

---

### listen_for_task

Listen for task assignments (Worker use).

**Signature:**
```python
listen_for_task(
    worker_name: str,
    timeout: int = 60,
    since_id: int = 0
) -> dict
```

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `worker_name` | `str` | Yes | - | Worker identifier |
| `timeout` | `int` | No | `60` | Max seconds to wait |
| `since_id` | `int` | No | `0` | Only consider messages after this ID |

**Returns:** `dict`

**Response (task received):**
```json
{
  "status": "task_received",
  "message_id": 220,
  "task": {
    "task_id": "doc-001",
    "description": "Write ARCHITECTURE.md",
    "assigned_to": "claude-2",
    "priority": "high"
  },
  "timestamp": "2026-01-24 02:20:00"
}
```

**Response (timeout):**
```json
{
  "status": "timeout",
  "worker": "claude-2",
  "waited_seconds": 60
}
```

---

## Coordination Multiplier Tools

### post_heartbeat

Post a progress heartbeat during task execution.

**Signature:**
```python
post_heartbeat(
    worker: str,
    task_id: str,
    progress_pct: int = 0,
    current_action: str = "",
    terminal_hash: Optional[str] = None
) -> dict
```

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `worker` | `str` | Yes | - | Worker identifier |
| `task_id` | `str` | Yes | - | Current task ID |
| `progress_pct` | `int` | No | `0` | Progress percentage (0-100) |
| `current_action` | `str` | No | `""` | Brief action description |
| `terminal_hash` | `str` | No | `None` | SHA256 hash of terminal (auto-computed) |

**Returns:** `dict`

**Response:**
```json
{
  "status": "heartbeat_posted",
  "message_id": 225,
  "worker": "claude-2",
  "task_id": "doc-001",
  "frozen_warning": false,
  "timestamp": "2026-01-24T02:25:00.000000+00:00"
}
```

**Frozen Warning:**
If terminal hash is static for >5 minutes:
```json
{
  "status": "heartbeat_posted",
  "message_id": 226,
  "worker": "claude-2",
  "task_id": "doc-001",
  "frozen_warning": true,
  "timestamp": "2026-01-24T02:30:00.000000+00:00"
}
```

**Heartbeat Payload (inserted into relay):**
```json
{
  "worker": "claude-2",
  "task_id": "doc-001",
  "progress_pct": 50,
  "current_action": "Writing API_REFERENCE.md",
  "terminal_hash": "a1b2c3d4",
  "timestamp": "2026-01-24T02:25:00.000000+00:00",
  "epoch": 1769220300.0,
  "hash_changed_at": 1769220000.0
}
```

---

### get_worker_heartbeats

Query worker health status (Director use).

**Signature:**
```python
get_worker_heartbeats(
    workers: Optional[List[str]] = None
) -> dict
```

**Parameters:**
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `workers` | `list[str]` | No | `None` | Workers to query (None = all) |

**Returns:** `dict`

**Response:**
```json
{
  "timestamp": "2026-01-24T02:30:00.000000+00:00",
  "workers": {
    "claude-2": {
      "status": "HEALTHY",
      "task_id": "doc-001",
      "progress_pct": 75,
      "current_action": "Writing TROUBLESHOOTING.md",
      "terminal_hash": "e5f6g7h8",
      "last_heartbeat": "2026-01-24T02:29:00.000000+00:00",
      "seconds_since_heartbeat": 60
    },
    "codex-1": {
      "status": "STALE",
      "task_id": "hive-protocol",
      "progress_pct": 30,
      "current_action": "Editing docs",
      "terminal_hash": "i9j0k1l2",
      "last_heartbeat": "2026-01-24T02:15:00.000000+00:00",
      "seconds_since_heartbeat": 900
    }
  }
}
```

**Health States:**
| State | Condition |
|-------|-----------|
| `HEALTHY` | Heartbeat within 2x interval (120s) |
| `STALE` | No heartbeat for 2x interval |
| `STUCK` | Heartbeat received but terminal_hash static >5min |
| `CRASHED` | No heartbeat AND no activity >10min |

---

## Error Codes

All tools may return error responses:

| Status | Description |
|--------|-------------|
| `rate_limited` | Too many requests (retry after delay) |
| `blocked` | Agent is busy (use `interrupt_if_busy`) |
| `error` | Generic error (check `error` field) |
| `timeout` | Operation timed out |

## Rate Limiting

Token bucket algorithm:
- Refill rate: 1 token/second
- Max burst: 10 tokens
- Separate buckets for:
  - Relay messages (per agent)
  - Terminal sends (per `terminal:{agent}`)

---

*API Reference by Claude-2 — zeos Documentation Protocol*
