"""Tests for pane registry SQLite persistence (cross-process agent resolution)."""

import sqlite3
import subprocess
from unittest.mock import MagicMock, patch

import pytest

import overseer.server as server_mod
import overseer.tmux_backend as tmux_mod
from overseer.tmux_backend import TmuxBackend, AgentEntry


# Lock to the OS default tmux socket so we don't pick up the live user's
# sessions on alternate sockets (e.g. zeos-lanes).
@pytest.fixture(autouse=True)
def _single_socket_mode(monkeypatch):
    monkeypatch.setenv("OVERSEER_TMUX_SOCKETS", "default")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def db_path(tmp_path, monkeypatch):
    """Create a temp DB with pane_registry table via init_db()."""
    test_db = tmp_path / "test_relay.db"
    monkeypatch.setattr("overseer.server.DB_PATH", test_db)
    server_mod.init_db()
    return test_db


@pytest.fixture
def backend(db_path):
    """Return a TmuxBackend wired to the test DB."""
    return TmuxBackend(db_path=db_path)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

class TestSchema:

    def test_schema_created(self, db_path):
        """init_db() creates pane_registry table with correct columns."""
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(pane_registry)")
        columns = {row[1] for row in cursor.fetchall()}
        conn.close()

        assert "agent_name" in columns
        assert "target" in columns
        assert "kind" in columns
        assert "parent" in columns
        assert "team_id" in columns
        assert "updated_at" in columns


# ---------------------------------------------------------------------------
# Write-through
# ---------------------------------------------------------------------------

class TestWriteThrough:

    def test_register_persists_to_sqlite(self, backend, db_path):
        """register_agent() writes to DB."""
        backend.register_agent("c-4", "%18", "pane", parent="team-4")

        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT target, kind, parent, team_id FROM pane_registry WHERE agent_name = ?", ("c-4",))
        row = cursor.fetchone()
        conn.close()

        assert row is not None
        assert row[0] == "%18"
        assert row[1] == "pane"
        assert row[2] == "team-4"
        assert row[3] == "4"

    def test_unregister_deletes_from_sqlite(self, backend, db_path):
        """unregister_agent() removes from DB."""
        backend.register_agent("c-4", "%18", "pane", parent="team-4")
        backend.unregister_agent("c-4")

        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM pane_registry WHERE agent_name = ?", ("c-4",))
        count = cursor.fetchone()[0]
        conn.close()

        assert count == 0

    def test_unregister_team_bulk_deletes(self, backend, db_path):
        """Team disband clears all team entries from DB."""
        backend.register_team_session("team-4")
        backend.register_agent("c-4", "%18", "pane", parent="team-4")
        backend.register_agent("g-4", "%19", "pane", parent="team-4")
        backend.register_agent("x-4", "%20", "pane", parent="team-4")

        backend.unregister_team_session("team-4")

        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM pane_registry WHERE parent = ?", ("team-4",))
        count = cursor.fetchone()[0]
        conn.close()

        assert count == 0

    def test_register_overwrites(self, backend, db_path):
        """Re-register same agent updates target."""
        backend.register_agent("c-4", "%18", "pane", parent="team-4")
        backend.register_agent("c-4", "%25", "pane", parent="team-4")

        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT target FROM pane_registry WHERE agent_name = ?", ("c-4",))
        row = cursor.fetchone()
        conn.close()

        assert row[0] == "%25"


# ---------------------------------------------------------------------------
# Cross-process resolution
# ---------------------------------------------------------------------------

class TestCrossProcess:

    def test_cross_process_resolve(self, db_path):
        """Backend A registers -> fresh Backend B resolves via SQLite."""
        # Backend A registers
        backend_a = TmuxBackend(db_path=db_path)
        backend_a.register_agent("c-4", "%18", "pane", parent="team-4")

        # Backend B is a completely fresh instance
        backend_b = TmuxBackend(db_path=db_path)
        assert "c-4" not in backend_b._agent_registry

        target = backend_b.resolve_target("c-4")
        assert target == "%18"

    def test_resolve_hydrates_cache(self, db_path):
        """After SQLite hit, in-memory cache is populated for O(1) next call."""
        backend_a = TmuxBackend(db_path=db_path)
        backend_a.register_agent("c-4", "%18", "pane", parent="team-4")

        backend_b = TmuxBackend(db_path=db_path)
        backend_b.resolve_target("c-4")

        # Now it should be in the in-memory registry
        assert "c-4" in backend_b._agent_registry
        entry = backend_b._agent_registry["c-4"]
        assert entry.target == "%18"
        assert entry.kind == "pane"
        assert entry.parent == "team-4"

        # Parent session should also be tracked
        assert "team-4" in backend_b._team_sessions


# ---------------------------------------------------------------------------
# list_agents
# ---------------------------------------------------------------------------

class TestListAgents:

    def test_list_agents_includes_sqlite(self, db_path):
        """list_agents() returns agents from both memory and DB."""
        backend_a = TmuxBackend(db_path=db_path)
        backend_a.register_agent("c-4", "%18", "pane", parent="team-4")

        backend_b = TmuxBackend(db_path=db_path)

        # Mock tmux so list-sessions reports 'team-4' as live (so the SQLite
        # check that requires parent in live_sessions succeeds).
        def fake_run(cmd, **_):
            result = MagicMock(spec=subprocess.CompletedProcess)
            result.returncode = 0
            result.stderr = ""
            if cmd[1:3] == ["list-sessions", "-F"]:
                result.stdout = "team-4\n"
            elif cmd[1:3] == ["list-panes", "-t"]:
                result.stdout = "%18\tc-4\n"
            else:
                result.stdout = ""
            return result

        with patch("overseer.tmux_backend.subprocess.run", side_effect=fake_run):
            agents = backend_b.list_agents()
        assert "c-4" in agents


# ---------------------------------------------------------------------------
# Pure in-memory mode
# ---------------------------------------------------------------------------

class TestPureInMemory:

    def test_pure_inmemory_mode(self):
        """TmuxBackend() (no db_path) works identically — no SQLite calls."""
        backend = TmuxBackend()  # No db_path
        assert backend._db_path is None
        assert backend._get_db() is None

        # Registration works purely in-memory
        backend.register_agent("c-4", "%18", "pane", parent="team-4")
        assert "c-4" in backend._agent_registry

        backend.unregister_agent("c-4")
        assert "c-4" not in backend._agent_registry

    def test_extract_team(self):
        """_extract_team correctly parses agent names."""
        assert TmuxBackend._extract_team("c-4") == "4"
        assert TmuxBackend._extract_team("director-12") == "12"
        assert TmuxBackend._extract_team("claude") is None
        assert TmuxBackend._extract_team("team-session") is None
