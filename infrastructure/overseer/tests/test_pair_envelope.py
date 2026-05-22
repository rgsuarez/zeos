"""
Pair tools — envelope shape regression (Codex-safe).

All four pair tools MUST return a flat dict on every code path. No top-level
list returns (which Codex's rmcp client rejects as 'Unexpected response type').
Empty / not-found / denial paths still return dict envelopes.

LOE-zeos-overseer-npair-tmux-intercom (2026-05-05).
"""

import json

import pytest

from overseer.server import (
    init_db,
    list_pairs,
    register_pair,
    resolve_pair,
    unregister_pair,
)


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)
    monkeypatch.setattr("overseer.server._db_initialized_path", None, raising=False)
    init_db()
    return test_db


def _is_dict_envelope(value) -> bool:
    return isinstance(value, dict) and "status" in value


class TestRegisterPairEnvelope:
    def test_success_returns_dict(self, fresh_db):
        result = register_pair(requesting_agent="bridge-0", pair_id="p")
        assert _is_dict_envelope(result)
        assert result["status"] == "ok"
        json.dumps(result)  # Must serialize cleanly.

    def test_idempotent_returns_dict(self, fresh_db):
        register_pair(requesting_agent="bridge-0", pair_id="p")
        again = register_pair(requesting_agent="bridge-0", pair_id="p")
        assert _is_dict_envelope(again)

    def test_denial_returns_dict(self, fresh_db):
        result = register_pair(requesting_agent="", pair_id="p")
        assert _is_dict_envelope(result)
        assert result["status"] == "denied"


class TestUnregisterPairEnvelope:
    def test_success_returns_dict(self, fresh_db):
        register_pair(requesting_agent="bridge-0", pair_id="p")
        result = unregister_pair(requesting_agent="bridge-0", pair_id="p")
        assert _is_dict_envelope(result)

    def test_missing_returns_dict(self, fresh_db):
        result = unregister_pair(requesting_agent="bridge-0", pair_id="ghost")
        assert _is_dict_envelope(result)
        assert result["removed"] is False

    def test_denial_returns_dict(self, fresh_db):
        result = unregister_pair(requesting_agent="", pair_id="p")
        assert _is_dict_envelope(result)


class TestListPairsEnvelope:
    def test_empty_returns_dict_with_pairs_list(self, fresh_db):
        result = list_pairs(requesting_agent="bridge-0", include_others=True)
        assert _is_dict_envelope(result)
        assert result["status"] == "ok"
        assert isinstance(result["pairs"], list)
        assert result["pairs"] == []
        assert result["count"] == 0

    def test_own_pair_only_returns_dict(self, fresh_db):
        register_pair(requesting_agent="bridge-0", pair_id="p", team_id="1042")
        result = list_pairs(requesting_agent="claude-1042")
        assert _is_dict_envelope(result)
        assert isinstance(result["pairs"], list)
        json.dumps(result)


class TestResolvePairEnvelope:
    def test_found_returns_dict(self, fresh_db):
        register_pair(requesting_agent="bridge-0", pair_id="p")
        result = resolve_pair(requesting_agent="bridge-0", pair_id="p")
        assert _is_dict_envelope(result)

    def test_not_found_returns_dict(self, fresh_db):
        result = resolve_pair(requesting_agent="bridge-0", pair_id="ghost")
        assert _is_dict_envelope(result)
        assert result["status"] == "not_found"

    def test_denial_returns_dict(self, fresh_db):
        result = resolve_pair(requesting_agent="", pair_id="p")
        assert _is_dict_envelope(result)


class TestNoTopLevelLists:
    """Regression — every code path of every pair tool returns a dict."""

    def test_register_pair_never_returns_list(self, fresh_db):
        outputs = [
            register_pair(requesting_agent="bridge-0", pair_id="p1"),
            register_pair(requesting_agent="bridge-0", pair_id="p1"),  # idempotent
            register_pair(requesting_agent="", pair_id="x"),  # denial
            register_pair(requesting_agent="bridge-0", pair_id="p2", team_id="42"),  # low
            register_pair(requesting_agent="bridge-0", pair_id="p3", team_id="abc"),  # non-numeric
        ]
        for o in outputs:
            assert isinstance(o, dict)
            assert not isinstance(o, list)

    def test_list_pairs_never_returns_list(self, fresh_db):
        register_pair(requesting_agent="bridge-0", pair_id="p")
        outputs = [
            list_pairs(requesting_agent="bridge-0", include_others=True),
            list_pairs(requesting_agent="bridge-0", include_others=False),
            list_pairs(requesting_agent="", include_others=False),  # denial
            list_pairs(requesting_agent="claude", include_others=False),  # bare
        ]
        for o in outputs:
            assert isinstance(o, dict)
            assert not isinstance(o, list)

    def test_resolve_pair_never_returns_list(self, fresh_db):
        register_pair(requesting_agent="bridge-0", pair_id="p")
        outputs = [
            resolve_pair(requesting_agent="bridge-0", pair_id="p"),
            resolve_pair(requesting_agent="bridge-0", pair_id="ghost"),
            resolve_pair(requesting_agent="", pair_id="p"),
            resolve_pair(requesting_agent="bridge-0"),  # missing key
        ]
        for o in outputs:
            assert isinstance(o, dict)
            assert not isinstance(o, list)

    def test_unregister_pair_never_returns_list(self, fresh_db):
        register_pair(requesting_agent="bridge-0", pair_id="p")
        outputs = [
            unregister_pair(requesting_agent="bridge-0", pair_id="p"),
            unregister_pair(requesting_agent="bridge-0", pair_id="ghost"),
            unregister_pair(requesting_agent="", pair_id="p"),
        ]
        for o in outputs:
            assert isinstance(o, dict)
            assert not isinstance(o, list)
