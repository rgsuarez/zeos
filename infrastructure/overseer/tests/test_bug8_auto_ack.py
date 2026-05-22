"""
Tests for BUG-8 fix: listen_for_task auto-ACK for dispatch_task_sync.

Verifies that when listen_for_task matches a TASK_ASSIGN, it automatically
posts a task_accept message with correct type and ref_id so that
dispatch_task_sync can detect delivery.
"""

import json
import sqlite3
import threading
import time

import pytest

from overseer.server import (
    init_db,
    dispatch_task,
    dispatch_task_sync,
    listen_for_task,
    DB_PATH,
)


class TestAutoAck:
    """Test that listen_for_task posts auto-ACK for dispatch_task_sync."""

    def setup_method(self):
        """Initialize fresh database."""
        init_db()

    def test_listen_for_task_posts_task_accept(self, tmp_path, monkeypatch):
        """After listen_for_task matches a task, a task_accept row exists with correct ref_id."""
        test_db = tmp_path / "test_bug8.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        init_db()

        # Dispatch a task to worker
        dispatch_result = dispatch_task(
            director="gemini-3",
            worker="claude-3",
            task_id="BUG8-001",
            description="Test auto-ACK"
        )
        assert dispatch_result["status"] == "dispatched"
        msg_id = dispatch_result["message_id"]

        # Worker picks up the task
        result = listen_for_task(worker_name="claude-3", timeout=2, since_id=0)
        assert result["status"] == "task_received"
        assert result["task"]["task_id"] == "BUG8-001"

        # Verify auto-ACK exists in DB
        conn = sqlite3.connect(test_db)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM messages WHERE type = 'task_accept' AND ref_id = ?",
            (msg_id,)
        )
        row = cursor.fetchone()
        conn.close()

        assert row is not None, "Auto-ACK task_accept message not found"
        assert row["agent"] == "claude-3"
        assert row["ref_id"] == msg_id
        assert row["team_id"] == "3"

        # Verify content payload
        payload = json.loads(row["content"])
        assert payload["worker"] == "claude-3"
        assert payload["task_id"] == "BUG8-001"
        assert payload["status"] == "accepted"

    def test_dispatch_task_sync_receives_ack(self, tmp_path, monkeypatch):
        """dispatch_task_sync returns 'accepted' when worker calls listen_for_task concurrently."""
        test_db = tmp_path / "test_bug8_sync.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        init_db()

        worker_result = {}

        def worker_listen():
            """Simulate worker listening for tasks."""
            r = listen_for_task(worker_name="claude-3", timeout=10, since_id=0)
            worker_result.update(r)

        # Start worker listener in background thread
        t = threading.Thread(target=worker_listen)
        t.start()

        # Small delay to let worker start polling
        time.sleep(0.5)

        # Director dispatches synchronously — should get ACK from auto-ACK
        sync_result = dispatch_task_sync(
            director="gemini-3",
            worker="claude-3",
            task_id="BUG8-002",
            description="Test sync ACK",
            ack_timeout=15
        )

        t.join(timeout=15)

        assert sync_result["status"] == "accepted", (
            f"Expected 'accepted' but got '{sync_result.get('status')}'. "
            f"Worker result: {worker_result}"
        )
        assert worker_result.get("status") == "task_received"

    def test_auto_ack_does_not_block_task_delivery(self, tmp_path, monkeypatch):
        """Even if auto-ACK somehow fails, listen_for_task still returns the task."""
        test_db = tmp_path / "test_bug8_resilient.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        init_db()

        # Dispatch a task
        dispatch_task(
            director="gemini-3",
            worker="claude-3",
            task_id="BUG8-003",
            description="Resilience test"
        )

        # Worker picks up — should always succeed
        result = listen_for_task(worker_name="claude-3", timeout=2, since_id=0)
        assert result["status"] == "task_received"
        assert result["task"]["task_id"] == "BUG8-003"
