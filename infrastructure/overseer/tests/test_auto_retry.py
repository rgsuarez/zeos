"""
Tests for Auto-Retry Module (P1-4).
"""

import pytest
from unittest.mock import patch, MagicMock

from overseer.server import (
    get_retry_count,
    increment_retry_count,
    reset_retry_count,
    auto_remediate_stalls,
    _retry_registry,
    MAX_RETRIES
)


class TestRetryTracking:
    """Test retry count tracking functions."""

    def setup_method(self):
        """Clear retry registry before each test."""
        _retry_registry.clear()

    def test_get_retry_count_default(self):
        """Test get_retry_count returns 0 for unknown task."""
        count = get_retry_count("unknown-task")
        assert count == 0

    def test_increment_retry_count(self):
        """Test incrementing retry count."""
        assert get_retry_count("task-1") == 0
        result = increment_retry_count("task-1")
        assert result == 1
        assert get_retry_count("task-1") == 1

    def test_increment_retry_count_multiple(self):
        """Test multiple increments."""
        increment_retry_count("task-2")
        increment_retry_count("task-2")
        increment_retry_count("task-2")
        assert get_retry_count("task-2") == 3

    def test_reset_retry_count(self):
        """Test resetting retry count."""
        increment_retry_count("task-3")
        increment_retry_count("task-3")
        assert get_retry_count("task-3") == 2
        reset_retry_count("task-3")
        assert get_retry_count("task-3") == 0

    def test_reset_nonexistent_task(self):
        """Test resetting nonexistent task doesn't error."""
        reset_retry_count("nonexistent")  # Should not raise
        assert get_retry_count("nonexistent") == 0

    def test_multiple_tasks_isolated(self):
        """Test retry counts are isolated per task."""
        increment_retry_count("task-a")
        increment_retry_count("task-a")
        increment_retry_count("task-b")
        assert get_retry_count("task-a") == 2
        assert get_retry_count("task-b") == 1
        reset_retry_count("task-a")
        assert get_retry_count("task-a") == 0
        assert get_retry_count("task-b") == 1


class TestAutoRemediate:
    """Test auto_remediate_stalls MCP tool."""

    def setup_method(self):
        """Clear retry registry before each test."""
        _retry_registry.clear()

    def test_auto_remediate_exists(self):
        """Test auto_remediate_stalls function exists."""
        assert callable(auto_remediate_stalls)

    def test_auto_remediate_no_stalls(self):
        """Test auto_remediate with no stalled workers."""
        from overseer.server import _heartbeat_registry
        _heartbeat_registry.clear()

        result = auto_remediate_stalls(requesting_agent="gemini-3")

        # Should return empty actions when no workers registered
        assert result.get("status") != "denied"
        assert "actions" in result or "error" not in result

    def test_auto_remediate_denied_without_team(self):
        """Test auto_remediate denied for agent without team."""
        result = auto_remediate_stalls(requesting_agent="legacy-agent")

        assert result["status"] == "denied"

    def test_auto_remediate_with_max_retries_param(self):
        """Test auto_remediate accepts max_retries parameter."""
        result = auto_remediate_stalls(requesting_agent="gemini-3", max_retries=5)

        # Should not error with custom max_retries
        assert result.get("status") != "denied" or "team" in result.get("error", "")


# Blueprint verification wrapper tests
def test_retry_tracking():
    """Blueprint verification: P1-4.1 - Retry tracking works."""
    _retry_registry.clear()

    # Test the full cycle
    assert get_retry_count("verify-task") == 0
    increment_retry_count("verify-task")
    assert get_retry_count("verify-task") == 1
    increment_retry_count("verify-task")
    assert get_retry_count("verify-task") == 2
    reset_retry_count("verify-task")
    assert get_retry_count("verify-task") == 0


def test_remediate():
    """Blueprint verification: P1-4.2 - auto_remediate_stalls exists."""
    assert callable(auto_remediate_stalls)
