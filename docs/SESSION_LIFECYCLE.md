# zeos Session Lifecycle

> **Status**: Active
> **Version**: 1.0.0
> **Created**: 2026-01-09
> **Phase**: 2.2 Operations Hardening

---

## Overview

The zeos Session Lifecycle system ensures that sessions always terminate cleanly with accurate status, even after crashes. It provides automatic crash recovery, stale session detection, and heartbeat monitoring.

**Core Principle:** Sessions never end in unknown states. The system always knows what happened.

---

## Session State Machine

```
INITIALIZING ──┐
               │
               ├──► ACTIVE ◄──── RECOVERED
               │       │
               │       ├──► PAUSED
               │       │     │
               │       │     └──► ACTIVE
               │       │
               │       ├──► COMPLETING ──► COMPLETE
               │       │
               └───────┴──► CRASHED ──► RECOVERED
```

### State Descriptions

| State | Meaning | Terminal |
|-------|---------|----------|
| `INITIALIZING` | Session created, not yet active | No |
| `ACTIVE` | Session running, agent working | No |
| `PAUSED` | Session temporarily suspended | No |
| `COMPLETING` | Session ending, writing journal | No |
| `COMPLETE` | Session ended successfully | Yes |
| `CRASHED` | Session terminated unexpectedly | Yes (recoverable) |
| `RECOVERED` | Session restored from crash | No |

### Valid Transitions

```python
INITIALIZING → ACTIVE          # First command executed
ACTIVE → PAUSED                # User pauses session
PAUSED → ACTIVE                # User resumes session
ACTIVE → COMPLETING            # /end command or completion signal
COMPLETING → COMPLETE          # Journal written successfully
ACTIVE → CRASHED               # Heartbeat timeout detected
CRASHED → RECOVERED            # Crash recovery executed
RECOVERED → ACTIVE             # Agent re-engages
```

### Invalid Transitions

Attempting invalid transitions raises `SessionTransitionError`:

```python
# Invalid examples:
INITIALIZING → COMPLETE   # Can't complete without activating
COMPLETE → ACTIVE         # Can't restart completed session
CRASHED → COMPLETING      # Can't complete crashed session (must recover first)
```

---

## Heartbeat System

### Purpose

Detect when sessions become unresponsive (crashes, network loss, agent hangs).

### Mechanism

```python
from zeos.session.heartbeat import HeartbeatManager

# Create heartbeat manager
heartbeat = HeartbeatManager(
    session_id="session-001",
    interval=30,        # Pulse every 30 seconds
    timeout=300,        # Crash if no pulse for 5 minutes
    on_timeout=handle_crash
)

# Start monitoring
heartbeat.start()

# During session, pulse regularly
heartbeat.pulse()  # Called after each operation

# Stop at session end
heartbeat.stop()
```

### Configuration

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `interval` | 30s | How often heartbeat emits |
| `timeout` | 300s (5 min) | Max time without pulse before crash |
| `on_timeout` | callback | Function called when timeout detected |

### Thread Safety

Heartbeats run in background threads with lock protection:
- `pulse()` is thread-safe
- Safe to call from any operation
- Auto-stops on timeout

---

## Stale Session Detection

### Purpose

Find sessions that crashed but weren't detected by heartbeat (e.g., machine power loss).

### Mechanism

```python
from zeos.session.stale_detector import StaleSessionDetector

# Create detector
detector = StaleSessionDetector(
    session_storage=storage,
    stale_threshold=300,     # 5 minutes
    scan_interval=60         # Check every minute
)

# Start background scanning
detector.start()

# Detector automatically marks stale sessions as CRASHED
```

### Stale Criteria

A session is stale if:
1. Status is `ACTIVE` or `PAUSED`
2. Last heartbeat > `stale_threshold` seconds ago
3. Not explicitly marked as complete

### Actions

When stale session detected:
1. Session status → `CRASHED`
2. Event emitted: `session.stale`
3. Recovery handler notified (if registered)

---

## Crash Recovery

### Purpose

Restore session state from checkpoint to resume work after crash.

### Checkpoint Creation

```python
from zeos.session.recovery import CrashRecoveryHandler

recovery = CrashRecoveryHandler(checkpoint_dir=Path(".zeos/checkpoints"))

# Create checkpoint
checkpoint_path = recovery.create_checkpoint(session)
```

**Checkpoint Contents:**
- Session ID, instance ID, project
- Current task and completed tasks
- Context variables (agent state)
- Timestamp and integrity hash (SHA256)

**When to Checkpoint:**
- After each `/snap` command
- Every N minutes (configurable)
- After significant operations (file writes, task completion)

### Recovery Process

```python
# Detect crashed session
crashed_sessions = storage.find_by_status(SessionState.CRASHED)

# Recover from checkpoint
for session_id in crashed_sessions:
    checkpoint = recovery.find_latest_checkpoint(session_id)
    recovered_session = recovery.recover(checkpoint)

    if recovered_session:
        # Resume work from checkpoint
        print(f"Recovered: {recovered_session.session_id}")
        print(f"Last task: {recovered_session.context_vars['current_task']}")
```

**State Transitions:**
```
CRASHED → RECOVERED → ACTIVE
```

### Integrity Validation

Checkpoints include SHA256 hash:
```python
# Recovery validates integrity
recovered = recovery.recover(checkpoint_path)

if recovered is None:
    # Checkpoint corrupt or tampered
    log.error("Checkpoint integrity check failed")
```

---

## Session Manager API

### Creating Sessions

```python
from zeos.session.manager import SessionManager

manager = SessionManager()

# Create new session
session_id = manager.create_session(
    instance_id="claude-opus-a3f2",
    project_id="zeos-dev"
)

# Start session
session = manager.start_session(session_id)
print(f"Session {session_id} is now {session.status}")
```

### Managing Sessions

```python
# Pause session
manager.pause_session(session_id)

# Resume session
manager.resume_session(session_id)

# Complete session (requires terminal status)
manager.complete_session(session_id)

# Mark as crashed
manager.crash_session(session_id)
```

### Event Observers

```python
def on_session_ended(session):
    print(f"Session {session.session_id} ended: {session.status}")

# Register observer
manager.add_observer("session.ended", on_session_ended)

# Events emitted:
# - session.started
# - session.paused
# - session.resumed
# - session.ended
# - session.crashed
```

---

## Common Workflows

### Normal Session Lifecycle

```python
# 1. Create and start
session_id = manager.create_session("instance-123", "my-project")
session = manager.start_session(session_id)

# 2. Work (with heartbeats)
heartbeat = HeartbeatManager(session_id)
heartbeat.start()

for task in tasks:
    execute(task)
    heartbeat.pulse()

# 3. Complete
heartbeat.stop()
manager.complete_session(session_id)
```

### Crash Recovery Workflow

```python
# 1. Detect crash (automatic via stale detector)
detector = StaleSessionDetector(storage)
detector.start()

# 2. On stale detection, recover
def handle_stale(session_id):
    checkpoint = recovery.find_latest_checkpoint(session_id)
    recovered = recovery.recover(checkpoint)

    if recovered:
        # Resume from checkpoint
        resume_work(recovered)

detector.on_stale(handle_stale)
```

### Manual Crash Recovery

```python
# Find crashed sessions
crashed = storage.find_by_status(SessionState.CRASHED)

for session_id in crashed:
    # Load checkpoint
    checkpoint_path = recovery.find_latest_checkpoint(session_id)

    # Recover
    session = recovery.recover(checkpoint_path)

    # Show recovery info
    print(f"Recovered session: {session.session_id}")
    print(f"Last heartbeat: {session.last_heartbeat}")
    print(f"Context: {session.context_vars}")

    # Ask user to resume or abandon
    if confirm("Resume this session?"):
        manager.resume_session(session_id)
```

---

## Testing

### Unit Tests

```bash
# Session state machine
pytest tests/test_session_models.py -v

# Heartbeat system
pytest tests/test_heartbeat.py -v

# Stale detection
pytest tests/test_stale_detector.py -v

# Crash recovery
pytest tests/test_crash_recovery.py -v
```

### Integration Tests

```bash
# Full lifecycle
pytest tests/integration/test_session_lifecycle.py -v
```

---

## Configuration

### Session Timeouts

```yaml
# .zeos/config.yaml
session:
  heartbeat_interval: 30      # seconds
  heartbeat_timeout: 300      # 5 minutes
  stale_threshold: 300        # 5 minutes
  checkpoint_interval: 600    # 10 minutes
```

### Checkpoint Storage

```yaml
session:
  checkpoint_dir: ".zeos/checkpoints"
  checkpoint_retention: 7     # days
  max_checkpoints_per_session: 10
```

---

## Error Handling

### SessionTransitionError

Raised when invalid state transition attempted:

```python
try:
    manager.complete_session(session_id)
except SessionTransitionError as e:
    print(f"Invalid transition: {e}")
    # Current state not terminal
```

### SessionEndError

Raised when trying to end session without terminal status:

```python
try:
    manager.end_session(session_id, status=SessionState.ACTIVE)
except SessionEndError:
    # Must use terminal status (COMPLETE or CRASHED)
    manager.end_session(session_id, status=SessionState.COMPLETE)
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-09 | Initial documentation (Phase 2.2) |

---

*Session Lifecycle v1.0.0 — "Sessions never end in mystery"*
