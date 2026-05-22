"""
Tests for external operator dispatch via target_team parameter.

Verifies that an unaffiliated agent (e.g. "claude" with no team suffix)
can dispatch tasks to a specific team's relay using target_team, while
affiliated agents are rejected to prevent cross-team escalation.
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


class TestTargetTeamDispatch:
    """External operator dispatch with target_team."""

    def test_unaffiliated_dispatch_succeeds(self, tmp_path, monkeypatch):
        """Unaffiliated agent dispatches to team 4 via target_team."""
        test_db = tmp_path / "test_tt_ok.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        init_db()

        result = dispatch_task(
            director="claude",
            worker="d-4",
            task_id="TT-001",
            description="External operator order",
            target_team="4",
        )

        assert result["status"] == "dispatched"
        assert result["team_id"] == "4"
        assert result["assigned_to"] == "d-4"
        assert result["task_id"] == "TT-001"

        # Verify DB row has correct team_id
        conn = sqlite3.connect(test_db)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM messages WHERE type = 'task_assign' AND id = ?",
            (result["message_id"],),
        )
        row = cursor.fetchone()
        conn.close()

        assert row is not None
        assert row["team_id"] == "4"
        payload = json.loads(row["content"])
        assert payload["assigned_to"] == "d-4"
        assert payload["team_id"] == "4"

    def test_unaffiliated_dispatch_no_target_team_fails(self, tmp_path, monkeypatch):
        """Unaffiliated agent without target_team gets 'no team resolved' error."""
        test_db = tmp_path / "test_tt_no_team.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        init_db()

        result = dispatch_task(
            director="claude",
            worker="d-4",
            task_id="TT-002",
            description="Should fail - no team",
        )

        assert result["status"] == "error"
        assert "No team resolved" in result["error"]

    def test_affiliated_agent_rejected(self, tmp_path, monkeypatch):
        """Agent with team suffix cannot use target_team (prevents cross-team escalation)."""
        test_db = tmp_path / "test_tt_affiliated.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        init_db()

        result = dispatch_task(
            director="gemini-3",
            worker="d-4",
            task_id="TT-003",
            description="Cross-team attempt",
            target_team="4",
        )

        assert result["status"] == "error"
        assert "already on team" in result["error"]
        assert "'3'" in result["error"]

    def test_non_numeric_target_team_rejected(self, tmp_path, monkeypatch):
        """Non-numeric target_team is rejected."""
        test_db = tmp_path / "test_tt_nonnumeric.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        init_db()

        result = dispatch_task(
            director="claude",
            worker="d-4",
            task_id="TT-004",
            description="Bad team ID",
            target_team="abc",
        )

        assert result["status"] == "error"
        assert "must be numeric" in result["error"]

    def test_worker_team_mismatch_rejected(self, tmp_path, monkeypatch):
        """Worker already on team 3 cannot be dispatched to target_team 4."""
        test_db = tmp_path / "test_tt_mismatch.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        init_db()

        result = dispatch_task(
            director="claude",
            worker="d-3",
            task_id="TT-005",
            description="Worker on wrong team",
            target_team="4",
        )

        assert result["status"] == "error"
        assert "team 3" in result["error"]
        assert "target_team 4" in result["error"]

    def test_worker_receives_external_dispatch(self, tmp_path, monkeypatch):
        """Worker's listen_for_task picks up task dispatched via target_team."""
        test_db = tmp_path / "test_tt_e2e.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        init_db()

        # Operator dispatches to team 4
        dispatch_result = dispatch_task(
            director="claude",
            worker="d-4",
            task_id="TT-006",
            description="E2E external dispatch",
            target_team="4",
        )
        assert dispatch_result["status"] == "dispatched"

        # Worker picks it up
        result = listen_for_task(worker_name="d-4", timeout=5, since_id=0)
        assert result["status"] == "task_received"
        assert result["task"]["task_id"] == "TT-006"
        assert result["task"]["description"] == "E2E external dispatch"

    def test_sync_dispatch_gets_ack(self, tmp_path, monkeypatch):
        """dispatch_task_sync with target_team receives ACK from worker."""
        test_db = tmp_path / "test_tt_sync.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        init_db()

        worker_result = {}

        def worker_listen():
            r = listen_for_task(worker_name="d-4", timeout=15, since_id=0)
            worker_result.update(r)

        # Start worker listener in background
        t = threading.Thread(target=worker_listen)
        t.start()
        time.sleep(0.5)

        # Operator dispatches synchronously with target_team
        sync_result = dispatch_task_sync(
            director="claude",
            worker="d-4",
            task_id="TT-007",
            description="Sync external dispatch",
            ack_timeout=15,
            target_team="4",
        )

        t.join(timeout=15)

        assert sync_result["status"] == "accepted", (
            f"Expected 'accepted' but got '{sync_result.get('status')}'. "
            f"Worker result: {worker_result}"
        )
        assert sync_result["team_id"] == "4"
        assert worker_result.get("status") == "task_received"
