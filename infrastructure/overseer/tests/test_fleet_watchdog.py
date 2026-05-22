"""Tests for fleet idle watchdog (subscribe loop starvation detection)."""

import time
from unittest.mock import patch

import pytest
import overseer.server as server_mod


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def clean_subscribe_registry():
    """Clear subscribe registry before each test."""
    server_mod._subscribe_registry.clear()
    yield
    server_mod._subscribe_registry.clear()


@pytest.fixture
def mock_db(tmp_path, monkeypatch):
    """Use temp database for tests that touch DB."""
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)
    server_mod.init_db()
    return test_db


# ---------------------------------------------------------------------------
# TestSubscribeRegistryPopulated — listen_for_task updates registry
# ---------------------------------------------------------------------------

class TestSubscribeRegistryPopulated:

    def test_listen_populates_registry(self, mock_db):
        """Calling listen_for_task should create a subscribe registry entry."""
        # listen_for_task with very short timeout (1s) — will timeout but register
        result = server_mod.listen_for_task(worker_name="c-4", timeout=1, since_id=0)
        assert result["status"] == "timeout"

        assert "c-4" in server_mod._subscribe_registry
        entry = server_mod._subscribe_registry["c-4"]
        assert entry["team_id"] == "4"
        assert entry["listen_count"] == 1
        assert entry["last_task_received"] is None
        assert entry["first_listen"] > 0

    def test_listen_increments_count(self, mock_db):
        """Multiple listen_for_task calls increment listen_count."""
        server_mod.listen_for_task(worker_name="c-4", timeout=1)
        server_mod.listen_for_task(worker_name="c-4", timeout=1)
        server_mod.listen_for_task(worker_name="c-4", timeout=1)

        assert server_mod._subscribe_registry["c-4"]["listen_count"] == 3


class TestSubscribeRegistryTaskReceived:

    def test_task_match_updates_last_task_received(self, mock_db):
        """When a worker receives a task, last_task_received should be set."""
        import json

        # Pre-populate subscribe registry
        server_mod._subscribe_registry["c-4"] = {
            "first_listen": time.time() - 60,
            "last_listen": time.time(),
            "listen_count": 3,
            "last_task_received": None,
            "team_id": "4",
        }

        # Post a task_assign for c-4
        task_payload = json.dumps({
            "assigned_to": "c-4",
            "task_id": "task-1",
            "description": "Test task"
        })
        server_mod.post_message("director-4", task_payload, msg_type="task_assign")

        # Now listen — should pick up the task
        result = server_mod.listen_for_task(worker_name="c-4", timeout=5, since_id=0)
        assert result["status"] == "task_received"
        assert server_mod._subscribe_registry["c-4"]["last_task_received"] is not None


# ---------------------------------------------------------------------------
# TestWatchFleetIdle — idle detection
# ---------------------------------------------------------------------------

class TestWatchFleetIdle:

    def test_no_alerts_when_all_working(self, mock_db):
        """Workers with recent task activity should not trigger alerts."""
        now = time.time()
        server_mod._subscribe_registry["c-4"] = {
            "first_listen": now - 30,
            "last_listen": now - 5,
            "listen_count": 2,
            "last_task_received": now - 10,
            "team_id": "4",
        }

        result = server_mod.watch_fleet_idle(
            requesting_agent="d-4", idle_threshold=120, timeout=1, check_interval=10
        )
        assert result["status"] == "ok"
        assert len(result["alerts"]) == 0

    def test_idle_no_task_alert(self, mock_db):
        """Worker subscribing > threshold without ever receiving a task → IDLE_NO_TASK."""
        now = time.time()
        server_mod._subscribe_registry["c-4"] = {
            "first_listen": now - 200,
            "last_listen": now - 5,
            "listen_count": 10,
            "last_task_received": None,
            "team_id": "4",
        }

        result = server_mod.watch_fleet_idle(
            requesting_agent="d-4", idle_threshold=120, timeout=1, check_interval=10
        )
        assert result["status"] == "alert"
        assert len(result["alerts"]) == 1
        assert result["alerts"][0]["type"] == "IDLE_NO_TASK"
        assert result["alerts"][0]["worker"] == "c-4"
        assert result["alerts"][0]["idle_seconds"] >= 120

    def test_idle_between_tasks_alert(self, mock_db):
        """Worker finished a task and has been idle > threshold → IDLE_BETWEEN_TASKS."""
        now = time.time()
        server_mod._subscribe_registry["c-4"] = {
            "first_listen": now - 300,
            "last_listen": now - 5,
            "listen_count": 15,
            "last_task_received": now - 200,  # Finished task 200s ago
            "team_id": "4",
        }

        result = server_mod.watch_fleet_idle(
            requesting_agent="d-4", idle_threshold=120, timeout=1, check_interval=10
        )
        assert result["status"] == "alert"
        assert result["alerts"][0]["type"] == "IDLE_BETWEEN_TASKS"

    def test_subscribe_stale_alert(self, mock_db):
        """Worker stopped calling listen_for_task → SUBSCRIBE_STALE."""
        now = time.time()
        server_mod._subscribe_registry["c-4"] = {
            "first_listen": now - 300,
            "last_listen": now - 200,  # Last listen was 200s ago (way past 70s threshold)
            "listen_count": 5,
            "last_task_received": None,
            "team_id": "4",
        }

        result = server_mod.watch_fleet_idle(
            requesting_agent="d-4", idle_threshold=120, timeout=1, check_interval=10
        )
        assert result["status"] == "alert"
        assert result["alerts"][0]["type"] == "SUBSCRIBE_STALE"

    def test_timeout_returns_ok(self, mock_db):
        """No alerts within timeout → returns ok with summary."""
        now = time.time()
        server_mod._subscribe_registry["c-4"] = {
            "first_listen": now - 10,
            "last_listen": now - 2,
            "listen_count": 2,
            "last_task_received": now - 5,
            "team_id": "4",
        }

        result = server_mod.watch_fleet_idle(
            requesting_agent="d-4", idle_threshold=120, timeout=1, check_interval=10
        )
        assert result["status"] == "ok"
        assert "fleet_summary" in result

    def test_team_isolation(self, mock_db):
        """Only returns alerts for same team."""
        now = time.time()
        # Worker on team 4 — idle
        server_mod._subscribe_registry["c-4"] = {
            "first_listen": now - 200,
            "last_listen": now - 5,
            "listen_count": 10,
            "last_task_received": None,
            "team_id": "4",
        }
        # Worker on team 2 — also idle
        server_mod._subscribe_registry["c-2"] = {
            "first_listen": now - 200,
            "last_listen": now - 5,
            "listen_count": 10,
            "last_task_received": None,
            "team_id": "2",
        }

        result = server_mod.watch_fleet_idle(
            requesting_agent="d-4", idle_threshold=120, timeout=1, check_interval=10
        )
        assert result["status"] == "alert"
        workers_alerted = [a["worker"] for a in result["alerts"]]
        assert "c-4" in workers_alerted
        assert "c-2" not in workers_alerted  # Different team

    def test_denies_no_team(self, mock_db):
        """Agent without team suffix is denied."""
        result = server_mod.watch_fleet_idle(
            requesting_agent="claude", idle_threshold=120, timeout=1
        )
        assert result["status"] == "denied"


# ---------------------------------------------------------------------------
# TestRegisterTeamAgents
# ---------------------------------------------------------------------------

class TestRegisterTeamAgents:

    def test_registers_agents(self, mock_db):
        result = server_mod.register_team_agents(
            requesting_agent="d-4",
            team_session="team-4",
            agents={"c-4": "%18", "g-4": "%19", "x-4": "%20"}
        )
        assert result["status"] == "registered"
        assert result["count"] == 3

        backend = server_mod.get_tmux_backend()
        assert "team-4" in backend._team_sessions
        assert backend._agent_registry["c-4"].target == "%18"
        assert backend._agent_registry["c-4"].kind == "pane"
