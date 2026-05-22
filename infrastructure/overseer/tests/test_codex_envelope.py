"""
Codex MCP-client wire-shape regression tests.

Codex's Rust MCP client (`rmcp` / `codex_rmcp_client`) rejects FastMCP's
``list[dict]`` tool returns as "Unexpected response type". The fix wraps such
returns in a ``dict`` envelope so FastMCP serializes the result as a single
``TextContent`` — universally parseable by both Codex and Claude.

LOE: LOE-zeos-overseer-codex-relay-compat (2026-05-04).
"""

import pytest

from overseer.server import (
    DB_PATH,
    debug_get_messages,
    get_messages,
    init_db,
    post_message,
    subscribe,
)


def _wipe_messages():
    import sqlite3

    init_db()
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM messages")
    conn.commit()
    conn.close()


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)
    # Reset cached init flag so init_db runs against the temp path.
    monkeypatch.setattr("overseer.server._db_initialized_path", None, raising=False)
    init_db()
    return test_db


class TestGetMessagesEnvelope:
    """get_messages must always return a dict on the success path."""

    def test_empty_returns_envelope(self, fresh_db):
        result = get_messages(requesting_agent="claude-1")
        assert isinstance(result, dict)
        assert result["status"] == "ok"
        assert result["messages"] == []
        assert result["count"] == 0
        assert result["timed_out"] is False

    def test_populated_returns_envelope(self, fresh_db):
        post_message("claude-1", "hello")
        post_message("gemini-1", "world")
        result = get_messages(requesting_agent="claude-1")
        assert isinstance(result, dict)
        assert result["status"] == "ok"
        assert result["count"] == 2
        assert {m["content"] for m in result["messages"]} == {"hello", "world"}

    def test_denial_dict_unchanged(self, fresh_db):
        # Bare agent (no team) — denial path must remain a dict with status=denied.
        result = get_messages(requesting_agent="claude")
        assert isinstance(result, dict)
        assert result["status"] == "denied"
        assert "messages" not in result

    def test_missing_requesting_agent_denied(self, fresh_db):
        result = get_messages(requesting_agent="")
        assert result["status"] == "denied"
        assert "required" in result["error"]


class TestSubscribeEnvelope:
    """subscribe must always return a dict; timed_out flag distinguishes timeout from data."""

    def test_immediate_hit_envelope(self, fresh_db):
        post_message("claude-1", "preexisting")
        result = subscribe(requesting_agent="gemini-1", since_id=0, timeout=1)
        assert isinstance(result, dict)
        assert result["status"] == "ok"
        assert result["timed_out"] is False
        assert result["count"] == 1
        assert result["messages"][0]["content"] == "preexisting"

    def test_timeout_envelope_has_empty_list_and_flag(self, fresh_db):
        result = subscribe(requesting_agent="claude-1", since_id=0, timeout=1)
        assert isinstance(result, dict)
        assert result["status"] == "ok"
        assert result["timed_out"] is True
        assert result["messages"] == []
        assert result["count"] == 0

    def test_denial_dict_unchanged(self, fresh_db):
        result = subscribe(requesting_agent="legacy", since_id=0, timeout=1)
        assert isinstance(result, dict)
        assert result["status"] == "denied"


class TestDebugGetMessagesEnvelope:
    """debug_get_messages must wrap its cross-team list in the same envelope."""

    def test_allowlisted_returns_envelope(self, fresh_db, monkeypatch):
        monkeypatch.setenv("OVERSEER_DEBUG_ALLOWLIST", "gemini-3")
        post_message("claude-1", "team-1 msg")
        post_message("claude-2", "team-2 msg")
        result = debug_get_messages(requesting_agent="gemini-3")
        assert isinstance(result, dict)
        assert result["status"] == "ok"
        assert result["count"] == 2
        assert {m["team_id"] for m in result["messages"]} == {"1", "2"}

    def test_non_allowlisted_denied(self, fresh_db, monkeypatch):
        monkeypatch.setenv("OVERSEER_DEBUG_ALLOWLIST", "gemini-3")
        result = debug_get_messages(requesting_agent="claude-1")
        assert result["status"] == "denied"


class TestEnvelopeShapeIsCodexSafe:
    """Cross-cutting assertions: the envelope is a flat dict with primitive scalars only."""

    def test_envelope_keys_are_stable(self, fresh_db):
        result = get_messages(requesting_agent="claude-1")
        assert set(result.keys()) == {"status", "messages", "count", "timed_out"}

    def test_subscribe_envelope_keys_are_stable(self, fresh_db):
        result = subscribe(requesting_agent="claude-1", since_id=0, timeout=1)
        assert set(result.keys()) == {"status", "messages", "count", "timed_out"}

    def test_envelope_is_json_serializable(self, fresh_db):
        import json

        post_message("claude-1", "ping")
        result = get_messages(requesting_agent="claude-1")
        # Must serialize without errors (FastMCP serializes via json.dumps).
        json.dumps(result)


class TestPairRegistryDoesNotChangeRelayEnvelope:
    """Regression: LOE-zeos-overseer-npair-tmux-intercom (2026-05-05).

    Adding the pair_registry table and the four new pair tools must NOT
    change the existing get_messages / subscribe / debug_get_messages
    envelope shape. PR #8 contract is locked.
    """

    def test_envelope_keys_unchanged_after_pair_registered(self, fresh_db):
        from overseer.server import register_pair

        register_pair(
            requesting_agent="bridge-0",
            pair_id="lock-envelope",
            team_id="1042",
        )
        result = get_messages(requesting_agent="claude-1")
        assert set(result.keys()) == {"status", "messages", "count", "timed_out"}
        sub = subscribe(requesting_agent="claude-1", since_id=0, timeout=1)
        assert set(sub.keys()) == {"status", "messages", "count", "timed_out"}

    def test_legacy_team_workflow_unchanged_after_pair_exists(self, fresh_db):
        from overseer.server import register_pair

        # Register a high-numbered pair; legacy team-1 callers must still
        # work exactly as before (claude-1/codex-1 with no registry row).
        register_pair(
            requesting_agent="bridge-0",
            pair_id="legacy-coexist",
            team_id="1042",
        )
        post_message("claude-1", "legacy-msg")
        result = get_messages(requesting_agent="claude-1")
        assert result["status"] == "ok"
        contents = {m["content"] for m in result["messages"]}
        assert "legacy-msg" in contents
