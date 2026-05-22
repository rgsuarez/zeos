"""
Tests for the OVERSEER_DEFAULT_TEAM_ID env-var fallback.

When set, a bare agent name (no numeric suffix) resolves to the configured
team for the *requester* only — never for cross-team validation of a target.
This lets a Codex shell exporting OVERSEER_DEFAULT_TEAM_ID=N call the relay
without retyping the suffix on every call. Default unset preserves the
existing strict-deny behavior.

LOE: LOE-zeos-overseer-codex-relay-compat (2026-05-04).
"""

import pytest

from overseer.server import (
    DB_PATH,
    enforce_team_filter,
    extract_team,
    get_messages,
    init_db,
    post_message,
    subscribe,
)


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)
    monkeypatch.setattr("overseer.server._db_initialized_path", None, raising=False)
    init_db()
    return test_db


class TestExtractTeamUnchanged:
    """extract_team is the strict, no-fallback helper. Its semantics must not regress."""

    def test_numeric_suffix_returns_team(self):
        assert extract_team("codex-1") == "1"
        assert extract_team("claude-3") == "3"

    def test_legacy_returns_none(self):
        assert extract_team("codex") is None
        assert extract_team("claude") is None

    def test_non_numeric_suffix_returns_none(self):
        assert extract_team("claude-opus") is None
        assert extract_team("overseer-admin") is None


class TestRequesterTeamFallback:
    """enforce_team_filter must honor OVERSEER_DEFAULT_TEAM_ID for the requester."""

    def test_no_env_strict_deny(self, monkeypatch):
        monkeypatch.delenv("OVERSEER_DEFAULT_TEAM_ID", raising=False)
        assert enforce_team_filter("codex") is None

    def test_env_set_provides_fallback(self, monkeypatch):
        monkeypatch.setenv("OVERSEER_DEFAULT_TEAM_ID", "1")
        assert enforce_team_filter("codex") == "1"

    def test_env_set_does_not_override_explicit_suffix(self, monkeypatch):
        monkeypatch.setenv("OVERSEER_DEFAULT_TEAM_ID", "9")
        # Explicit suffix wins.
        assert enforce_team_filter("codex-3") == "3"

    def test_non_numeric_env_ignored(self, monkeypatch):
        monkeypatch.setenv("OVERSEER_DEFAULT_TEAM_ID", "foo")
        assert enforce_team_filter("codex") is None

    def test_zero_only_for_bridge(self, monkeypatch):
        monkeypatch.setenv("OVERSEER_DEFAULT_TEAM_ID", "0")
        # Non-bridge agent should be rejected even with env=0.
        assert enforce_team_filter("codex") is None
        # Only bridge-0 is honored.
        assert enforce_team_filter("bridge-0") == "0"

    def test_target_uses_strict_extract(self, monkeypatch):
        """Fallback applies to requester only; target uses strict extract_team."""
        monkeypatch.setenv("OVERSEER_DEFAULT_TEAM_ID", "1")
        # requester resolves to team 1 via env; target "claude" has no team —
        # so cross-team check is skipped (target has no team to compare).
        assert enforce_team_filter("codex", target_agent="claude") == "1"

        # If target IS on team 2, ValueError is raised because requester is team 1.
        with pytest.raises(ValueError):
            enforce_team_filter("codex", target_agent="claude-2")


class TestEndToEndDefaultTeamFallback:
    """End-to-end: bare codex with env can call get_messages/subscribe successfully."""

    def test_get_messages_with_env_succeeds(self, fresh_db, monkeypatch):
        monkeypatch.setenv("OVERSEER_DEFAULT_TEAM_ID", "1")
        post_message("claude-1", "hello team 1")
        result = get_messages(requesting_agent="codex")
        assert result["status"] == "ok"
        assert result["count"] == 1
        assert result["messages"][0]["content"] == "hello team 1"

    def test_subscribe_with_env_succeeds(self, fresh_db, monkeypatch):
        monkeypatch.setenv("OVERSEER_DEFAULT_TEAM_ID", "1")
        post_message("claude-1", "ping")
        result = subscribe(requesting_agent="codex", since_id=0, timeout=1)
        assert result["status"] == "ok"
        assert result["timed_out"] is False
        assert result["messages"][0]["content"] == "ping"

    def test_without_env_still_denied(self, fresh_db, monkeypatch):
        monkeypatch.delenv("OVERSEER_DEFAULT_TEAM_ID", raising=False)
        result = get_messages(requesting_agent="codex")
        assert result["status"] == "denied"


class TestDefaultTeamIdIsSingleLaneOnly:
    """Regression: LOE-zeos-overseer-npair-tmux-intercom (2026-05-05).

    OVERSEER_DEFAULT_TEAM_ID remains a single-lane shorthand for bare
    requesters. It MUST NOT be a fleet-routing knob — i.e., setting it to
    1 cannot give a bare codex visibility into pair team_id 1042.
    """

    def test_env_set_to_1_does_not_route_to_pair_team(self, fresh_db, monkeypatch):
        from overseer.server import register_pair

        # Register a pair on team 1042.
        register_pair(
            requesting_agent="bridge-0",
            pair_id="pair-fleet-test",
            team_id="1042",
        )
        post_message("claude-1042", "secret-pair-message")
        # A bare codex with OVERSEER_DEFAULT_TEAM_ID=1 lands on team 1 —
        # it should NOT see the team-1042 message.
        monkeypatch.setenv("OVERSEER_DEFAULT_TEAM_ID", "1")
        result = get_messages(requesting_agent="codex")
        assert result["status"] == "ok"
        contents = {m["content"] for m in result["messages"]}
        assert "secret-pair-message" not in contents

    def test_env_set_to_1042_does_not_grant_pair_access(
        self, fresh_db, monkeypatch
    ):
        """Even setting env to a registered pair team_id is just a single-lane
        opt-in for the bare requester — no special pair semantics attach."""
        from overseer.server import register_pair

        register_pair(
            requesting_agent="bridge-0",
            pair_id="pair-aware",
            team_id="1042",
            claude_session="%aware-c",
            codex_session="%aware-x",
        )
        # Bare codex routes to 1042 via env. It can read team-1042 messages
        # because it now identifies as team 1042 — but the pair_registry
        # behavior is unchanged: claude_session etc. still come only via
        # resolve_pair, not via OVERSEER_DEFAULT_TEAM_ID.
        monkeypatch.setenv("OVERSEER_DEFAULT_TEAM_ID", "1042")
        post_message("claude-1042", "team-1042-payload")
        gm = get_messages(requesting_agent="codex")
        assert gm["status"] == "ok"
        contents = {m["content"] for m in gm["messages"]}
        assert "team-1042-payload" in contents
