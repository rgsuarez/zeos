"""
Unit tests for progress tracking (P1-1.4).

Tests:
- ProgressCheckpoint dataclass
- post_heartbeat with progress fields
- get_task_progress MCP tool
"""

import pytest
import sqlite3
from unittest.mock import patch

from overseer.hive import ProgressCheckpoint
from overseer.server import (
    init_db,
    post_heartbeat,
    get_task_progress,
    _heartbeat_registry,
    DB_PATH,
)


class TestProgressCheckpoint:
    """Test ProgressCheckpoint dataclass."""

    def test_create_checkpoint(self):
        """Test creating a progress checkpoint."""
        checkpoint = ProgressCheckpoint(
            task_id="T1",
            worker="claude-3",
            milestone="implementation",
            progress_pct=50,
            eta_seconds=120
        )

        assert checkpoint.task_id == "T1"
        assert checkpoint.worker == "claude-3"
        assert checkpoint.milestone == "implementation"
        assert checkpoint.progress_pct == 50
        assert checkpoint.eta_seconds == 120
        assert checkpoint.artifacts == []
        assert checkpoint.timestamp is not None

    def test_checkpoint_to_payload(self):
        """Test serialization to JSON."""
        checkpoint = ProgressCheckpoint(
            task_id="T2",
            worker="codex-3",
            milestone="testing",
            progress_pct=75,
            artifacts=["test_output.log"]
        )

        payload = checkpoint.to_payload()
        assert "T2" in payload
        assert "testing" in payload
        assert "75" in payload

    def test_checkpoint_from_payload(self):
        """Test deserialization from JSON."""
        original = ProgressCheckpoint(
            task_id="T3",
            worker="gemini-3",
            milestone="review",
            progress_pct=90
        )

        payload = original.to_payload()
        restored = ProgressCheckpoint.from_payload(payload)

        assert restored.task_id == original.task_id
        assert restored.worker == original.worker
        assert restored.milestone == original.milestone
        assert restored.progress_pct == original.progress_pct


class TestHeartbeatProgress:
    """Test post_heartbeat with progress fields."""

    def setup_method(self):
        """Reset heartbeat registry."""
        _heartbeat_registry.clear()
        init_db()

    def test_heartbeat_with_progress(self):
        """Test post_heartbeat stores progress correctly."""
        result = post_heartbeat(
            worker="claude-3",
            task_id="TASK-001",
            progress_pct=25,
            current_action="parsing files",
            current_milestone="analysis"
        )

        assert result["status"] == "heartbeat_posted"
        assert result["task_id"] == "TASK-001"

        # Verify registry
        heartbeat = _heartbeat_registry.get("claude-3")
        assert heartbeat is not None
        assert heartbeat["progress_pct"] == 25
        assert heartbeat["current_action"] == "parsing files"
        assert heartbeat["current_milestone"] == "analysis"

    def test_heartbeat_progress_updates(self):
        """Test that progress updates work correctly."""
        # First heartbeat
        post_heartbeat(
            worker="claude-3",
            task_id="TASK-002",
            progress_pct=10,
            current_milestone="start"
        )

        # Second heartbeat with updated progress
        post_heartbeat(
            worker="claude-3",
            task_id="TASK-002",
            progress_pct=50,
            current_milestone="midpoint"
        )

        # Third heartbeat
        post_heartbeat(
            worker="claude-3",
            task_id="TASK-002",
            progress_pct=100,
            current_milestone="complete"
        )

        # Verify final state
        heartbeat = _heartbeat_registry.get("claude-3")
        assert heartbeat["progress_pct"] == 100
        assert heartbeat["current_milestone"] == "complete"


class TestGetProgress:
    """Test get_task_progress MCP tool."""

    def setup_method(self):
        """Reset heartbeat registry."""
        _heartbeat_registry.clear()
        init_db()

    def test_get_progress_found(self):
        """Test getting progress for active task."""
        # Setup: post a heartbeat
        post_heartbeat(
            worker="claude-3",
            task_id="PROG-001",
            progress_pct=60,
            current_action="writing tests",
            current_milestone="testing phase"
        )

        # Query progress
        result = get_task_progress(
            requesting_agent="gemini-3",
            task_id="PROG-001"
        )

        assert result["task_id"] == "PROG-001"
        assert result["worker"] == "claude-3"
        assert result["progress_pct"] == 60
        assert result["milestone"] == "testing phase"
        assert result["current_action"] == "writing tests"

    def test_get_progress_not_found(self):
        """Test getting progress for unknown task."""
        result = get_task_progress(
            requesting_agent="gemini-3",
            task_id="NONEXISTENT-TASK"
        )

        # Should return empty dict
        assert result == {}

    def test_get_progress_team_isolation(self):
        """Test that team isolation is enforced."""
        # Post heartbeat from team 3
        post_heartbeat(
            worker="claude-3",
            task_id="ISOLATED-001",
            progress_pct=50
        )

        # Query from team 4 - should not find it due to team isolation
        result = get_task_progress(
            requesting_agent="gemini-4",
            task_id="ISOLATED-001"
        )

        assert result == {}

    def test_get_progress_no_team(self):
        """Test denial for agent without team."""
        result = get_task_progress(
            requesting_agent="legacy-agent",
            task_id="ANY-TASK"
        )

        assert result.get("status") == "denied"


# Blueprint verification wrapper tests
def test_heartbeat():
    """Blueprint verification: P1-1.2 - post_heartbeat with progress fields."""
    _heartbeat_registry.clear()
    init_db()

    result = post_heartbeat(
        worker="claude-3",
        task_id="VERIFY-001",
        progress_pct=50,
        current_action="testing",
        current_milestone="mid"
    )

    assert result["status"] == "heartbeat_posted"
    heartbeat = _heartbeat_registry.get("claude-3")
    assert heartbeat["progress_pct"] == 50


def test_get_progress():
    """Blueprint verification: P1-1.3 - get_task_progress MCP tool."""
    _heartbeat_registry.clear()
    init_db()

    # Post heartbeat
    post_heartbeat(
        worker="claude-3",
        task_id="VERIFY-002",
        progress_pct=75,
        current_milestone="nearly done"
    )

    # Query progress
    result = get_task_progress(
        requesting_agent="gemini-3",
        task_id="VERIFY-002"
    )

    assert result["progress_pct"] == 75


class TestProgressIntegration:
    """Integration tests for progress tracking."""

    def setup_method(self):
        _heartbeat_registry.clear()
        init_db()

    def test_full_progress_lifecycle(self):
        """Test complete progress tracking lifecycle."""
        task_id = "LIFECYCLE-001"
        worker = "claude-3"

        # Start task
        post_heartbeat(worker=worker, task_id=task_id, progress_pct=0, current_milestone="started")
        progress = get_task_progress(requesting_agent="gemini-3", task_id=task_id)
        assert progress["progress_pct"] == 0
        assert progress["milestone"] == "started"

        # Mid progress
        post_heartbeat(worker=worker, task_id=task_id, progress_pct=50, current_milestone="coding")
        progress = get_task_progress(requesting_agent="gemini-3", task_id=task_id)
        assert progress["progress_pct"] == 50
        assert progress["milestone"] == "coding"

        # Complete
        post_heartbeat(worker=worker, task_id=task_id, progress_pct=100, current_milestone="done")
        progress = get_task_progress(requesting_agent="gemini-3", task_id=task_id)
        assert progress["progress_pct"] == 100
        assert progress["milestone"] == "done"
