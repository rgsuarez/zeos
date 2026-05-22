"""
Pair registry — happy-path + state semantics tests.

Covers:
- register_pair happy path (auto-allocation + explicit team_id)
- idempotent re-registration (returns same team_id; created=False; no rebind)
- auto-allocation monotonicity
- OVERSEER_PAIR_TEAM_ID_BASE env override
- UNIQUE collision rejection
- non-numeric team_id rejection
- pair_id required, requesting_agent required
- update of participant fields on idempotent re-registration

LOE-zeos-overseer-npair-tmux-intercom (2026-05-05).
"""

import pytest

from overseer.server import (
    init_db,
    register_pair,
    resolve_pair,
    unregister_pair,
    _pair_team_id_base,
)


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)
    monkeypatch.setattr("overseer.server._db_initialized_path", None, raising=False)
    init_db()
    return test_db


class TestPairTeamIdBase:
    def test_default_is_1000(self, monkeypatch):
        monkeypatch.delenv("OVERSEER_PAIR_TEAM_ID_BASE", raising=False)
        assert _pair_team_id_base() == 1000

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("OVERSEER_PAIR_TEAM_ID_BASE", "5000")
        assert _pair_team_id_base() == 5000

    def test_non_numeric_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("OVERSEER_PAIR_TEAM_ID_BASE", "not-a-number")
        assert _pair_team_id_base() == 1000

    def test_non_positive_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("OVERSEER_PAIR_TEAM_ID_BASE", "0")
        assert _pair_team_id_base() == 1000


class TestRegisterPairAutoAllocation:
    def test_register_pair_auto_allocates_first_team_at_base(self, fresh_db):
        result = register_pair(
            requesting_agent="bridge-0",
            pair_id="pair-alpha",
            claude_session="%7",
            codex_session="%8",
            socket="zeos-lanes",
        )
        assert result["status"] == "ok"
        assert result["created"] is True
        assert result["auto_allocated"] is True
        assert result["pair_id"] == "pair-alpha"
        assert result["team_id"] == "1000"
        assert result["claude_session"] == "%7"
        assert result["codex_session"] == "%8"
        assert result["socket"] == "zeos-lanes"

    def test_auto_allocation_is_monotonic(self, fresh_db):
        a = register_pair(requesting_agent="bridge-0", pair_id="p-a")
        b = register_pair(requesting_agent="bridge-0", pair_id="p-b")
        c = register_pair(requesting_agent="bridge-0", pair_id="p-c")
        assert int(a["team_id"]) == 1000
        assert int(b["team_id"]) == 1001
        assert int(c["team_id"]) == 1002

    def test_auto_allocation_respects_base_env(self, fresh_db, monkeypatch):
        monkeypatch.setenv("OVERSEER_PAIR_TEAM_ID_BASE", "5000")
        result = register_pair(requesting_agent="bridge-0", pair_id="p-base")
        assert result["team_id"] == "5000"

    def test_auto_allocation_clamps_to_base_when_lower_max(
        self, fresh_db, monkeypatch
    ):
        # First allocate at base 1000.
        first = register_pair(requesting_agent="bridge-0", pair_id="p-low")
        assert first["team_id"] == "1000"
        # Bump base; next allocation should jump to new base, not 1001.
        monkeypatch.setenv("OVERSEER_PAIR_TEAM_ID_BASE", "5000")
        second = register_pair(requesting_agent="bridge-0", pair_id="p-high")
        assert second["team_id"] == "5000"


class TestRegisterPairExplicit:
    def test_register_pair_with_explicit_team_id(self, fresh_db):
        result = register_pair(
            requesting_agent="claude-1042",
            pair_id="pair-explicit",
            team_id="1042",
        )
        assert result["status"] == "ok"
        assert result["created"] is True
        assert result["team_id"] == "1042"

    def test_unique_collision_rejected(self, fresh_db):
        register_pair(requesting_agent="bridge-0", pair_id="p-a", team_id="1042")
        result = register_pair(
            requesting_agent="claude-1042",
            pair_id="p-b",
            team_id="1042",
        )
        assert result["status"] == "denied"
        assert "1042" in result["error"]
        assert "p-a" in result["error"]

    def test_non_numeric_team_id_rejected(self, fresh_db):
        result = register_pair(
            requesting_agent="bridge-0",
            pair_id="p-bad",
            team_id="not-numeric",
        )
        assert result["status"] == "denied"
        assert "team_id must be numeric" in result["error"]


class TestIdempotentReRegistration:
    def test_re_register_same_pair_returns_same_team_id(self, fresh_db):
        first = register_pair(
            requesting_agent="bridge-0",
            pair_id="pair-idem",
            claude_session="%1",
        )
        assert first["created"] is True
        team_id = first["team_id"]

        second = register_pair(
            requesting_agent=f"claude-{team_id}",
            pair_id="pair-idem",
            claude_session="%99",
        )
        assert second["status"] == "ok"
        assert second["created"] is False
        assert second["team_id"] == team_id

    def test_re_register_updates_participant_fields(self, fresh_db):
        first = register_pair(
            requesting_agent="bridge-0",
            pair_id="pair-update",
            claude_session="%1",
            codex_session="%2",
        )
        team_id = first["team_id"]
        register_pair(
            requesting_agent=f"claude-{team_id}",
            pair_id="pair-update",
            claude_session="%50",
            codex_session="%51",
            description="new note",
        )
        resolved = resolve_pair(
            requesting_agent=f"claude-{team_id}", pair_id="pair-update"
        )
        assert resolved["status"] == "ok"
        assert resolved["pair"]["claude_session"] == "%50"
        assert resolved["pair"]["codex_session"] == "%51"
        assert resolved["pair"]["description"] == "new note"

    def test_re_register_with_different_team_id_denied(self, fresh_db):
        first = register_pair(
            requesting_agent="bridge-0",
            pair_id="pair-rebind",
        )
        original_team = first["team_id"]
        # Bridge attempts rebind: still denied (immutable team_id).
        rebind = register_pair(
            requesting_agent="bridge-0",
            pair_id="pair-rebind",
            team_id="9999",
        )
        assert rebind["status"] == "denied"
        assert original_team in rebind["error"]
        assert "9999" in rebind["error"]
        assert "cannot rebind" in rebind["error"]


class TestRequiredArgs:
    def test_empty_requesting_agent_denied(self, fresh_db):
        result = register_pair(requesting_agent="", pair_id="p-x")
        assert result["status"] == "denied"
        assert "requesting_agent is required" in result["error"]

    def test_empty_pair_id_denied(self, fresh_db):
        result = register_pair(requesting_agent="bridge-0", pair_id="")
        assert result["status"] == "denied"
        assert "pair_id is required" in result["error"]


class TestUnregisterPair:
    def test_unregister_existing_pair(self, fresh_db):
        first = register_pair(requesting_agent="bridge-0", pair_id="p-bye")
        team_id = first["team_id"]
        result = unregister_pair(
            requesting_agent=f"claude-{team_id}", pair_id="p-bye"
        )
        assert result["status"] == "ok"
        assert result["removed"] is True

    def test_unregister_missing_pair_returns_removed_false(self, fresh_db):
        result = unregister_pair(
            requesting_agent="bridge-0", pair_id="never-registered"
        )
        assert result["status"] == "ok"
        assert result["removed"] is False

    def test_team_id_not_reused_while_stale_messages_exist(self, fresh_db):
        """Critical pair-isolation invariant (PR #9 review fix):

        After unregister_pair, the registry row is gone but messages on that
        team_id can survive until the 24h TTL prunes them. A new pair MUST
        NOT be allocated the same team_id while those stale messages still
        exist — otherwise the new pair would inherit the old pair's relay
        traffic. Cross-pair spillover.
        """
        from overseer.server import post_message

        first = register_pair(requesting_agent="bridge-0", pair_id="p-1")
        first_team = first["team_id"]
        assert first_team == "1000"

        # Old pair leaves messages behind on team 1000.
        post_message(f"claude-{first_team}", "stale message")

        # Pair is unregistered (registry row gone) — but messages remain.
        unregister_pair(
            requesting_agent=f"claude-{first_team}", pair_id="p-1"
        )

        # New pair MUST NOT inherit team 1000.
        second = register_pair(requesting_agent="bridge-0", pair_id="p-2")
        assert second["team_id"] != first_team, (
            f"team_id {first_team} reused while stale messages still exist"
        )
        assert int(second["team_id"]) > int(first_team)

    def test_team_id_never_reused_even_when_no_messages_exist(self, fresh_db):
        """Pair team_ids are durable, non-recycled reservations.

        PR #9 second fixup (2026-05-05): unregister_pair now tombstones
        the row (active=0) instead of DELETE. The allocator scans every
        team-scoped surface — including tombstoned pair_registry rows —
        so the team_id is NEVER reused, even when messages/heartbeats/
        cursors/etc. are all empty. Reactivation is a separate LOE.
        """
        first = register_pair(requesting_agent="bridge-0", pair_id="p-1")
        assert first["team_id"] == "1000"
        # No messages were posted; unregister and re-register a new pair.
        unregister_pair(
            requesting_agent=f"claude-{first['team_id']}", pair_id="p-1"
        )
        second = register_pair(requesting_agent="bridge-0", pair_id="p-2")
        # Tombstone reservation: 1000 stays retired, allocator advances.
        assert second["team_id"] != "1000"
        assert int(second["team_id"]) > 1000

    def test_unregister_tombstones_row_instead_of_deleting(self, fresh_db):
        """unregister_pair must preserve evidence — sets active=0,
        unregistered_at=NOW. The row stays in pair_registry."""
        from overseer.server import resolve_pair

        first = register_pair(requesting_agent="bridge-0", pair_id="p-tomb")
        team_id = first["team_id"]
        unregister_pair(
            requesting_agent=f"claude-{team_id}", pair_id="p-tomb"
        )
        # Bridge can still resolve a tombstoned pair (evidence stays visible).
        resolved = resolve_pair(
            requesting_agent="bridge-0", pair_id="p-tomb"
        )
        assert resolved["status"] == "ok"
        assert resolved["pair"]["pair_id"] == "p-tomb"
        assert resolved["pair"]["active"] == 0
        assert resolved["pair"]["unregistered_at"] is not None

    def test_re_register_tombstoned_pair_id_denied(self, fresh_db):
        """Reactivation of a tombstoned pair_id is out of scope — denied."""
        first = register_pair(requesting_agent="bridge-0", pair_id="p-retired")
        team_id = first["team_id"]
        unregister_pair(
            requesting_agent=f"claude-{team_id}", pair_id="p-retired"
        )
        # Owner attempts to revive — denied.
        revive_owner = register_pair(
            requesting_agent=f"claude-{team_id}",
            pair_id="p-retired",
        )
        assert revive_owner["status"] == "denied"
        assert "retired" in revive_owner["error"]
        # Bridge attempts to revive — also denied.
        revive_bridge = register_pair(
            requesting_agent="bridge-0", pair_id="p-retired"
        )
        assert revive_bridge["status"] == "denied"
        assert "retired" in revive_bridge["error"]

    def test_unregister_idempotent_on_tombstone(self, fresh_db):
        """Unregistering an already-tombstoned pair_id returns removed=False."""
        first = register_pair(requesting_agent="bridge-0", pair_id="p-twice")
        team_id = first["team_id"]
        first_unreg = unregister_pair(
            requesting_agent=f"claude-{team_id}", pair_id="p-twice"
        )
        assert first_unreg["removed"] is True
        again = unregister_pair(
            requesting_agent="bridge-0", pair_id="p-twice"
        )
        assert again["status"] == "ok"
        assert again["removed"] is False
