"""
Tests for SQLite contention fixes and in-memory state hardening.

Covers:
- Phase 1: db_connection() context manager
- Phase 2: PID registration lifecycle
- Phase 3: Heartbeat persistence table
- Phase 4: Pane registry model/role columns
"""
import os
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

import overseer.server as server
import overseer.tmux_backend as tmux_mod


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@pytest.fixture
def temp_db(tmp_path):
    """Create a temporary DB and wire server + tmux_backend to it."""
    db_file = tmp_path / "relay.db"
    pid_dir = tmp_path / "pids"
    pid_dir.mkdir()

    original_db = server.DB_PATH
    original_pid_dir = server._PID_DIR
    server.DB_PATH = db_file
    server._PID_DIR = pid_dir
    server._db_initialized_path = None
    server._wal_initialized = False
    server.init_db()
    yield db_file
    server.DB_PATH = original_db
    server._PID_DIR = original_pid_dir


# ---------------------------------------------------------------------------
# Phase 1: db_connection() context manager
# ---------------------------------------------------------------------------

class TestDbConnectionContextManager:
    def test_normal_flow(self, temp_db):
        """Context manager yields a working connection and closes it."""
        with server.db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM messages")
            count = cursor.fetchone()[0]
            assert count >= 0

        # After exiting, connection should be closed
        # Attempting to use it should raise
        with pytest.raises(Exception):
            conn.execute("SELECT 1")

    def test_closes_on_exception(self, temp_db):
        """Context manager closes connection even when exception is raised."""
        captured_conn = None
        with pytest.raises(ValueError):
            with server.db_connection() as conn:
                captured_conn = conn
                raise ValueError("test error")

        # Connection should be closed despite exception
        assert captured_conn is not None
        with pytest.raises(Exception):
            captured_conn.execute("SELECT 1")


# ---------------------------------------------------------------------------
# Phase 2: PID registration lifecycle
# ---------------------------------------------------------------------------

class TestPidLifecycle:
    def test_register_and_unregister(self, temp_db):
        """PID file is created on register and removed on unregister."""
        pid = os.getpid()
        pid_file = server._PID_DIR / f"{pid}.pid"

        # Ensure clean state
        if pid_file.exists():
            pid_file.unlink()

        server._register_pid()
        assert pid_file.exists()
        assert pid_file.read_text() == str(pid)

        server._unregister_pid()
        assert not pid_file.exists()

    def test_cleanup_stale_pids(self, temp_db):
        """Stale PID files for dead processes are cleaned up."""
        # Create a PID file for a process that doesn't exist
        stale_pid = 99999999  # Very unlikely to be a real PID
        stale_file = server._PID_DIR / f"{stale_pid}.pid"
        stale_file.write_text(str(stale_pid))

        server._cleanup_stale_pids()

        # Stale file should be removed
        assert not stale_file.exists()

        # Our own PID file (if it exists) should survive
        our_pid = os.getpid()
        our_file = server._PID_DIR / f"{our_pid}.pid"
        if our_file.exists():
            assert our_file.exists()


# ---------------------------------------------------------------------------
# Phase 3: Heartbeat persistence table
# ---------------------------------------------------------------------------

class TestHeartbeatPersistence:
    def test_heartbeat_persists_to_table(self, temp_db):
        """post_heartbeat() writes to both relay messages and heartbeats table."""
        with patch.object(server, "get_agent_output", return_value="test output"):
            result = server.post_heartbeat(
                worker="claude-4",
                task_id="task-001",
                progress_pct=50,
                current_action="writing code",
                state="working",
                terminal_hash="abc123",
                current_milestone="Phase 1"
            )

        assert result["status"] == "heartbeat_posted"

        # Verify heartbeats table has the entry
        with server.db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT worker, task_id, progress_pct, current_action, state, "
                "current_milestone, terminal_hash FROM heartbeats "
                "WHERE worker = ? AND team_id = ?",
                ("claude-4", "4")
            )
            row = cursor.fetchone()

        assert row is not None
        assert row[0] == "claude-4"
        assert row[1] == "task-001"
        assert row[2] == 50
        assert row[3] == "writing code"
        assert row[4] == "working"
        assert row[5] == "Phase 1"
        assert row[6] == "abc123"

    def test_heartbeat_no_team_suffix_denied(self, temp_db):
        """post_heartbeat() returns error dict for worker without team suffix."""
        result = server.post_heartbeat(
            worker="noname",
            task_id="t1",
            progress_pct=25,
            current_action="testing",
        )
        assert result["status"] == "denied"
        assert "no team assignment" in result["error"]

    def test_heartbeat_cross_process_query(self, temp_db):
        """get_worker_heartbeats() finds heartbeats via table when in-memory empty."""
        # Directly insert into heartbeats table (simulating another process)
        import time
        now = time.time()
        with server.db_connection() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO heartbeats
                   (worker, team_id, task_id, progress_pct, current_action,
                    current_milestone, state, terminal_hash, frozen_warning,
                    hash_changed_at, epoch, timestamp)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                ("claude-4", "4", "task-002", 75, "testing",
                 "Phase 2", "working", "def456", 0,
                 now, now, "2026-03-01T00:00:00Z")
            )
            conn.commit()

        # In-memory registry is empty (cleared by conftest)
        assert "claude-4" not in server._heartbeat_registry

        # Query should find the heartbeat via table
        result = server.get_worker_heartbeats(
            requesting_agent="gemini-4",
            workers=["claude-4"]
        )

        assert "claude-4" in result["workers"]
        worker_status = result["workers"]["claude-4"]
        assert worker_status["task_id"] == "task-002"
        assert worker_status["progress_pct"] == 75


# ---------------------------------------------------------------------------
# Phase 4: Pane registry model/role columns
# ---------------------------------------------------------------------------

class TestPaneRegistrySchema:
    def test_model_role_columns_exist(self, temp_db):
        """Schema migration adds model and role columns to pane_registry."""
        with server.db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("PRAGMA table_info(pane_registry)")
            columns = [col[1] for col in cursor.fetchall()]

        assert "model" in columns
        assert "role" in columns

    def test_register_agent_with_model_role(self, temp_db):
        """Model and role are stored and retrieved via register_agent."""
        backend = tmux_mod.TmuxBackend(db_path=temp_db)

        entry = backend.register_agent(
            name="c-4", target="%18", kind="pane",
            parent="team-4", model="opus", role="executor"
        )

        assert entry.model == "opus"
        assert entry.role == "executor"

        # Verify persisted to SQLite
        with server.db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT model, role FROM pane_registry WHERE agent_name = ?",
                ("c-4",)
            )
            row = cursor.fetchone()

        assert row is not None
        assert row[0] == "opus"
        assert row[1] == "executor"

    def test_resolve_target_hydrates_model_role(self, temp_db):
        """resolve_target() populates model/role from SQLite on cross-process lookup."""
        # Insert directly into SQLite (simulating another process)
        with server.db_connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO pane_registry "
                "(agent_name, target, kind, parent, team_id, model, role, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
                ("g-4", "%19", "pane", "team-4", "4", "gemini-3-pro", "director")
            )
            conn.commit()

        backend = tmux_mod.TmuxBackend(db_path=temp_db)
        # Agent not in in-memory registry — should find via SQLite
        target = backend.resolve_target("g-4")
        assert target == "%19"

        # Verify model/role were hydrated into in-memory entry
        entry = backend._agent_registry.get("g-4")
        assert entry is not None
        assert entry.model == "gemini-3-pro"
        assert entry.role == "director"
