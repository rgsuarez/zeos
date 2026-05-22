"""
Unit tests for context summarization (P1-2.4).

Tests:
- TaskSummarizer class
- summarize() method
- summarize_task MCP tool
"""

import pytest
import json
from datetime import datetime, timezone, timedelta

from overseer.summarization import TaskSummarizer, TaskSummary, MAX_SUMMARY_LENGTH
from overseer.server import init_db, summarize_task, post_message, DB_PATH


class TestSummarize:
    """Test TaskSummarizer.summarize() method."""

    def test_summarize_empty(self):
        """Test summarization of empty message list."""
        summarizer = TaskSummarizer()
        result = summarizer.summarize([])
        assert result == ""

    def test_summarize_task_assign(self):
        """Test summarization of task assignment."""
        summarizer = TaskSummarizer()
        messages = [
            {
                "type": "task_assign",
                "content": json.dumps({
                    "task_id": "TEST-001",
                    "assigned_to": "claude-3"
                }),
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
        ]

        result = summarizer.summarize(messages)
        assert "TEST-001" in result
        assert "claude-3" in result

    def test_summarize_complete_flow(self):
        """Test summarization of complete task flow."""
        summarizer = TaskSummarizer()
        start_time = datetime.now(timezone.utc)
        end_time = start_time + timedelta(minutes=5)

        messages = [
            {
                "type": "task_assign",
                "content": json.dumps({
                    "task_id": "FLOW-001",
                    "assigned_to": "claude-3",
                    "description": "Test task"
                }),
                "timestamp": start_time.isoformat()
            },
            {
                "type": "task_accept",
                "agent": "claude-3",
                "content": json.dumps({"task_id": "FLOW-001"}),
                "timestamp": (start_time + timedelta(seconds=30)).isoformat()
            },
            {
                "type": "task_complete",
                "content": json.dumps({
                    "task_id": "FLOW-001",
                    "status": "success",
                    "artifacts": ["output.txt"]
                }),
                "timestamp": end_time.isoformat()
            }
        ]

        result = summarizer.summarize(messages)
        assert "FLOW-001" in result
        assert "success" in result
        assert len(result) <= MAX_SUMMARY_LENGTH

    def test_summarize_blocked(self):
        """Test summarization of blocked task."""
        summarizer = TaskSummarizer()
        messages = [
            {
                "type": "task_assign",
                "content": json.dumps({
                    "task_id": "BLOCKED-001",
                    "assigned_to": "codex-3"
                }),
                "timestamp": datetime.now(timezone.utc).isoformat()
            },
            {
                "type": "task_blocked",
                "content": json.dumps({
                    "task_id": "BLOCKED-001",
                    "blocker": "Missing dependency"
                }),
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
        ]

        result = summarizer.summarize(messages)
        assert "BLOCKED-001" in result
        assert "blocked" in result

    def test_summarize_truncates(self):
        """Test that summary truncates to max length."""
        summarizer = TaskSummarizer(max_length=50)
        messages = [
            {
                "type": "task_assign",
                "content": json.dumps({
                    "task_id": "VERY-LONG-TASK-ID-THAT-IS-REALLY-QUITE-LONG",
                    "assigned_to": "claude-worker-with-long-name-3"
                }),
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
        ]

        result = summarizer.summarize(messages)
        assert len(result) <= 50


class TestSummarizeFull:
    """Test TaskSummarizer.summarize_full() method."""

    def test_full_summary_object(self):
        """Test that full summary returns TaskSummary object."""
        summarizer = TaskSummarizer()
        start_time = datetime.now(timezone.utc)
        end_time = start_time + timedelta(minutes=2)

        messages = [
            {
                "type": "task_assign",
                "content": json.dumps({
                    "task_id": "FULL-001",
                    "assigned_to": "gemini-3"
                }),
                "timestamp": start_time.isoformat()
            },
            {
                "type": "task_complete",
                "content": json.dumps({
                    "task_id": "FULL-001",
                    "status": "success"
                }),
                "timestamp": end_time.isoformat()
            }
        ]

        result = summarizer.summarize_full(messages)

        assert isinstance(result, TaskSummary)
        assert result.task_id == "FULL-001"
        assert result.worker == "gemini-3"
        assert result.outcome == "success"
        assert result.duration_seconds is not None
        assert result.duration_seconds >= 120  # ~2 minutes

    def test_compressed_tokens_estimate(self):
        """Test that compressed_tokens is estimated correctly."""
        summarizer = TaskSummarizer()
        long_content = "x" * 1000

        messages = [
            {
                "type": "raw",
                "content": long_content,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
        ]

        result = summarizer.summarize_full(messages)
        # Should save significant tokens
        assert result.compressed_tokens > 0


class TestDurationFormat:
    """Test duration formatting."""

    def test_format_seconds(self):
        """Test seconds formatting."""
        summarizer = TaskSummarizer()
        result = summarizer._format_duration(45)
        assert result == "45s"

    def test_format_minutes(self):
        """Test minutes formatting."""
        summarizer = TaskSummarizer()
        result = summarizer._format_duration(125)
        assert "2m" in result

    def test_format_hours(self):
        """Test hours formatting."""
        summarizer = TaskSummarizer()
        result = summarizer._format_duration(3700)
        assert "1h" in result


# Blueprint verification wrapper tests
def test_summarize():
    """Blueprint verification: P1-2.2 - rule-based summarization."""
    summarizer = TaskSummarizer()

    messages = [
        {
            "type": "task_assign",
            "content": json.dumps({
                "task_id": "VERIFY-001",
                "assigned_to": "claude-3"
            }),
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
    ]

    result = summarizer.summarize(messages)
    assert "VERIFY-001" in result


def test_summarize_tool():
    """Blueprint verification: P1-2.3 - summarize_task MCP tool."""
    init_db()
    import sqlite3
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM messages")
    conn.commit()
    conn.close()

    # Post a message
    post_message(
        agent="gemini-3",
        content=json.dumps({"task_id": "VERIFY-002", "assigned_to": "claude-3"}),
        msg_type="task_assign"
    )

    # Summarize
    result = summarize_task(requesting_agent="gemini-3", task_id="VERIFY-002")
    assert result["task_id"] == "VERIFY-002"


class TestSummarizeTaskTool:
    """Test summarize_task MCP tool."""

    def setup_method(self):
        """Reset database."""
        init_db()
        import sqlite3
        conn = sqlite3.connect(DB_PATH)
        conn.execute("DELETE FROM messages")
        conn.commit()
        conn.close()

    def test_summarize_task_found(self):
        """Test summarization of existing task messages."""
        # Post task-related messages
        post_message(
            agent="gemini-3",
            content=json.dumps({
                "task_id": "TOOL-001",
                "assigned_to": "claude-3"
            }),
            msg_type="task_assign"
        )
        post_message(
            agent="claude-3",
            content=json.dumps({
                "task_id": "TOOL-001",
                "status": "success"
            }),
            msg_type="task_complete"
        )

        # Summarize
        result = summarize_task(
            requesting_agent="gemini-3",
            task_id="TOOL-001"
        )

        assert result["task_id"] == "TOOL-001"
        assert "TOOL-001" in result["summary"]
        assert result["message_count"] == 2

    def test_summarize_task_not_found(self):
        """Test summarization when no messages found."""
        result = summarize_task(
            requesting_agent="gemini-3",
            task_id="NONEXISTENT-TASK"
        )

        assert result["task_id"] == "NONEXISTENT-TASK"
        assert result["message_count"] == 0
        assert "No messages found" in result["summary"]

    def test_summarize_task_denied(self):
        """Test denial for agent without team."""
        result = summarize_task(
            requesting_agent="legacy-agent",
            task_id="ANY-TASK"
        )

        assert result.get("status") == "denied"
