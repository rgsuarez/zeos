#!/usr/bin/env python3
"""
Hive Worker Bootstrap Script (v2 - Dynamic Polling)
"""

import argparse
import json
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Optional

# Add parent to path for imports when running as script
import os
src_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if src_path not in sys.path:
    sys.path.insert(0, src_path)

from overseer.agents.claude_worker import ClaudeWorker, CodexWorker
from overseer.hive import Task, TaskContext, TaskPriority, TaskResultStatus
from overseer.teams.definitions import Role, infer_role
from overseer.teams.sops import get_role_card


# Global flag for graceful shutdown
_shutdown_requested = False
DEFAULT_HEARTBEAT_INTERVAL = 60


def signal_handler(signum, frame):
    """Handle SIGINT/SIGTERM for graceful shutdown."""
    global _shutdown_requested
    print(f"\n[{time.strftime('%H:%M:%S')}] Shutdown signal received. Finishing current task...")
    _shutdown_requested = True


def extract_team(agent: str) -> Optional[str]:
    """Extract numeric team ID from agent name."""
    if '-' in agent:
        suffix = agent.split('-')[-1]
        if suffix.isdigit():
            return suffix
    return None


def post_message_direct(agent: str, content: str, msg_type: str, ref_id: Optional[int] = None):
    """Post message directly to relay DB (Schema Compliant)."""
    import sqlite3
    from pathlib import Path
    
    team_id = extract_team(agent)
    db_path = Path.home() / ".overseer" / "relay.db"
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
        (agent, content, msg_type, ref_id, team_id)
    )
    conn.commit()
    msg_id = cursor.lastrowid
    conn.close()
    return msg_id


def listen_for_task_direct(worker_name: str, timeout: int = 60, since_id: int = 0) -> Optional[dict]:
    """Listen for task assignments directly from DB (Schema Compliant)."""
    import sqlite3
    from pathlib import Path

    team_id = extract_team(worker_name)
    db_path = Path.home() / ".overseer" / "relay.db"
    start_time = time.time()

    # Dynamic Polling Logic happens in the caller loop, this function just tries once or waits?
    # Original logic waited 'timeout' seconds.
    # To support dynamic polling, we should just check ONCE and return, or wait short time?
    # But this function implements the wait loop.
    # Let's Modify: Check once. If no task, return None immediately (caller handles sleep).
    # OR: Keep this as "check batch".
    
    # Actually, the original 'timeout' was 60s. 
    # If we want dynamic polling, we should set timeout to small value (e.g. 2s) when active,
    # or just do a single DB query.
    
    # Strategy: This function will now perform ONE check. The loop is in run_worker_loop.
    
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    query = "SELECT id, agent, content, type, ref_id, timestamp FROM messages WHERE id > ?"
    params = [since_id]
    
    if team_id:
        query += " AND team_id = ?"
        params.append(team_id)
        
    query += " ORDER BY id"
    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.close()

    for row in rows:
        if row["type"] == "task_assign":
            try:
                payload = json.loads(row["content"])
                if payload.get("assigned_to") == worker_name:
                    return {
                        "message_id": row["id"],
                        "task": payload,
                        "timestamp": row["timestamp"]
                    }
            except json.JSONDecodeError:
                continue
        # We track max seen ID to advance even if not our task
        # But we return the first MATCHING task. 
        # The caller updates 'since_id' based on the returned message_id. 
        # If we return None, caller needs to know max_id seen? 
        # This simple logic relies on returning a task or nothing. 
        pass

    return None # Immediate return if no task found


def heartbeat_loop(
    worker_name: str,
    task_id: str,
    interval_sec: int,
    ref_id: Optional[int],
    expected_duration_sec: Optional[int],
    stop_event: threading.Event,
    role: Optional[str] = None
):
    beat = 0
    while not stop_event.is_set() and not _shutdown_requested:
        payload = {
            "worker": worker_name,
            "task_id": task_id,
            "status": "working",
            "beat": beat,
            "interval_sec": interval_sec,
            "expected_duration_sec": expected_duration_sec,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "progress": None,
            "action": "heartbeat",
            "terminal_hash": None,
            "team_id": extract_team(worker_name),
            "role": role
        }
        post_message_direct(worker_name, json.dumps(payload), "heartbeat", ref_id)
        beat += 1
        stop_event.wait(interval_sec)


class ProcessedTaskRegistry:
    def __init__(self, filepath: str):
        self.filepath = filepath
        self.tasks = {}
        self.load()

    def load(self):
        import os
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, 'r') as f:
                    self.tasks = json.load(f)
            except:
                self.tasks = {}
        # Prune old
        # (Simplified for v2)

    def save(self):
        with open(self.filepath, 'w') as f:
            json.dump(self.tasks, f)

    def has(self, task_id: str) -> bool:
        return task_id in self.tasks

    def add(self, task_id: str, status: str):
        self.tasks[task_id] = {"status": status, "timestamp": time.time()}
        self.save()


def get_max_message_id() -> int:
    import sqlite3
    from pathlib import Path
    db_path = Path.home() / ".overseer" / "relay.db"
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT MAX(id) FROM messages")
        result = cursor.fetchone()[0]
        conn.close()
        return result if result else 0
    except:
        return 0


def run_worker_loop(worker_name: str, safe_mode: bool = True, start_since_id: int = 0, role: Optional[str] = None):
    global _shutdown_requested

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    if "codex" in worker_name.lower():
        worker = CodexWorker(name=worker_name, safe_mode=safe_mode)
    else:
        worker = ClaudeWorker(name=worker_name, safe_mode=safe_mode)

    # Determine role (explicit or inferred)
    team_id = extract_team(worker_name)
    if role is None:
        inferred = infer_role(worker_name, team_id)
        role = inferred.value if inferred else None

    # Initialize Registry
    registry = ProcessedTaskRegistry(os.path.expanduser(f"~/.overseer/processed_tasks_{worker_name}.json"))

    print(f"[{time.strftime('%H:%M:%S')}] Hive Worker '{worker_name}' starting...")
    print(f"[{time.strftime('%H:%M:%S')}] Mode: v2-dynamic-poll")
    print(f"[{time.strftime('%H:%M:%S')}] Role: {role or 'unassigned'}")
    print(f"[{time.strftime('%H:%M:%S')}] Starting from message ID: {start_since_id}")

    # Display role card if role assigned
    if role:
        try:
            role_enum = Role(role)
            print(get_role_card(worker_name, role_enum))
        except ValueError:
            pass

    post_message_direct(
        worker_name,
        json.dumps({
            "status": "online",
            "worker": worker_name,
            "version": "v2",
            "team_id": team_id,
            "role": role
        }),
        "status"
    )

    since_id = start_since_id
    
    # Dynamic Polling State
    current_interval = 2.0
    MAX_INTERVAL = 30.0

    while not _shutdown_requested:
        # Check for task (non-blocking / fast check)
        result = listen_for_task_direct(worker_name, timeout=0, since_id=since_id)

        if result is None:
            # No task found, sleep and backoff
            if not _shutdown_requested:
                # Update since_id to max? No, listen_for_task_direct returns None.
                # We need to know the max ID to advance past other messages?
                # Actually, if we don't return anything, we can't advance since_id. 
                # We will keep scanning from same since_id. This is inefficient if queue grows.
                # But for now, it's fine.
                pass
            
            time.sleep(current_interval)
            current_interval = min(current_interval * 1.5, MAX_INTERVAL)
            continue

        # Task Found! Reset interval
        current_interval = 2.0
        
        since_id = result["message_id"]
        task_data = result["task"]
        task_id = task_data['task_id']

        # Idempotency Check
        if registry.has(task_id):
            print(f"[{time.strftime('%H:%M:%S')}] Skipping processed task: {task_id}")
            continue

        print(f"[{time.strftime('%H:%M:%S')}] Received task: {task_id[:8]}...")

        context = None
        if task_data.get("context"):
            ctx = task_data["context"]
            context = TaskContext(
                files=ctx.get("files", []),
                codebase=ctx.get("codebase"),
                notes=ctx.get("notes"),
                extra=ctx.get("extra", {})
            )

        task = Task(
            task_id=task_id,
            description=task_data["description"],
            assigned_to=task_data.get("assigned_to"),
            priority=TaskPriority(task_data.get("priority", "medium")),
            parent_task_id=task_data.get("parent_task_id"),
            context=context,
            acceptance_criteria=task_data.get("acceptance_criteria", []),
            deadline_seconds=task_data.get("deadline_seconds")
        )

        acceptance = worker.handle_assignment(task)
        post_message_direct(
            worker_name,
            acceptance.to_payload(),
            "task_accept",
            result["message_id"]
        )

        interval_sec = int(task_data.get("heartbeat_interval_sec") or DEFAULT_HEARTBEAT_INTERVAL)
        expected_duration_sec = task_data.get("expected_duration_sec")

        stop_event = threading.Event()
        heartbeat_thread = threading.Thread(
            target=heartbeat_loop,
            args=(worker_name, task.task_id, interval_sec, result["message_id"], expected_duration_sec, stop_event, role),
            daemon=True
        )
        heartbeat_thread.start()

        try:
            completion = worker.execute_real(task)
        finally:
            stop_event.set()
            heartbeat_thread.join(timeout=2)

        post_message_direct(
            worker_name,
            completion.to_payload(),
            "task_complete",
            result["message_id"]
        )
        
        registry.add(task_id, completion.status.value)

        status = "SUCCESS" if completion.status == TaskResultStatus.SUCCESS else "FAILED"
        print(f"[{time.strftime('%H:%M:%S')}] Task {status}")


def main():
    parser = argparse.ArgumentParser(description="Hive Worker Bootstrap (v2)")
    parser.add_argument("worker_name", help="Worker identifier (e.g., claude-3)")
    parser.add_argument("--unsafe", action="store_true", help="Disable safe mode")
    parser.add_argument("--since-id", type=int, default=None, help="Start from message ID")
    parser.add_argument("--headless", action="store_true", help="Run without tmux")
    parser.add_argument("--role", choices=["director", "executor", "validator", "peer"],
                        help="Explicit role assignment (default: auto-detect)")
    args = parser.parse_args()

    start_id = args.since_id if args.since_id is not None else get_max_message_id()
    run_worker_loop(
        args.worker_name,
        safe_mode=not args.unsafe,
        start_since_id=start_id,
        role=args.role
    )


if __name__ == "__main__":
    main()
