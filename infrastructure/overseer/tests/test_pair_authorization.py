"""
Pair-tool authorization — exhaustive denial tests.

Locks every authorization rule documented in the LOE plan:
- Empty / unauthenticated requesting_agent → denied on all 4 tools.
- Bare/legacy requester (no team) → denied on all 4 tools.
- register_pair: low team_id, cross-team explicit team_id, immutable team_id,
  non-owner re-registration, UNIQUE collision.
- resolve_pair: cross-pair lookup denied for non-bridge.
- list_pairs: include_others=True denied for non-bridge; default returns only
  own pair.
- unregister_pair: cross-pair removal denied for non-bridge.
- Bridge happy paths.
- Metadata-leak guard: denial dicts NEVER include claude_session /
  codex_session / socket.

LOE-zeos-overseer-npair-tmux-intercom (2026-05-05).
"""

import pytest

from overseer.server import (
    init_db,
    list_pairs,
    register_pair,
    resolve_pair,
    unregister_pair,
)


SENSITIVE_KEYS = ("claude_session", "codex_session", "socket")


def _assert_no_metadata_leak(denial: dict):
    assert denial["status"] == "denied"
    for key in SENSITIVE_KEYS:
        assert key not in denial, f"denial leaks {key!r}: {denial}"


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)
    monkeypatch.setattr("overseer.server._db_initialized_path", None, raising=False)
    init_db()
    return test_db


@pytest.fixture
def two_pairs(fresh_db):
    a = register_pair(
        requesting_agent="bridge-0",
        pair_id="pair-A",
        team_id="1042",
        claude_session="%A1",
        codex_session="%A2",
        description="lane A",
    )
    b = register_pair(
        requesting_agent="bridge-0",
        pair_id="pair-B",
        team_id="1043",
        claude_session="%B1",
        codex_session="%B2",
        description="lane B",
    )
    assert a["status"] == "ok"
    assert b["status"] == "ok"
    return a, b


# ---------------------------------------------------------------------------
# Authentication: empty / bare / legacy requester
# ---------------------------------------------------------------------------


class TestUnauthenticatedDenied:
    def test_register_pair_empty_requesting_agent(self, fresh_db):
        result = register_pair(requesting_agent="", pair_id="p")
        assert result["status"] == "denied"
        assert "requesting_agent is required" in result["error"]
        _assert_no_metadata_leak(result)

    def test_unregister_pair_empty_requesting_agent(self, fresh_db):
        result = unregister_pair(requesting_agent="", pair_id="p")
        assert result["status"] == "denied"
        _assert_no_metadata_leak(result)

    def test_list_pairs_empty_requesting_agent(self, fresh_db):
        result = list_pairs(requesting_agent="")
        assert result["status"] == "denied"
        _assert_no_metadata_leak(result)

    def test_resolve_pair_empty_requesting_agent(self, fresh_db):
        result = resolve_pair(requesting_agent="", pair_id="p")
        assert result["status"] == "denied"
        _assert_no_metadata_leak(result)


class TestBareLegacyRequesterDenied:
    def test_register_pair_bare_codex_no_env(self, fresh_db, monkeypatch):
        monkeypatch.delenv("OVERSEER_DEFAULT_TEAM_ID", raising=False)
        result = register_pair(requesting_agent="codex", pair_id="p")
        assert result["status"] == "denied"
        assert "no team assignment" in result["error"]
        _assert_no_metadata_leak(result)

    def test_resolve_pair_bare_codex_no_env(self, fresh_db, monkeypatch):
        monkeypatch.delenv("OVERSEER_DEFAULT_TEAM_ID", raising=False)
        result = resolve_pair(requesting_agent="codex", pair_id="anything")
        assert result["status"] == "denied"
        _assert_no_metadata_leak(result)

    def test_list_pairs_bare_codex_no_env(self, fresh_db, monkeypatch):
        monkeypatch.delenv("OVERSEER_DEFAULT_TEAM_ID", raising=False)
        result = list_pairs(requesting_agent="codex")
        assert result["status"] == "denied"
        _assert_no_metadata_leak(result)

    def test_unregister_pair_bare_codex_no_env(self, fresh_db, monkeypatch):
        monkeypatch.delenv("OVERSEER_DEFAULT_TEAM_ID", raising=False)
        result = unregister_pair(requesting_agent="codex", pair_id="p")
        assert result["status"] == "denied"
        _assert_no_metadata_leak(result)


# ---------------------------------------------------------------------------
# register_pair: numeric / base / cross-team / immutable
# ---------------------------------------------------------------------------


class TestRegisterPairNumericRules:
    def test_low_team_id_denied_for_self(self, fresh_db):
        result = register_pair(
            requesting_agent="claude-42",
            pair_id="p-low",
            team_id="42",
        )
        assert result["status"] == "denied"
        assert "below OVERSEER_PAIR_TEAM_ID_BASE" in result["error"]
        assert "42" in result["error"]
        _assert_no_metadata_leak(result)

    def test_low_team_id_denied_even_for_bridge(self, fresh_db):
        # Codex 2026-05-05 amendment: bridge-0 has no override.
        result = register_pair(
            requesting_agent="bridge-0",
            pair_id="p-low-bridge",
            team_id="42",
        )
        assert result["status"] == "denied"
        assert "below OVERSEER_PAIR_TEAM_ID_BASE" in result["error"]
        _assert_no_metadata_leak(result)

    def test_self_registration_cross_team_denied(self, fresh_db):
        result = register_pair(
            requesting_agent="claude-1042",
            pair_id="p-cross",
            team_id="1043",
        )
        assert result["status"] == "denied"
        assert "1042" in result["error"]
        assert "1043" in result["error"]
        _assert_no_metadata_leak(result)

    def test_immutable_team_id_on_existing_pair(self, fresh_db):
        first = register_pair(
            requesting_agent="bridge-0", pair_id="p-imm"
        )
        team_id = first["team_id"]
        # Same requester, different team_id supplied.
        rebind = register_pair(
            requesting_agent="bridge-0",
            pair_id="p-imm",
            team_id="9999",
        )
        assert rebind["status"] == "denied"
        assert "cannot rebind" in rebind["error"]
        assert team_id in rebind["error"]
        assert "9999" in rebind["error"]
        _assert_no_metadata_leak(rebind)

    def test_re_register_without_team_id_returns_existing(self, fresh_db):
        first = register_pair(requesting_agent="bridge-0", pair_id="p-noid")
        team_id = first["team_id"]
        again = register_pair(
            requesting_agent=f"claude-{team_id}", pair_id="p-noid"
        )
        assert again["status"] == "ok"
        assert again["created"] is False
        assert again["team_id"] == team_id

    def test_non_owner_cross_pair_re_registration_denied(self, two_pairs):
        # pair-A is on team 1042. claude-1043 tries to re-register pair-A.
        result = register_pair(
            requesting_agent="claude-1043",
            pair_id="pair-A",
            claude_session="%hijack",
        )
        assert result["status"] == "denied"
        assert "1042" in result["error"]
        assert "1043" in result["error"]
        _assert_no_metadata_leak(result)

    def test_unique_collision_distinct_pair_ids(self, fresh_db):
        register_pair(
            requesting_agent="bridge-0", pair_id="p-x", team_id="1500"
        )
        result = register_pair(
            requesting_agent="claude-1500",
            pair_id="p-y",
            team_id="1500",
        )
        assert result["status"] == "denied"
        assert "1500" in result["error"]
        assert "p-x" in result["error"]
        _assert_no_metadata_leak(result)

    def test_explicit_team_id_with_stale_messages_denied(self, fresh_db):
        """Critical pair-isolation invariant (PR #9 second fixup):

        After tombstone, the most common path: the tombstone (UNIQUE) check
        fires first with a 'retired' denial. New pair_id, same team_id is
        denied because the team_id is reserved permanently.
        """
        from overseer.server import post_message, unregister_pair

        # Original pair posts on team 1042, then is unregistered (tombstoned).
        first = register_pair(
            requesting_agent="bridge-0", pair_id="p-old", team_id="1042"
        )
        assert first["status"] == "ok"
        post_message("claude-1042", "old-pair-secret")
        unregister_pair(requesting_agent="bridge-0", pair_id="p-old")

        # New pair tries to claim team 1042 explicitly. Tombstoned row in
        # pair_registry catches this first.
        result = register_pair(
            requesting_agent="bridge-0",
            pair_id="p-new",
            team_id="1042",
        )
        assert result["status"] == "denied"
        assert "1042" in result["error"]
        assert "retired" in result["error"]
        _assert_no_metadata_leak(result)

    def test_explicit_team_id_with_stale_messages_denied_for_bridge(
        self, fresh_db
    ):
        """Bridge-0 has no override for the team_id-reservation guards
        either — same hard-stop posture as the low-team-ID rule."""
        from overseer.server import post_message, unregister_pair

        register_pair(
            requesting_agent="bridge-0", pair_id="p-old", team_id="1500"
        )
        post_message("claude-1500", "stale")
        unregister_pair(requesting_agent="bridge-0", pair_id="p-old")

        result = register_pair(
            requesting_agent="bridge-0",
            pair_id="p-new",
            team_id="1500",
        )
        assert result["status"] == "denied"
        assert "1500" in result["error"]
        # Tombstoned pair_registry row catches the bridge-driven re-claim.
        assert "retired" in result["error"]
        _assert_no_metadata_leak(result)

    def test_explicit_team_id_with_orphan_messages_denied(self, fresh_db):
        """Defense-in-depth: even if a pair_registry row is missing (orphan
        state — DB hand-edit, partial restore, etc.), surviving messages on
        a team_id still block a new explicit-team_id registration. Cites
        the messages surface in the denial."""
        import sqlite3
        from overseer.server import DB_PATH

        # Insert an orphan messages row at team 1042 — no pair_registry row.
        with sqlite3.connect(str(DB_PATH)) as conn:
            conn.execute(
                "INSERT INTO messages (agent, content, type, team_id) "
                "VALUES (?, ?, ?, ?)",
                ("ghost-1042", "orphan", "raw", "1042"),
            )
            conn.commit()

        result = register_pair(
            requesting_agent="bridge-0",
            pair_id="p-orphan-msg",
            team_id="1042",
        )
        assert result["status"] == "denied"
        assert "1042" in result["error"]
        assert "messages" in result["error"]
        _assert_no_metadata_leak(result)

    def test_explicit_team_id_with_orphan_heartbeat_denied(self, fresh_db):
        """Stale heartbeat rows on an orphan team_id (no pair_registry row)
        must block explicit team_id reuse. Cites the heartbeats surface."""
        import sqlite3
        from overseer.server import DB_PATH

        with sqlite3.connect(str(DB_PATH)) as conn:
            conn.execute(
                "INSERT INTO heartbeats "
                "(worker, team_id, task_id, progress_pct, current_action, "
                " state, terminal_hash, epoch, timestamp) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("ghost-2042", "2042", "task-1", 50, "doing", "working",
                 "hash1", 1.0, "2026-05-05T00:00:00Z"),
            )
            conn.commit()

        result = register_pair(
            requesting_agent="bridge-0",
            pair_id="p-orphan-hb",
            team_id="2042",
        )
        assert result["status"] == "denied"
        assert "2042" in result["error"]
        assert "heartbeats" in result["error"]
        _assert_no_metadata_leak(result)

    def test_explicit_team_id_with_orphan_audit_denied(self, fresh_db):
        """audit_log entries on an orphan team_id must block reuse. Cites
        the audit_log surface."""
        import sqlite3
        from overseer.server import DB_PATH

        with sqlite3.connect(str(DB_PATH)) as conn:
            conn.execute(
                "INSERT INTO audit_log "
                "(agent, team_id, action, outcome) VALUES (?, ?, ?, ?)",
                ("ghost", "3042", "test", "success"),
            )
            conn.commit()

        result = register_pair(
            requesting_agent="bridge-0",
            pair_id="p-orphan-audit",
            team_id="3042",
        )
        assert result["status"] == "denied"
        assert "3042" in result["error"]
        assert "audit_log" in result["error"]
        _assert_no_metadata_leak(result)


class TestAllocatorScansAllSurfaces:
    """Allocator must skip team_ids that exist in any team-scoped surface,
    not just messages. Locks the multi-surface scan from PR #9 fixup."""

    def test_allocator_skips_high_team_id_in_heartbeats(self, fresh_db):
        """If a heartbeat exists at team_id 5000 (no pair_registry row,
        no messages), the next auto-allocation must be > 5000."""
        import sqlite3
        from overseer.server import DB_PATH

        with sqlite3.connect(str(DB_PATH)) as conn:
            conn.execute(
                "INSERT INTO heartbeats "
                "(worker, team_id, task_id, progress_pct, current_action, "
                " state, terminal_hash, epoch, timestamp) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("ghost", "5000", "t", 0, "", "idle", "h", 1.0, "2026-05-05"),
            )
            conn.commit()

        first = register_pair(requesting_agent="bridge-0", pair_id="p-skip")
        assert int(first["team_id"]) > 5000

    def test_allocator_skips_high_team_id_in_pane_registry(self, fresh_db):
        import sqlite3
        from overseer.server import DB_PATH

        with sqlite3.connect(str(DB_PATH)) as conn:
            conn.execute(
                "INSERT INTO pane_registry "
                "(agent_name, target, kind, parent, team_id) "
                "VALUES (?, ?, ?, ?, ?)",
                ("ghost-7777", "%99", "session", None, "7777"),
            )
            conn.commit()

        first = register_pair(requesting_agent="bridge-0", pair_id="p-pane")
        assert int(first["team_id"]) > 7777

    def test_allocator_skips_high_team_id_in_audit_log(self, fresh_db):
        import sqlite3
        from overseer.server import DB_PATH

        with sqlite3.connect(str(DB_PATH)) as conn:
            conn.execute(
                "INSERT INTO audit_log "
                "(agent, team_id, action, outcome) VALUES (?, ?, ?, ?)",
                ("ghost", "8888", "test", "success"),
            )
            conn.commit()

        first = register_pair(requesting_agent="bridge-0", pair_id="p-aud")
        assert int(first["team_id"]) > 8888

    def test_allocator_skips_tombstoned_pair_team_id(self, fresh_db):
        """Most important: a tombstoned pair_registry row keeps its team_id
        permanently reserved even after messages/heartbeats/etc are pruned."""
        from overseer.server import unregister_pair

        first = register_pair(
            requesting_agent="bridge-0",
            pair_id="p-tomb",
            team_id="9000",
        )
        unregister_pair(requesting_agent="bridge-0", pair_id="p-tomb")
        # Allocator sees tombstoned 9000 in pair_registry → skips past it.
        second = register_pair(requesting_agent="bridge-0", pair_id="p-after")
        assert int(second["team_id"]) > 9000


# ---------------------------------------------------------------------------
# resolve_pair: cross-pair denied; metadata never leaks in denials
# ---------------------------------------------------------------------------


class TestResolvePairAuthorization:
    def test_non_bridge_cross_pair_lookup_denied(self, two_pairs):
        result = resolve_pair(
            requesting_agent="claude-1042", pair_id="pair-B"
        )
        assert result["status"] == "denied"
        assert "1042" in result["error"]
        assert "1043" in result["error"]
        _assert_no_metadata_leak(result)

    def test_own_pair_lookup_succeeds(self, two_pairs):
        result = resolve_pair(
            requesting_agent="claude-1042", pair_id="pair-A"
        )
        assert result["status"] == "ok"
        assert result["pair"]["team_id"] == "1042"
        # Own-pair lookup IS allowed to expose claude_session etc.
        assert result["pair"]["claude_session"] == "%A1"

    def test_resolve_requires_exactly_one_lookup_key(self, fresh_db):
        a = resolve_pair(requesting_agent="bridge-0")
        b = resolve_pair(requesting_agent="bridge-0", pair_id="p", team_id="1042")
        assert a["status"] == "denied"
        assert b["status"] == "denied"
        _assert_no_metadata_leak(a)
        _assert_no_metadata_leak(b)

    def test_resolve_not_found_returns_dict_not_denial(self, fresh_db):
        result = resolve_pair(
            requesting_agent="bridge-0", pair_id="never-existed"
        )
        assert result["status"] == "not_found"
        assert result["pair_id"] == "never-existed"


# ---------------------------------------------------------------------------
# list_pairs: include_others bridge-only; default own-pair-only
# ---------------------------------------------------------------------------


class TestListPairsAuthorization:
    def test_include_others_denied_for_non_bridge(self, two_pairs):
        result = list_pairs(
            requesting_agent="claude-1042", include_others=True
        )
        assert result["status"] == "denied"
        assert "bridge-0" in result["error"]
        _assert_no_metadata_leak(result)

    def test_default_returns_only_own_pair(self, two_pairs):
        result = list_pairs(requesting_agent="claude-1042")
        assert result["status"] == "ok"
        assert result["count"] == 1
        assert result["pairs"][0]["pair_id"] == "pair-A"
        # No leak of pair-B's metadata anywhere.
        for p in result["pairs"]:
            assert p["team_id"] == "1042"

    def test_bridge_can_list_all(self, two_pairs):
        result = list_pairs(
            requesting_agent="bridge-0", include_others=True
        )
        assert result["status"] == "ok"
        assert result["count"] == 2
        ids = {p["pair_id"] for p in result["pairs"]}
        assert ids == {"pair-A", "pair-B"}


# ---------------------------------------------------------------------------
# unregister_pair: cross-pair denied; bridge can do anything
# ---------------------------------------------------------------------------


class TestUnregisterAuthorization:
    def test_non_owner_unregister_denied(self, two_pairs):
        result = unregister_pair(
            requesting_agent="claude-1042", pair_id="pair-B"
        )
        assert result["status"] == "denied"
        assert "1043" in result["error"]
        assert "1042" in result["error"]
        _assert_no_metadata_leak(result)

    def test_bridge_can_unregister_any(self, two_pairs):
        result = unregister_pair(
            requesting_agent="bridge-0", pair_id="pair-A"
        )
        assert result["status"] == "ok"
        assert result["removed"] is True
