
import threading
import time
import pytest
from overseer.server import subscribe, post_message, init_db

def test_subscribe_immediate(tmp_path, monkeypatch):
    """Test subscribe returns immediately if messages exist."""
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)

    # Use team-based agent name
    post_message("claude-1", "Existing message")

    # requesting_agent is now required
    result = subscribe(requesting_agent="gemini-1", since_id=0, timeout=1)
    assert result["status"] == "ok"
    assert result["timed_out"] is False
    messages = result["messages"]
    assert result["count"] == 1
    assert len(messages) == 1
    assert messages[0]["content"] == "Existing message"
    assert messages[0]["team_id"] == "1"

def test_subscribe_timeout(tmp_path, monkeypatch):
    """Test subscribe times out if no messages arrive."""
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)

    start = time.time()
    # Use minimal timeout to avoid long test runs (requesting_agent required)
    result = subscribe(requesting_agent="claude-1", since_id=0, timeout=1)
    duration = time.time() - start

    assert result["status"] == "ok"
    assert result["timed_out"] is True
    assert result["count"] == 0
    assert result["messages"] == []
    assert duration >= 1.0
    # With 30s polling interval, timeout can extend to timeout + poll_interval
    # Test just verifies timeout behavior works
    assert duration < 35.0  # Allow for polling interval overhead

def test_subscribe_waits_for_message(tmp_path, monkeypatch):
    """Test subscribe waits and returns when message arrives."""
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)

    def poster():
        time.sleep(1)
        # Use team-based agent name
        post_message("claude-1", "Delayed message")

    t = threading.Thread(target=poster)
    t.start()

    start = time.time()
    # Subscribe with 60s timeout (needs to be > polling interval)
    # Message posts at 1s, but won't be seen until next poll cycle
    # requesting_agent is required
    result = subscribe(requesting_agent="gemini-1", since_id=0, timeout=60)
    duration = time.time() - start

    t.join()

    assert result["status"] == "ok"
    assert result["timed_out"] is False
    messages = result["messages"]
    assert len(messages) == 1
    assert messages[0]["content"] == "Delayed message"
    assert messages[0]["team_id"] == "1"
    # With 30s polling, message posted at 1s won't be seen until ~30s
    assert duration >= 1.0
    assert duration < 35.0  # Should see it within one poll cycle

def test_subscribe_team_isolation(tmp_path, monkeypatch):
    """Test subscribe only returns messages from same team."""
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)

    # Post messages from different teams
    post_message("claude-1", "Team 1 message")
    post_message("claude-2", "Team 2 message")

    # Team 1 subscriber only sees Team 1 messages
    result = subscribe(requesting_agent="gemini-1", since_id=0, timeout=1)
    assert result["status"] == "ok"
    messages = result["messages"]
    assert len(messages) == 1
    assert messages[0]["team_id"] == "1"

def test_subscribe_legacy_denied(tmp_path, monkeypatch):
    """Test legacy agent without team is denied access."""
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)

    result = subscribe(requesting_agent="claude", since_id=0, timeout=1)
    assert result["status"] == "denied"
    assert "no team assignment" in result["error"]
