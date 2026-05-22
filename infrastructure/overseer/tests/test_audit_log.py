"""
Unit tests for relay audit log (P1-4.4).

Tests:
- audit_log table creation
- log_action helper function
- get_audit_log MCP tool
"""

import pytest
import sqlite3
import json

from overseer.server import (
    init_db,
    log_action,
    get_audit_log,
    DB_PATH,
)


class TestLogAction:
    """Test log_action helper function."""

    def setup_method(self):
        """Reset database."""
        init_db()
        conn = sqlite3.connect(DB_PATH)
        conn.execute("DELETE FROM audit_log")
        conn.commit()
        conn.close()

    def test_log_basic_action(self):
        """Test logging a basic action."""
        entry_id = log_action(
            agent="claude-3",
            action="dispatch_task"
        )

        assert entry_id > 0

        # Verify in database
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM audit_log WHERE id = ?", (entry_id,))
        row = cursor.fetchone()
        conn.close()

        assert row is not None

    def test_log_with_resource(self):
        """Test logging with resource identifier."""
        entry_id = log_action(
            agent="claude-3",
            action="dispatch_task",
            resource="TASK-001"
        )

        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM audit_log WHERE id = ?", (entry_id,))
        row = cursor.fetchone()
        conn.close()

        assert row["resource"] == "TASK-001"

    def test_log_with_outcome(self):
        """Test logging different outcomes."""
        # Success
        log_action(agent="claude-3", action="read", outcome="success")

        # Denied
        log_action(agent="claude-3", action="cross_team_access", outcome="denied")

        # Error
        log_action(agent="claude-3", action="send_message", outcome="error")

        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM audit_log")
        count = cursor.fetchone()[0]
        conn.close()

        assert count == 3

    def test_log_with_metadata(self):
        """Test logging with metadata dict."""
        entry_id = log_action(
            agent="claude-3",
            action="dispatch_task",
            resource="TASK-001",
            metadata={"worker": "codex-3", "priority": "high"}
        )

        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM audit_log WHERE id = ?", (entry_id,))
        row = cursor.fetchone()
        conn.close()

        metadata = json.loads(row["metadata"])
        assert metadata["worker"] == "codex-3"
        assert metadata["priority"] == "high"

    def test_log_extracts_team(self):
        """Test that team_id is extracted from agent name."""
        log_action(agent="claude-3", action="test")
        log_action(agent="gemini-4", action="test")

        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT agent, team_id FROM audit_log ORDER BY id")
        rows = cursor.fetchall()
        conn.close()

        assert rows[0]["team_id"] == "3"
        assert rows[1]["team_id"] == "4"


class TestGetAuditLog:
    """Test get_audit_log MCP tool."""

    def setup_method(self):
        """Reset and seed database."""
        init_db()
        conn = sqlite3.connect(DB_PATH)
        conn.execute("DELETE FROM audit_log")
        conn.commit()
        conn.close()

        # Seed some entries
        log_action(agent="claude-3", action="dispatch_task", resource="T1")
        log_action(agent="claude-3", action="post_message", resource="M1")
        log_action(agent="gemini-3", action="get_messages")
        log_action(agent="claude-4", action="dispatch_task", resource="T2")

    def test_get_log_team_filtered(self):
        """Test that audit log is team-filtered."""
        # Team 3 agent
        entries = get_audit_log(requesting_agent="claude-3")

        # Should only see team 3 entries
        assert len(entries) == 3
        for entry in entries:
            assert entry["team_id"] == "3"

    def test_get_log_action_filter(self):
        """Test filtering by action type."""
        entries = get_audit_log(
            requesting_agent="claude-3",
            action_filter="dispatch_task"
        )

        assert len(entries) == 1
        assert entries[0]["action"] == "dispatch_task"

    def test_get_log_limit(self):
        """Test limit parameter."""
        # Add many entries
        for i in range(10):
            log_action(agent="claude-3", action=f"action_{i}")

        entries = get_audit_log(requesting_agent="claude-3", limit=5)
        assert len(entries) == 5

    def test_get_log_denied_no_team(self):
        """Test denial for agent without team."""
        result = get_audit_log(requesting_agent="legacy-agent")
        assert result.get("status") == "denied"

    def test_get_log_empty(self):
        """Test empty result for team with no entries."""
        entries = get_audit_log(requesting_agent="claude-9")  # Team 9 has no entries
        assert entries == []


class TestAuditIntegration:
    """Integration tests for audit logging."""

    def setup_method(self):
        init_db()
        conn = sqlite3.connect(DB_PATH)
        conn.execute("DELETE FROM audit_log")
        conn.commit()
        conn.close()

    def test_full_audit_trail(self):
        """Test complete audit trail for a task lifecycle."""
        # Log task dispatch
        log_action(
            agent="gemini-3",
            action="dispatch_task",
            resource="AUDIT-001",
            outcome="success",
            metadata={"worker": "claude-3"}
        )

        # Log task accept
        log_action(
            agent="claude-3",
            action="accept_task",
            resource="AUDIT-001",
            outcome="success"
        )

        # Log task complete
        log_action(
            agent="claude-3",
            action="complete_task",
            resource="AUDIT-001",
            outcome="success",
            metadata={"duration_sec": 120}
        )

        # Query audit trail
        entries = get_audit_log(requesting_agent="gemini-3")

        # Should have 3 entries (all team 3)
        assert len(entries) == 3

        # Check chronological order (most recent first due to ORDER BY DESC)
        actions = [e["action"] for e in entries]
        assert actions == ["complete_task", "accept_task", "dispatch_task"]
