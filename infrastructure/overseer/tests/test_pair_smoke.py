"""
10-pair end-to-end smoke — proves zero cross-pair receipt.

Registers 10 pairs (pair-smoke-0 … pair-smoke-9). Each pair posts a unique
tag (smoke-{i}-{uuid}) as its claude-<team_id>. Each pair reads via
get_messages and subscribe. Asserts every pair sees exactly 1 message
containing its own tag and zero foreign tags. Bridge view returns 10 entries.

LOE-zeos-overseer-npair-tmux-intercom (2026-05-05).
"""

import uuid

import pytest

from overseer.server import (
    get_messages,
    init_db,
    list_pairs,
    post_message,
    register_pair,
    subscribe,
)


N_PAIRS = 10


@pytest.fixture
def smoke_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)
    monkeypatch.setattr("overseer.server._db_initialized_path", None, raising=False)
    init_db()
    return test_db


def test_ten_pair_isolation_smoke(smoke_db):
    """The headline LOE invariant: 10 pairs, zero cross-receipt."""
    # 1. Register N pairs.
    pairs = []
    for i in range(N_PAIRS):
        result = register_pair(
            requesting_agent="bridge-0",
            pair_id=f"pair-smoke-{i}",
            claude_session=f"%C{i}",
            codex_session=f"%X{i}",
            socket="zeos-lanes",
            description=f"smoke pair {i}",
        )
        assert result["status"] == "ok", f"register_pair {i} failed: {result}"
        pairs.append(result)

    team_ids = [p["team_id"] for p in pairs]
    assert len(set(team_ids)) == N_PAIRS, "team_ids must be unique"

    # 2. Each pair posts a unique tag as its claude-<team_id>.
    tags = {}
    for i, p in enumerate(pairs):
        tag = f"smoke-{i}-{uuid.uuid4().hex[:12]}"
        tags[p["team_id"]] = tag
        post_result = post_message(f"claude-{p['team_id']}", tag)
        assert post_result["status"] == "posted"
        assert post_result["team_id"] == p["team_id"]

    # 3. Bridge view: all 10 pairs visible.
    bridge_view = list_pairs(requesting_agent="bridge-0", include_others=True)
    assert bridge_view["status"] == "ok"
    assert bridge_view["count"] == N_PAIRS

    # 4. Per-pair read invariant: every pair sees its own tag, zero foreign tags.
    foreign_receipts = []
    for p in pairs:
        team_id = p["team_id"]
        own_tag = tags[team_id]
        # via get_messages
        gm = get_messages(requesting_agent=f"claude-{team_id}", since_id=0)
        assert gm["status"] == "ok"
        gm_contents = {m["content"] for m in gm["messages"]}
        assert own_tag in gm_contents, (
            f"pair {team_id} cannot see own tag {own_tag}"
        )
        for foreign_team, foreign_tag in tags.items():
            if foreign_team == team_id:
                continue
            if foreign_tag in gm_contents:
                foreign_receipts.append(
                    f"pair {team_id} saw foreign tag {foreign_tag} "
                    f"(from team {foreign_team})"
                )

        # via subscribe (immediate-hit path)
        sub = subscribe(
            requesting_agent=f"claude-{team_id}",
            since_id=0,
            timeout=1,
        )
        assert sub["status"] == "ok"
        sub_contents = {m["content"] for m in sub["messages"]}
        assert own_tag in sub_contents
        for foreign_team, foreign_tag in tags.items():
            if foreign_team == team_id:
                continue
            if foreign_tag in sub_contents:
                foreign_receipts.append(
                    f"pair {team_id} saw foreign tag {foreign_tag} via subscribe "
                    f"(from team {foreign_team})"
                )

    assert not foreign_receipts, (
        "Cross-pair receipts detected (pair isolation broken):\n"
        + "\n".join(foreign_receipts)
    )

    # 5. Per-pair message count: each pair sees ONLY its own message.
    for p in pairs:
        gm = get_messages(requesting_agent=f"claude-{p['team_id']}", since_id=0)
        assert gm["count"] == 1, (
            f"pair {p['team_id']} expected exactly 1 message, "
            f"got {gm['count']}: {gm['messages']}"
        )
