"""
Unit tests for multi-team subscription support (P0-1.7, P0-1.8).

Tests:
- subscribe() with team_ids parameter
- get_messages() with team_ids parameter
- Backward compatibility with single requesting_agent
- Bridge/director mode observing multiple teams

NOTE: After 2026-05-04 codex-compat envelope work, get_messages and subscribe
return ``{"status":"ok","messages":[...],"count":N,"timed_out":bool}`` on the
success path. Tests destructure ``result["messages"]`` for the legacy list
shape. ``_fetch_messages`` is the underlying helper and still returns a bare
``list[dict]`` — only the public MCP tool layer wraps.
"""

import pytest
from unittest.mock import patch

from overseer.server import (
    init_db,
    post_message,
    get_messages,
    subscribe,
    _fetch_messages,
    DB_PATH
)


def _msgs(envelope_or_list):
    """Extract messages list from either the new dict envelope or a bare list."""
    if isinstance(envelope_or_list, dict) and envelope_or_list.get("status") == "ok":
        return envelope_or_list["messages"]
    return envelope_or_list


class TestMultiTeamFetch:
    """Test _fetch_messages with team_ids parameter."""

    def setup_method(self):
        """Setup test database with messages from multiple teams."""
        init_db()
        # Clear existing messages
        import sqlite3
        conn = sqlite3.connect(DB_PATH)
        conn.execute("DELETE FROM messages")
        conn.commit()
        conn.close()

        # Post messages from different teams
        post_message("claude-3", "Team 3 message 1", msg_type="raw")
        post_message("gemini-3", "Team 3 message 2", msg_type="raw")
        post_message("claude-4", "Team 4 message 1", msg_type="raw")
        post_message("codex-5", "Team 5 message 1", msg_type="raw")

    def test_fetch_single_team(self):
        """Test fetching messages from single team (legacy)."""
        messages = _fetch_messages(team_filter="3")
        assert len(messages) == 2
        assert all(m["team_id"] == "3" for m in messages)

    def test_fetch_multi_team_list(self):
        """Test fetching messages from multiple teams."""
        messages = _fetch_messages(team_ids=[3, 4])
        assert len(messages) == 3
        team_ids = {m["team_id"] for m in messages}
        assert team_ids == {"3", "4"}

    def test_fetch_all_teams_none(self):
        """Test fetching all teams when team_ids is not specified."""
        # When neither team_filter nor team_ids provided, fetch all
        messages = _fetch_messages()
        assert len(messages) == 4

    def test_fetch_empty_team_list(self):
        """Test empty team list returns no messages."""
        messages = _fetch_messages(team_ids=[])
        assert len(messages) == 0


class TestGetMessagesMultiTeam:
    """Test get_messages with team_ids parameter."""

    def setup_method(self):
        """Setup test database."""
        init_db()
        import sqlite3
        conn = sqlite3.connect(DB_PATH)
        conn.execute("DELETE FROM messages")
        conn.commit()
        conn.close()

        post_message("claude-3", "Team 3 msg", msg_type="raw")
        post_message("claude-4", "Team 4 msg", msg_type="raw")
        post_message("claude-5", "Team 5 msg", msg_type="raw")

    def test_get_messages_single_team_default(self):
        """Test backward compatibility - default to requesting agent's team."""
        result = get_messages(requesting_agent="claude-3")
        assert result["status"] == "ok"
        messages = result["messages"]
        assert result["count"] == len(messages) == 1
        assert messages[0]["team_id"] == "3"

    def test_get_messages_multi_team(self):
        """Test get_messages with explicit team_ids."""
        # Use bridge agent that has team assignment
        result = get_messages(requesting_agent="bridge-0", team_ids=[3, 4])
        assert result["status"] == "ok"
        messages = result["messages"]
        assert result["count"] == len(messages) == 2
        team_ids = {m["team_id"] for m in messages}
        assert team_ids == {"3", "4"}

    def test_get_messages_cross_team(self):
        """Test get_messages can access cross-team with team_ids."""
        # Agent from team 3 can request team 4 messages via explicit team_ids
        result = get_messages(requesting_agent="claude-3", team_ids=[4])
        messages = result["messages"]
        assert len(messages) == 1
        assert messages[0]["team_id"] == "4"

    def test_backward_compat_no_team_ids(self):
        """Test backward compatibility when team_ids not provided."""
        result = get_messages(requesting_agent="gemini-4")
        messages = result["messages"]
        # Should only see team 4 messages
        assert all(m["team_id"] == "4" for m in messages)


class TestSubscribeMultiTeam:
    """Test subscribe with team_ids parameter."""

    def setup_method(self):
        """Setup test database - clear all messages."""
        init_db()
        import sqlite3
        conn = sqlite3.connect(DB_PATH)
        conn.execute("DELETE FROM messages")
        conn.commit()
        conn.close()

    def test_subscribe_single_team_default(self):
        """Test subscribe defaults to requesting agent's team."""
        post_message("claude-3", "Team 3 heartbeat", msg_type="heartbeat")
        post_message("claude-4", "Team 4 heartbeat", msg_type="heartbeat")

        # Subscribe from team 3 - should only see team 3
        result = subscribe(requesting_agent="gemini-3", timeout=1, since_id=0)
        assert result["status"] == "ok"
        messages = result["messages"]
        assert len(messages) >= 1
        team3_messages = [m for m in messages if m["team_id"] == "3"]
        assert len(team3_messages) >= 1

    def test_subscribe_specific_teams(self):
        """Test subscribe with explicit team_ids list."""
        post_message("claude-3", "Team 3 msg", msg_type="task_complete")
        post_message("claude-4", "Team 4 msg", msg_type="task_complete")
        post_message("claude-5", "Team 5 msg", msg_type="task_complete")

        # Bridge agent subscribing to teams 3 and 4
        result = subscribe(requesting_agent="bridge-0", team_ids=[3, 4], timeout=1, since_id=0)
        messages = result["messages"]
        assert len(messages) >= 2
        team_ids = {m["team_id"] for m in messages}
        assert "3" in team_ids or "4" in team_ids

    def test_subscribe_all_teams_bridge_mode(self):
        """Test bridge mode can observe all teams via _fetch_messages."""
        import sqlite3

        # Insert directly to bypass rate limiting
        conn = sqlite3.connect(DB_PATH)
        for team in ["3", "4", "5"]:
            conn.execute(
                "INSERT INTO messages (agent, content, type, team_id) VALUES (?, ?, ?, ?)",
                (f"claude-{team}", f"Team {team} bridge", "bridge_test", team)
            )
        conn.commit()
        conn.close()

        # Direct _fetch_messages without team filter returns all
        messages = _fetch_messages(type_filter="bridge_test", since_id=0)
        assert len(messages) == 3
        team_ids = {m["team_id"] for m in messages}
        assert team_ids == {"3", "4", "5"}

    def test_subscribe_backward_compat(self):
        """Test backward compatibility - single requesting_agent works."""
        import sqlite3

        # Insert directly to bypass rate limiting
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            "INSERT INTO messages (agent, content, type, team_id) VALUES (?, ?, ?, ?)",
            ("claude-3", "Task A complete", "compat_test", "3")
        )
        conn.commit()
        conn.close()

        # Old-style call without team_ids - should still work
        result = subscribe(
            requesting_agent="gemini-3",
            filter_type="compat_test",
            timeout=1,
            since_id=0
        )
        messages = result["messages"]
        assert len(messages) == 1
        assert messages[0]["team_id"] == "3"


class TestTeamIsolation:
    """Test that team isolation is maintained correctly."""

    def setup_method(self):
        init_db()
        import sqlite3
        conn = sqlite3.connect(DB_PATH)
        conn.execute("DELETE FROM messages")
        conn.commit()
        conn.close()

    def test_default_isolation(self):
        """Test that default behavior isolates to agent's team."""
        post_message("claude-3", "Secret team 3 data")
        post_message("claude-4", "Secret team 4 data")

        # Team 3 agent shouldn't see team 4 by default
        result = get_messages(requesting_agent="gemini-3")
        assert all(m["team_id"] == "3" for m in result["messages"])

        # Team 4 agent shouldn't see team 3 by default
        result = get_messages(requesting_agent="gemini-4")
        assert all(m["team_id"] == "4" for m in result["messages"])

    def test_explicit_cross_team_allowed(self):
        """Test that explicit team_ids allows cross-team access."""
        import sqlite3

        # Insert directly to bypass rate limiting
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            "INSERT INTO messages (agent, content, type, team_id) VALUES (?, ?, ?, ?)",
            ("claude-3", "Team 3 data", "raw", "3")
        )
        conn.execute(
            "INSERT INTO messages (agent, content, type, team_id) VALUES (?, ?, ?, ?)",
            ("claude-4", "Team 4 data", "raw", "4")
        )
        conn.commit()
        conn.close()

        # Explicit team_ids enables cross-team access
        result = get_messages(requesting_agent="director-3", team_ids=[3, 4])
        messages = result["messages"]
        assert len(messages) == 2

    def test_agent_without_team_denied(self):
        """Test that agents without team suffix are denied."""
        result = get_messages(requesting_agent="legacy-agent")
        assert result.get("status") == "denied"

        result = subscribe(requesting_agent="unnamed", timeout=1)
        assert result.get("status") == "denied"
