"""Integration tests for P0 reliability improvements."""

import sqlite3

import pytest

from overseer import server
from overseer.agents import bootstrap_worker as bw


@pytest.mark.skip(reason="Test fixture needs rewrite: registry path mismatch")
def test_idempotency_skip_logs(monkeypatch, tmp_path, capsys):
    """Worker skips tasks already recorded in registry."""
    monkeypatch.setenv("HOME", str(tmp_path))

    # Seed registry with task
    registry = bw.ProcessedTaskRegistry("codex-3")
    registry.add("TEST-IDEM", "success")

    calls = {"count": 0}

    def fake_listen(worker_name, timeout=60, since_id=0):
        calls["count"] += 1
        if calls["count"] == 1:
            return {
                "message_id": 1,
                "task": {
                    "task_id": "TEST-IDEM",
                    "description": "Idempotency test",
                    "assigned_to": "codex-3"
                },
                "timestamp": "2026-01-24T00:00:00Z"
            }
        bw._shutdown_requested = True
        return None

    class DummyWorker:
        def __init__(self, name, safe_mode):
            self.name = name
            self.safe_mode = safe_mode

    monkeypatch.setattr(bw, "listen_for_task_direct", fake_listen)
    monkeypatch.setattr(bw, "post_message_direct", lambda *args, **kwargs: 1)
    monkeypatch.setattr(bw, "CodexWorker", DummyWorker)

    bw._shutdown_requested = False
    try:
        bw.run_worker_loop("codex-3", safe_mode=True, start_since_id=0)
    finally:
        bw._shutdown_requested = False

    out = capsys.readouterr().out
    assert "Skipping processed task" in out


def test_team_fidelity_db_constraint(monkeypatch, tmp_path):
    """DB enforces team_id NOT NULL for relay writes."""
    test_db = tmp_path / "relay.db"
    monkeypatch.setattr(server, "DB_PATH", test_db)
    server.init_db()

    conn = sqlite3.connect(test_db)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO messages (agent, content, type) VALUES (?, ?, ?)",
            ("codex-3", "no team id", "raw")
        )
    conn.close()
