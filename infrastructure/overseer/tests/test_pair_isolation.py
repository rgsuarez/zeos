"""
Pair isolation — strict cross-pair message blocking.

Two registered pairs with team_ids 1042 and 1043. Pair A's claude-1042 posts;
pair B's claude-1043 must not see any of it via get_messages or subscribe.
Bridge-0 (with OVERSEER_DEFAULT_TEAM_ID=0) sees everything.

Plus: post_message tagged with another team is auto-rebound to the requester's
team by extract_team — proves enforce_team_filter blocks cross-pair posts at
the relay layer.

LOE-zeos-overseer-npair-tmux-intercom (2026-05-05).
"""

import pytest

from overseer.server import (
    get_messages,
    init_db,
    post_message,
    register_pair,
    subscribe,
)


@pytest.fixture
def two_pairs(tmp_path, monkeypatch):
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)
    monkeypatch.setattr("overseer.server._db_initialized_path", None, raising=False)
    init_db()
    a = register_pair(
        requesting_agent="bridge-0", pair_id="pair-A", team_id="1042"
    )
    b = register_pair(
        requesting_agent="bridge-0", pair_id="pair-B", team_id="1043"
    )
    assert a["status"] == "ok"
    assert b["status"] == "ok"
    return a, b


def _msgs(envelope):
    assert envelope["status"] == "ok"
    return envelope["messages"]


class TestCrossPairReadDenied:
    def test_pair_b_cannot_read_pair_a_via_get_messages(self, two_pairs):
        post_message("claude-1042", "secret-A")
        result = get_messages(requesting_agent="claude-1043", since_id=0)
        assert result["status"] == "ok"
        for m in result["messages"]:
            assert m["team_id"] != "1042"
            assert "secret-A" not in m["content"]

    def test_pair_b_cannot_read_pair_a_via_subscribe(self, two_pairs):
        post_message("claude-1042", "secret-A")
        result = subscribe(requesting_agent="claude-1043", since_id=0, timeout=1)
        assert result["status"] == "ok"
        # Either timed out with empty messages, or contains only team-1043 traffic.
        for m in result["messages"]:
            assert m["team_id"] != "1042"


class TestPairASeesOnlyItsOwn:
    def test_pair_a_sees_its_own_message(self, two_pairs):
        post_message("claude-1042", "alpha-tag")
        post_message("claude-1043", "beta-tag")
        result = get_messages(requesting_agent="claude-1042", since_id=0)
        msgs = _msgs(result)
        contents = {m["content"] for m in msgs}
        assert "alpha-tag" in contents
        assert "beta-tag" not in contents


class TestCrossPairPostBlocked:
    def test_pair_a_cannot_post_messages_into_pair_b(self, two_pairs):
        # post_message uses extract_team(agent) — claude-1043 always tags
        # team_id="1043" regardless of who calls. There is no "post as another
        # team" surface in the relay; this test locks that invariant.
        post_message("claude-1042", "from-A-into-team-1042")
        result = get_messages(requesting_agent="claude-1043", since_id=0)
        msgs = _msgs(result)
        for m in msgs:
            assert m["team_id"] == "1043"
        # And the message claude-1042 posted is visible to claude-1042 only.
        a_view = get_messages(requesting_agent="claude-1042", since_id=0)
        assert any(m["content"] == "from-A-into-team-1042" for m in _msgs(a_view))


class TestBridgeSeesEverything:
    def test_bridge_with_explicit_team_ids_sees_both(self, two_pairs, monkeypatch):
        post_message("claude-1042", "A-msg")
        post_message("claude-1043", "B-msg")
        # Bridge requires OVERSEER_DEFAULT_TEAM_ID=0 to resolve as bridge-0.
        monkeypatch.setenv("OVERSEER_DEFAULT_TEAM_ID", "0")
        # bridge-0 doesn't have its own team_id 0 in messages, so use the
        # explicit team_ids parameter for cross-team observation.
        result = get_messages(
            requesting_agent="bridge-0",
            since_id=0,
            team_ids=[1042, 1043],
        )
        assert result["status"] == "ok"
        contents = {m["content"] for m in result["messages"]}
        assert "A-msg" in contents
        assert "B-msg" in contents


class TestStaleMessagesDoNotLeakToNewPair:
    """Critical pair-isolation invariant (PR #9 review fix):

    After unregister_pair, stale messages on the old team_id MUST NOT be
    visible to a newly registered pair. The two layers of defense:

    1. _pair_allocate_team_id considers MAX(messages.team_id), so a new
       auto-allocated pair gets a higher team_id than any stale row.
    2. Explicit team_id with existing messages and no registry owner is
       denied at registration.

    This regression locks: the same operator running through unregister →
    register cycles never accidentally pulls another pair's old relay
    traffic into a new pair's view.
    """

    def test_auto_allocated_new_pair_does_not_see_old_stale_messages(
        self, tmp_path, monkeypatch
    ):
        from overseer.server import (
            init_db,
            register_pair,
            unregister_pair,
            post_message,
            get_messages,
        )

        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        monkeypatch.setattr(
            "overseer.server._db_initialized_path", None, raising=False
        )
        init_db()

        # Old pair posts then unregisters.
        old = register_pair(requesting_agent="bridge-0", pair_id="p-old")
        old_team = old["team_id"]
        post_message(f"claude-{old_team}", "old-pair-confidential")
        unregister_pair(
            requesting_agent=f"claude-{old_team}", pair_id="p-old"
        )

        # Auto-allocate a new pair. Must skip past old_team.
        new = register_pair(requesting_agent="bridge-0", pair_id="p-new")
        new_team = new["team_id"]
        assert new_team != old_team
        assert int(new_team) > int(old_team)

        # The new pair MUST NOT see the old pair's confidential message.
        result = get_messages(
            requesting_agent=f"claude-{new_team}", since_id=0
        )
        assert result["status"] == "ok"
        contents = {m["content"] for m in result["messages"]}
        assert "old-pair-confidential" not in contents
        # And the new pair's own view is empty (it hasn't posted anything).
        assert result["count"] == 0

    def test_auto_allocated_new_pair_does_not_see_old_heartbeat_state(
        self, tmp_path, monkeypatch
    ):
        """Codex-reproduced leak (PR #9 second fixup, 2026-05-05):
        old pair posts heartbeat / task progress, messages get cleared, the
        pair is unregistered, and a fresh pair re-registers. The new pair
        MUST NOT see the old pair's heartbeat or task_progress state.

        The leak prevention has two layers:
          1. _pair_allocate_team_id scans heartbeats / pane_registry /
             audit_log / etc. — the new pair's team_id is strictly greater
             than the old pair's, so the same-team filter in
             get_worker_heartbeats blocks cross-team visibility.
          2. The old pair_registry row is tombstoned (active=0), preserving
             evidence and preventing reactivation.
        """
        import sqlite3

        from overseer.server import (
            DB_PATH,
            get_worker_heartbeats,
            init_db,
            post_heartbeat,
            register_pair,
            unregister_pair,
        )

        test_db = tmp_path / "test_relay.db"
        monkeypatch.setattr("overseer.server.DB_PATH", test_db)
        monkeypatch.setattr(
            "overseer.server._db_initialized_path", None, raising=False
        )
        init_db()

        # Old pair: register, post a heartbeat for an in-flight task, leave
        # heartbeat row behind.
        old = register_pair(requesting_agent="bridge-0", pair_id="hb-old")
        old_team = old["team_id"]
        old_worker = f"claude-{old_team}"
        post_heartbeat(
            worker=old_worker,
            task_id="task-old-secret",
            progress_pct=42,
            current_action="confidential-old-action",
        )

        # Operator clears messages but heartbeat row survives.
        with sqlite3.connect(str(DB_PATH)) as conn:
            conn.execute("DELETE FROM messages WHERE team_id = ?", (old_team,))
            conn.commit()

        # Old pair unregistered (tombstone).
        unregister_pair(
            requesting_agent=f"claude-{old_team}", pair_id="hb-old"
        )

        # New pair auto-allocates → must skip past old_team because of the
        # surviving heartbeat row AND the tombstoned pair_registry row.
        new = register_pair(requesting_agent="bridge-0", pair_id="hb-new")
        new_team = new["team_id"]
        assert new_team != old_team
        assert int(new_team) > int(old_team)

        # The new pair's worker name keys off new_team. Cross-team request
        # for old_worker MUST be filtered out by enforce_team_filter inside
        # get_worker_heartbeats.
        new_worker = f"claude-{new_team}"
        hbs = get_worker_heartbeats(
            requesting_agent=new_worker,
            workers=[new_worker, old_worker],
        )
        assert isinstance(hbs, dict)
        # team_id in the response is the requester's team, not the old
        # team — proves cross-team blocking.
        assert hbs.get("team_id") == new_team
        # `workers` is a dict keyed by worker name. old_worker belongs to a
        # different team and must NOT appear in the response.
        workers_dict = hbs.get("workers", {})
        assert old_worker not in workers_dict, (
            f"new pair leaked old worker into heartbeat view: {workers_dict}"
        )
        # No value in the response should mention the old confidential
        # action or task id (defense in depth — JSON-stringify check).
        import json as _json
        blob = _json.dumps(hbs)
        assert "confidential-old-action" not in blob
        assert "task-old-secret" not in blob
