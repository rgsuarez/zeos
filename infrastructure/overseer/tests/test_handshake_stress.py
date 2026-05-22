"""Stress tests for 3-way handshake reliability."""

import json
import sqlite3
import threading
from datetime import datetime, timezone

import pytest

from overseer import server


POLL_INTERVAL_FAST = 0.01


def _setup_db(tmp_path, monkeypatch):
    test_db = tmp_path / "handshake_relay.db"
    monkeypatch.setattr(server, "DB_PATH", test_db)
    monkeypatch.setattr(server, "HANDSHAKE_POLL_INTERVAL", POLL_INTERVAL_FAST)
    server.init_db()
    return test_db


def _insert_message(agent, msg_type, payload, team_id, ref_id=None):
    conn = sqlite3.connect(server.DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
        (agent, json.dumps(payload), msg_type, ref_id, team_id),
    )
    conn.commit()
    msg_id = cursor.lastrowid
    conn.close()
    return msg_id


def _handshake_payload(handshake_id, sender, receiver, timeout_sec=0.2):
    return {
        "handshake_id": handshake_id,
        "sender": sender,
        "receiver": receiver,
        "intent": "test",
        "timeout_sec": timeout_sec,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


class TestExecuteCommandReliable:
    def test_happy_path_handshake(self, tmp_path, monkeypatch):
        _setup_db(tmp_path, monkeypatch)
        monkeypatch.setattr(
            server,
            "detect_state",
            lambda agent: {"state": server.AgentState.IDLE.value},
        )

        receiver_result = {}

        def receiver():
            receiver_result["value"] = server.await_handshake(
                receiver="claude-3",
                timeout=1,
                since_id=0,
            )

        thread = threading.Thread(target=receiver, daemon=True)
        thread.start()

        sender_result = server.execute_command_reliable(
            sender="gemini-3",
            target_agent="claude-3",
            command="echo HANDSHAKE_OK",
            timeout=1,
        )

        thread.join(timeout=2)
        assert thread.is_alive() is False

        assert sender_result["status"] == "connected"
        assert receiver_result["value"]["status"] == "connected"
        assert receiver_result["value"]["command"] == "echo HANDSHAKE_OK"
        assert sender_result["handshake_id"] == receiver_result["value"]["handshake_id"]

        syn_msgs = server._fetch_messages(type_filter="handshake_syn", team_filter="3")
        syn_ack_msgs = server._fetch_messages(type_filter="handshake_syn_ack", team_filter="3")
        ack_msgs = server._fetch_messages(type_filter="handshake_ack", team_filter="3")
        assert len(syn_msgs) == 1
        assert len(syn_ack_msgs) == 1
        assert len(ack_msgs) == 1

    def test_preflight_not_idle(self, tmp_path, monkeypatch):
        _setup_db(tmp_path, monkeypatch)
        monkeypatch.setattr(
            server,
            "detect_state",
            lambda agent: {"state": server.AgentState.WORKING.value},
        )

        result = server.execute_command_reliable(
            sender="gemini-3",
            target_agent="claude-3",
            command="echo BLOCKED",
            timeout=0.2,
        )

        assert result["status"] == "preflight_failed"
        assert "not IDLE" in result["error"]

    def test_cross_team_denied(self, tmp_path, monkeypatch):
        _setup_db(tmp_path, monkeypatch)

        result = server.execute_command_reliable(
            sender="gemini-1",
            target_agent="claude-2",
            command="echo NOPE",
            timeout=0.2,
        )

        assert result["status"] == "denied"
        assert "Cross-team access denied" in result["error"]

    def test_legacy_sender_denied(self, tmp_path, monkeypatch):
        _setup_db(tmp_path, monkeypatch)

        result = server.execute_command_reliable(
            sender="claude",
            target_agent="claude-3",
            command="echo LEGACY",
            timeout=0.2,
        )

        assert result["status"] == "denied"
        assert "no team assignment" in result["error"]

    def test_syn_ack_timeout(self, tmp_path, monkeypatch):
        _setup_db(tmp_path, monkeypatch)
        monkeypatch.setattr(
            server,
            "detect_state",
            lambda agent: {"state": server.AgentState.IDLE.value},
        )

        result = server.execute_command_reliable(
            sender="gemini-3",
            target_agent="claude-3",
            command="echo TIMEOUT",
            timeout=0.05,
        )

        assert result["status"] == "timeout"
        assert result["phase"] == "syn_ack_wait"


class TestAwaitHandshake:
    def test_receiver_busy_returns(self, tmp_path, monkeypatch):
        _setup_db(tmp_path, monkeypatch)
        monkeypatch.setattr(
            server,
            "detect_state",
            lambda agent: {"state": server.AgentState.WORKING.value},
        )

        handshake_id = server._generate_handshake_id("3")
        syn_payload = _handshake_payload(handshake_id, "gemini-3", "claude-3")
        syn_msg_id = _insert_message("gemini-3", "handshake_syn", syn_payload, "3")

        result = server.await_handshake(receiver="claude-3", timeout=0.2, since_id=0)
        assert result["status"] == "busy"
        assert result["handshake_id"] == handshake_id

        syn_ack_msgs = server._fetch_messages(type_filter="handshake_syn_ack", team_filter="3")
        assert len(syn_ack_msgs) == 1
        ack_payload = json.loads(syn_ack_msgs[0]["content"])
        assert ack_payload["ready"] is False
        assert syn_ack_msgs[0]["ref_id"] == syn_msg_id

    def test_ack_timeout(self, tmp_path, monkeypatch):
        _setup_db(tmp_path, monkeypatch)
        monkeypatch.setattr(
            server,
            "detect_state",
            lambda agent: {"state": server.AgentState.IDLE.value},
        )

        handshake_id = server._generate_handshake_id("3")
        syn_payload = _handshake_payload(handshake_id, "gemini-3", "claude-3", timeout_sec=0.05)
        _insert_message("gemini-3", "handshake_syn", syn_payload, "3")

        result = server.await_handshake(receiver="claude-3", timeout=0.2, since_id=0)
        assert result["status"] == "timeout"
        assert result["phase"] == "ack_wait"
        assert result["handshake_id"] == handshake_id

    def test_out_of_order_ack_ignored(self, tmp_path, monkeypatch):
        _setup_db(tmp_path, monkeypatch)
        monkeypatch.setattr(
            server,
            "detect_state",
            lambda agent: {"state": server.AgentState.IDLE.value},
        )

        handshake_id = server._generate_handshake_id("3")
        ack_payload = {
            "handshake_id": handshake_id,
            "sender": "gemini-3",
            "receiver": "claude-3",
            "command": "echo EARLY",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        _insert_message("gemini-3", "handshake_ack", ack_payload, "3")

        syn_payload = _handshake_payload(handshake_id, "gemini-3", "claude-3", timeout_sec=0.05)
        _insert_message("gemini-3", "handshake_syn", syn_payload, "3")

        result = server.await_handshake(receiver="claude-3", timeout=0.2, since_id=0)
        assert result["status"] == "timeout"
        assert result["phase"] == "ack_wait"

    def test_legacy_receiver_denied(self, tmp_path, monkeypatch):
        _setup_db(tmp_path, monkeypatch)

        result = server.await_handshake(receiver="claude", timeout=0.1, since_id=0)
        assert result["status"] == "denied"
        assert "no team assignment" in result["error"]
