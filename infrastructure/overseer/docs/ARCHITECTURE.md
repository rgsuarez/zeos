# Overseer Architecture

> Multi-agent visibility — one pane of glass.

## Overview

Overseer is inter-agent relay infrastructure that enables AI agents to observe each other's terminal output and communicate via a shared message bus. It bridges isolated terminal sessions running Claude Code, Gemini CLI, Codex CLI, and other AI assistants.

## System Topology

```
              ┌─────────────────┐
              │    Operator    │
              │     (Human)     │
              └────────┬────────┘
                       │ high-level directives
                       ▼
              ┌─────────────────┐
              │    Director     │
              │   (Gemini-2)    │
              └────────┬────────┘
                       │ task decomposition + coordination
          ┌────────────┼────────────┐
          ▼            ▼            ▼
     ┌─────────┐  ┌─────────┐  ┌─────────┐
     │Claude-1 │  │Claude-2 │  │ Codex-1 │
     │ Worker  │  │ Worker  │  │ Worker  │
     └────┬────┘  └────┬────┘  └────┬────┘
          │            │            │
          └────────────┴────────────┘
                       │
          ┌────────────▼────────────┐
          │     Overseer MCP        │
          │  ┌─────────────────┐    │
          │  │   server.py     │    │  ← FastMCP (11 tools)
          │  │   detector.py   │    │  ← State detection
          │  │   hive.py       │    │  ← Protocol dataclasses
          │  └─────────────────┘    │
          └────────────┬────────────┘
                       │
          ┌────────────▼────────────┐
          │  ~/.overseer/relay.db   │  ← SQLite message relay
          └─────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │      tmux sessions      │
          │  claude-1, claude-2,    │
          │  gemini-1, codex-1...   │
          └─────────────────────────┘
```

## Core Components

### 1. FastMCP Server (`server.py`)

The heart of Overseer. A Python MCP server built on FastMCP that exposes 11 tools to connected agents.

**Key Responsibilities:**
- Terminal capture via `tmux capture-pane`
- Message relay via SQLite
- State detection via regex heuristics
- Team Protocol orchestration
- Coordination Multiplier heartbeat tracking

**Initialization:**
```python
from mcp.server.fastmcp import FastMCP
mcp = FastMCP("overseer")
```

**Singletons:**
| Object | Purpose |
|--------|---------|
| `_rate_limiter` | Token bucket (1 msg/sec, burst 10) |
| `_tool_cache` | 30s TTL cache for terminal captures |
| `_heartbeat_registry` | Worker heartbeat tracking |
| `_detector` | StateDetector instance |

### 2. SQLite Relay (`~/.overseer/relay.db`)

Zero-infrastructure message bus. Single file, portable, easy to inspect.

**Schema:**
```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,          -- sender identifier
    content TEXT NOT NULL,        -- message payload (often JSON)
    type TEXT DEFAULT 'raw',      -- message type enum
    ref_id INTEGER DEFAULT NULL,  -- threading (parent message ID)
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ref_id) REFERENCES messages(id)
);
```

**Message Types:**
| Type | Purpose | Direction |
|------|---------|-----------|
| `raw` | Untyped legacy messages | Any |
| `status` | State updates | Any |
| `query` | Information requests | Any |
| `ack` | Acknowledgments | Any |
| `task_assign` | Hive: Director assigns task | Director → Worker |
| `task_accept` | Hive: Worker accepts | Worker → Director |
| `task_complete` | Hive: Worker reports done | Worker → Director |
| `task_blocked` | Hive: Worker blocked | Worker → Director |
| `heartbeat` | Coordination Multiplier: Progress | Worker → Director |

### 3. tmux Transport Layer

Overseer uses tmux for terminal access. This requires zero modifications to agent runtimes.

**Capture (read):**
```bash
tmux capture-pane -t <session> -p -S -<lines>
```

**Send (write):**
```bash
tmux send-keys -t <session> "<message>"
tmux send-keys -t <session> "Enter"  # explicit carriage return
```

**List sessions:**
```bash
tmux list-sessions -F "#{session_name}"
```

### 4. State Detector (`detector.py`)

Analyzes terminal output to determine agent state using regex heuristics.

**States (priority order):**
| State | Description |
|-------|-------------|
| `error` | Exception or failure detected |
| `waiting` | Blocked on user confirmation |
| `working` | Executing tools or thinking |
| `idle` | Ready for input |
| `stuck` | Working but no output change >5min |
| `stale` | No output change >10min |
| `unknown` | No matching heuristics |

**Agent Heuristics:**
```python
heuristics = {
    "claude": {
        "idle": [r"\$ $", r"^> $", r"claude>"],
        "working": [r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]", r"Reading", r"Thinking"],
        "waiting": [r"\[Y/n\]", r"Press enter", r"Allow"],
        "error": [r"Error:", r"failed", r"FAILED"]
    },
    "gemini": { ... },
    "codex": { ... }
}
```

### 5. Team Protocol (`hive.py`)

Dataclasses for Director/Worker orchestration.

**Core Classes:**
| Class | Purpose |
|-------|---------|
| `Task` | Unit of work with metadata |
| `TaskAcceptance` | Worker accepts assignment |
| `TaskCompletion` | Worker reports results |
| `TaskBlocker` | Worker reports dependency |
| `Heartbeat` | Worker progress signal |
| `Worker` | Abstract base for workers |
| `Director` | Abstract base for directors |

**Task Lifecycle:**
```
PENDING → ASSIGNED → ACCEPTED → IN_PROGRESS → COMPLETED
                                     ↓
                                  BLOCKED
                                     ↓
                                  FAILED
```

## Data Flow

### Terminal Observation
```
Agent A requests output from Agent B:
1. Agent A → MCP: get_agent_output("claude-2", 200)
2. MCP → tmux: capture-pane -t claude-2 -p -S -200
3. tmux → MCP: raw terminal output
4. MCP: strip ANSI codes, cache result (30s TTL)
5. MCP → Agent A: clean text
```

### Message Relay
```
Agent A posts message:
1. Agent A → MCP: post_message("claude-2", content, "status")
2. MCP: rate limit check (token bucket)
3. MCP → SQLite: INSERT INTO messages ...
4. MCP → Agent A: {id, timestamp, status: "posted"}

Agent B retrieves:
1. Agent B → MCP: get_messages(since_id=100)
2. MCP → SQLite: SELECT ... WHERE id > 100
3. MCP → Agent B: [messages]
```

### Long-Polling
```
Agent subscribes for new messages:
1. Agent → MCP: subscribe(since_id=200, timeout=30)
2. MCP: check immediately for messages > 200
3. If found: return immediately
4. If not: sleep 30s, check again
5. Repeat until timeout or messages found
```

### Hive Task Execution
```
Director assigns task to Worker:
1. Director → MCP: dispatch_task(director, worker, task_id, description)
2. MCP → SQLite: INSERT (type="task_assign")
3. Worker → MCP: listen_for_task(worker_name)
4. MCP → Worker: {task_id, description, ...}
5. Worker → MCP: post_message(worker, acceptance, "task_accept")
6. Worker executes, posts heartbeats every 60s
7. Worker → MCP: post_message(worker, completion, "task_complete")
```

## Performance Optimizations

### Token Conservation

| Mechanism | Implementation |
|-----------|----------------|
| Tool cache | 30s TTL for `get_agent_output` and `detect_state` |
| Polling interval | 30s between subscribe checks |
| Rate limiting | 1 msg/sec sustained, 10 burst |
| Filtered subscribe | `filter_type` and `filter_agent` parameters |

### Thresholds

| Constant | Value | Purpose |
|----------|-------|---------|
| `CACHE_TTL` | 30s | Terminal capture cache |
| `HEARTBEAT_INTERVAL_SEC` | 60s | Worker heartbeat frequency |
| `STUCK_THRESHOLD_SEC` | 300s (5min) | Static WORKING detection |
| `CRASHED_THRESHOLD_SEC` | 600s (10min) | No heartbeat + no activity |

## Security Model

### Rate Limiting
Token bucket algorithm prevents message flooding:
- 1 token/second refill rate
- 10 token max burst
- Separate buckets for relay messages and terminal sends

### State Verification
Mandatory busy-check before terminal sends:
```python
pre_state = detect_state(agent)
if agent_state == AgentState.WORKING:
    if interrupt_if_busy:
        # Send C-c to interrupt
    else:
        return {"status": "blocked", ...}
```

### Verification
Post-send verification captures terminal to confirm delivery.

## File Structure

```
overseer/
├── src/overseer/
│   ├── server.py        # FastMCP server (11 tools)
│   ├── detector.py      # StateDetector class
│   ├── hive.py          # Protocol dataclasses
│   └── agents/          # Worker implementations
│       ├── bootstrap_worker.py
│       ├── claude_worker.py
│       └── gemini_director.py
├── tests/
│   ├── test_server.py
│   └── test_subscribe.py
├── docs/
│   ├── ARCHITECTURE.md  # (this file)
│   ├── API_REFERENCE.md
│   ├── HIVE_PROTOCOL.md
│   └── MASTER_ROADMAP.md
└── .mcp.json            # MCP server configuration
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `mcp` | Model Context Protocol SDK |
| `fastmcp` | High-level MCP server framework |
| `sqlite3` | Message relay (stdlib) |
| `subprocess` | tmux interaction (stdlib) |

## Future Architecture

Planned enhancements:
- **Dynamic Scaling**: Director spawns new agents on demand
- **Consensus/Voting**: Multi-agent deliberation mechanism
- **Session Persistence**: Long-running states survive restarts
- **WebSocket Transport**: Real-time push (replace polling)

---

*Architecture documented by Claude-2 — zeos Documentation Protocol*
