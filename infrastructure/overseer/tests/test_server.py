"""Tests for Overseer MCP server."""

import sqlite3
from unittest.mock import patch, MagicMock

import pytest
import overseer.server as server_mod
from overseer.server import strip_ansi, init_db, post_message, get_messages, debug_get_messages


class TestStripAnsi:
    """Test ANSI code stripping."""

    def test_strips_color_codes(self):
        text = "\x1b[31mRed text\x1b[0m"
        assert strip_ansi(text) == "Red text"

    def test_strips_cursor_codes(self):
        text = "\x1b[2J\x1b[HHello"
        assert strip_ansi(text) == "Hello"

    def test_preserves_plain_text(self):
        text = "Plain text without codes"
        assert strip_ansi(text) == "Plain text without codes"

    def test_handles_empty_string(self):
        assert strip_ansi("") == ""


class TestMessageRelay:
    """Test message relay functionality."""

    def test_post_and_get_message(self, tmp_path, monkeypatch):
        # Use temp database
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)

        # Post a message (use team-based agent name)
        result = post_message("claude-1", "Hello from Claude")
        assert result["status"] == "posted"
        assert result["agent"] == "claude-1"
        assert result["team_id"] == "1"
        assert "id" in result

        # Retrieve messages (requesting_agent is now required)
        envelope = get_messages(requesting_agent="claude-1")
        assert envelope["status"] == "ok"
        assert envelope["timed_out"] is False
        messages = envelope["messages"]
        assert envelope["count"] == len(messages) == 1
        assert messages[0]["agent"] == "claude-1"
        assert messages[0]["content"] == "Hello from Claude"
        assert messages[0]["team_id"] == "1"

    def test_get_messages_since_id(self, tmp_path, monkeypatch):
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)

        # Post multiple messages (same team for isolation)
        post_message("claude-1", "Message 1")
        result2 = post_message("gemini-1", "Message 2")
        post_message("claude-1", "Message 3")

        # Get messages since message 2 (requesting_agent required)
        envelope = get_messages(requesting_agent="claude-1", since_id=result2["id"])
        messages = envelope["messages"]
        assert len(messages) == 1
        assert messages[0]["content"] == "Message 3"

    def test_filter_by_agent(self, tmp_path, monkeypatch):
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)

        # Use team-based agent names
        post_message("claude-1", "Claude message")
        post_message("gemini-1", "Gemini message")
        post_message("claude-1", "Another Claude message")

        # Filter by agent within same team (requesting_agent required)
        envelope = get_messages(requesting_agent="codex-1", agent_filter="claude-1")
        messages = envelope["messages"]
        assert len(messages) == 2
        assert all(m["agent"] == "claude-1" for m in messages)

    def test_team_isolation(self, tmp_path, monkeypatch):
        """Test that teams cannot see each other's messages."""
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)

        # Post messages from different teams
        post_message("claude-1", "Team 1 message")
        post_message("claude-2", "Team 2 message")
        post_message("claude-3", "Team 3 message")

        # Team 1 can only see Team 1 messages
        team1_msgs = get_messages(requesting_agent="gemini-1")["messages"]
        assert len(team1_msgs) == 1
        assert team1_msgs[0]["team_id"] == "1"

        # Team 2 can only see Team 2 messages
        team2_msgs = get_messages(requesting_agent="codex-2")["messages"]
        assert len(team2_msgs) == 1
        assert team2_msgs[0]["team_id"] == "2"

    def test_legacy_agent_denied(self, tmp_path, monkeypatch):
        """Test that legacy agents without team are denied access."""
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)

        # Legacy agent (no team suffix) should be denied
        result = get_messages(requesting_agent="claude")
        assert result["status"] == "denied"
        assert "no team assignment" in result["error"]

    def test_post_message_legacy_denied(self, tmp_path, monkeypatch):
        """Test that legacy agents cannot post messages."""
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)

        result = post_message("claude", "Legacy post")
        assert result["status"] == "denied"
        assert "no team assignment" in result["error"]

    def test_debug_get_messages_allowlist(self, tmp_path, monkeypatch):
        """Test debug tool returns cross-team messages for allowlisted agent."""
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        monkeypatch.setenv("OVERSEER_DEBUG_ALLOWLIST", "gemini-3")

        post_message("claude-1", "Team 1 message")
        post_message("claude-2", "Team 2 message")

        envelope = debug_get_messages(requesting_agent="gemini-3")
        assert envelope["status"] == "ok"
        messages = envelope["messages"]
        assert envelope["count"] == len(messages) == 2
        assert {m["team_id"] for m in messages} == {"1", "2"}

    def test_debug_get_messages_denied(self, tmp_path, monkeypatch):
        """Test debug tool denies non-allowlisted agent."""
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        monkeypatch.setenv("OVERSEER_DEBUG_ALLOWLIST", "gemini-3")

        result = debug_get_messages(requesting_agent="claude-3")
        assert result["status"] == "denied"


class TestInitDbGuard:
    """Test _db_initialized guard prevents redundant init_db() calls."""

    def test_init_db_guard_skips_second_call(self, tmp_path, monkeypatch):
        """init_db() should run _init_db_inner once, then skip on second call."""
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)

        call_count = 0
        original_inner = server_mod._init_db_inner

        def counting_inner():
            nonlocal call_count
            call_count += 1
            original_inner()

        monkeypatch.setattr("overseer.server._init_db_inner", counting_inner)

        init_db()
        init_db()
        init_db()
        assert call_count == 1
        assert server_mod._db_initialized_path == test_db

    def test_init_db_retries_on_operational_error(self, tmp_path, monkeypatch):
        """init_db() should retry on sqlite3.OperationalError with backoff."""
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        monkeypatch.setattr("overseer.server._INIT_DB_BASE_DELAY", 0.01)  # Fast tests

        call_count = 0
        original_inner = server_mod._init_db_inner

        def fail_twice_then_succeed():
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                raise sqlite3.OperationalError("database is locked")
            original_inner()

        monkeypatch.setattr("overseer.server._init_db_inner", fail_twice_then_succeed)

        init_db()
        assert call_count == 3
        assert server_mod._db_initialized_path == test_db

    def test_init_db_raises_after_exhaustion(self, tmp_path, monkeypatch):
        """init_db() should raise after all retries exhausted."""
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        monkeypatch.setattr("overseer.server._INIT_DB_BASE_DELAY", 0.01)

        def always_fail():
            raise sqlite3.OperationalError("database is locked")

        monkeypatch.setattr("overseer.server._init_db_inner", always_fail)

        with pytest.raises(sqlite3.OperationalError, match="failed after 3 attempts"):
            init_db()

        assert server_mod._db_initialized_path is None

    def test_schema_migration_idempotent(self, tmp_path, monkeypatch):
        """_run_schema_migration should be a no-op when schema is already correct."""
        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)

        # First init creates correct schema
        init_db()

        # Post a message to verify data survives
        post_message("claude-1", "test message")

        # Force re-run of migration on already-correct schema
        server_mod._db_initialized_path = None
        conn = server_mod.get_db()
        server_mod._run_schema_migration(conn)
        conn.commit()
        conn.close()

        # Data should still be intact
        envelope = get_messages(requesting_agent="claude-1")
        messages = envelope["messages"]
        assert len(messages) == 1
        assert messages[0]["content"] == "test message"
