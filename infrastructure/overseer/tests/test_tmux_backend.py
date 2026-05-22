"""Tests for unified TmuxBackend agent registry."""

import subprocess
from unittest.mock import patch, MagicMock, call

import pytest
from overseer.tmux_backend import TmuxBackend, AgentEntry, get_backend, _strip_ansi


# Lock these legacy tests to the OS default tmux socket. The multi-socket
# behavior is exercised separately in test_tmux_multi_socket.py; here we only
# care about single-socket semantics, so the existing mocks (which key off
# ``cmd[1] == "has-session"``) keep working unchanged.
@pytest.fixture(autouse=True)
def _single_socket_mode(monkeypatch):
    monkeypatch.setenv("OVERSEER_TMUX_SOCKETS", "default")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_run(returncode=0, stdout="", stderr=""):
    """Create a mock subprocess.CompletedProcess."""
    result = MagicMock(spec=subprocess.CompletedProcess)
    result.returncode = returncode
    result.stdout = stdout
    result.stderr = stderr
    return result


# ---------------------------------------------------------------------------
# TestAgentRegistry — registration and unregistration
# ---------------------------------------------------------------------------

class TestAgentRegistry:
    """Test explicit agent registration API."""

    def test_register_session_agent(self):
        backend = TmuxBackend()
        entry = backend.register_agent("c-4", "c-4", "session")
        assert entry.name == "c-4"
        assert entry.target == "c-4"
        assert entry.kind == "session"
        assert entry.parent is None
        assert "c-4" in backend._agent_registry

    def test_register_pane_agent(self):
        backend = TmuxBackend()
        entry = backend.register_agent("c-4", "%18", "pane", parent="team-4")
        assert entry.target == "%18"
        assert entry.kind == "pane"
        assert entry.parent == "team-4"

    def test_register_overwrites_existing(self):
        backend = TmuxBackend()
        backend.register_agent("c-4", "%18", "pane", parent="team-4")
        backend.register_agent("c-4", "%25", "pane", parent="team-4")
        assert backend._agent_registry["c-4"].target == "%25"

    def test_unregister_existing(self):
        backend = TmuxBackend()
        backend.register_agent("c-4", "c-4", "session")
        assert backend.unregister_agent("c-4") is True
        assert "c-4" not in backend._agent_registry

    def test_unregister_nonexistent(self):
        backend = TmuxBackend()
        assert backend.unregister_agent("nope") is False

    def test_register_team_session(self):
        backend = TmuxBackend()
        backend.register_team_session("team-4")
        assert "team-4" in backend._team_sessions

    def test_unregister_team_purges_pane_agents(self):
        backend = TmuxBackend()
        backend.register_team_session("team-4")
        backend.register_agent("c-4", "%18", "pane", parent="team-4")
        backend.register_agent("g-4", "%19", "pane", parent="team-4")
        backend.register_agent("c-2", "c-2", "session")  # different team

        backend.unregister_team_session("team-4")

        assert "team-4" not in backend._team_sessions
        assert "c-4" not in backend._agent_registry
        assert "g-4" not in backend._agent_registry
        assert "c-2" in backend._agent_registry  # untouched


# ---------------------------------------------------------------------------
# TestResolveTarget — three-tier waterfall
# ---------------------------------------------------------------------------

class TestResolveTarget:
    """Test the three-tier resolution waterfall."""

    def test_tier1_registry_hit(self):
        backend = TmuxBackend()
        backend.register_agent("c-4", "%18", "pane", parent="team-4")
        assert backend.resolve_target("c-4") == "%18"

    @patch("subprocess.run")
    def test_tier2_session_probe(self, mock_run):
        """Agent found as standalone tmux session."""
        mock_run.return_value = _mock_run(returncode=0)
        backend = TmuxBackend()

        target = backend.resolve_target("claude-1")
        assert target == "claude-1"
        # Should auto-register
        assert "claude-1" in backend._agent_registry
        assert backend._agent_registry["claude-1"].kind == "session"

    @patch("subprocess.run")
    def test_tier2_skips_team_prefix(self, mock_run):
        """team-* names should NOT match as session agents."""
        # has-session would succeed, but we skip it for team-* names
        mock_run.return_value = _mock_run(returncode=1)
        backend = TmuxBackend()

        with pytest.raises(KeyError):
            backend.resolve_target("team-4")

    @patch("subprocess.run")
    def test_tier3_pane_title_scan(self, mock_run):
        """Agent found via pane title scan in team session."""
        def side_effect(cmd, **kwargs):
            if cmd[1] == "has-session":
                return _mock_run(returncode=1)  # Not a standalone session
            if cmd[1] == "list-sessions":
                return _mock_run(returncode=0, stdout="team-4\nother-session\n")
            if cmd[1] == "list-panes":
                return _mock_run(returncode=0, stdout="%18\tc-4\n%19\tg-4\n")
            return _mock_run(returncode=0)

        mock_run.side_effect = side_effect
        backend = TmuxBackend()

        target = backend.resolve_target("c-4")
        assert target == "%18"
        assert backend._agent_registry["c-4"].kind == "pane"
        assert backend._agent_registry["c-4"].parent == "team-4"

    @patch("subprocess.run")
    def test_tier3_with_preregistered_team(self, mock_run):
        """Agent found in a pre-registered team session (no discover needed)."""
        def side_effect(cmd, **kwargs):
            if cmd[1] == "has-session":
                return _mock_run(returncode=1)
            if cmd[1] == "list-panes":
                return _mock_run(returncode=0, stdout="%20\tx-4\n%21\tk-4\n")
            return _mock_run(returncode=0)

        mock_run.side_effect = side_effect
        backend = TmuxBackend()
        backend.register_team_session("team-4")

        target = backend.resolve_target("x-4")
        assert target == "%20"

    @patch("subprocess.run")
    def test_not_found_raises_keyerror(self, mock_run):
        """Agent not in registry, not a session, not in any team panes."""
        def side_effect(cmd, **kwargs):
            if cmd[1] == "has-session":
                return _mock_run(returncode=1)
            if cmd[1] == "list-sessions":
                return _mock_run(returncode=0, stdout="team-4\n")
            if cmd[1] == "list-panes":
                return _mock_run(returncode=0, stdout="%18\tc-4\n%19\tg-4\n")
            return _mock_run(returncode=0)

        mock_run.side_effect = side_effect
        backend = TmuxBackend()

        with pytest.raises(KeyError, match="nope"):
            backend.resolve_target("nope")


# ---------------------------------------------------------------------------
# TestListAgents — union of registry + sessions, minus team parents
# ---------------------------------------------------------------------------

class TestListAgents:
    """Test list_agents returns correct union."""

    @patch("subprocess.run")
    def test_lists_registry_and_sessions(self, mock_run):
        def _side_effect(cmd, **kw):
            # list-sessions returns team-4 and standalone
            if "list-sessions" in cmd:
                return _mock_run(returncode=0, stdout="team-4\nstandalone\n")
            # list-panes for team-4 returns pane id + title (pane_id\ttitle format)
            if "list-panes" in cmd:
                return _mock_run(returncode=0, stdout="%18\tc-4\n%19\tg-4\n")
            return _mock_run(returncode=0)

        mock_run.side_effect = _side_effect
        backend = TmuxBackend()
        backend.register_team_session("team-4")
        backend.register_agent("c-4", "%18", "pane", parent="team-4")
        backend.register_agent("g-4", "%19", "pane", parent="team-4")

        agents = backend.list_agents()
        assert "c-4" in agents
        assert "g-4" in agents
        assert "standalone" in agents
        assert "team-4" not in agents  # excluded as team parent

    @patch("subprocess.run")
    def test_empty_when_no_tmux(self, mock_run):
        mock_run.side_effect = FileNotFoundError("tmux not found")
        backend = TmuxBackend()
        assert backend.list_agents() == []


# ---------------------------------------------------------------------------
# TestKillTeam — purges all pane agents
# ---------------------------------------------------------------------------

class TestKillTeam:

    @patch("subprocess.run")
    def test_kill_team_purges_agents(self, mock_run):
        mock_run.return_value = _mock_run(returncode=0)
        backend = TmuxBackend()
        backend.register_team_session("team-4")
        backend.register_agent("c-4", "%18", "pane", parent="team-4")
        backend.register_agent("g-4", "%19", "pane", parent="team-4")

        result = backend.kill_team("team-4")
        assert result is True
        assert "c-4" not in backend._agent_registry
        assert "g-4" not in backend._agent_registry
        assert "team-4" not in backend._team_sessions

    @patch("subprocess.run")
    def test_kill_team_failure(self, mock_run):
        mock_run.return_value = _mock_run(returncode=1)
        backend = TmuxBackend()
        backend.register_team_session("team-4")
        result = backend.kill_team("team-4")
        assert result is False


# ---------------------------------------------------------------------------
# TestCreateAgent — session vs pane creation
# ---------------------------------------------------------------------------

class TestCreateAgent:

    @patch("subprocess.run")
    def test_create_session_agent(self, mock_run):
        mock_run.return_value = _mock_run(returncode=0)
        backend = TmuxBackend()

        target = backend.create_agent("c-2", "claude --model opus")
        assert target == "c-2"
        assert backend._agent_registry["c-2"].kind == "session"

    @patch("subprocess.run")
    def test_create_pane_agent(self, mock_run):
        mock_run.return_value = _mock_run(returncode=0, stdout="%22\n")
        backend = TmuxBackend()

        target = backend.create_agent("c-4", "claude --model opus", parent_session="team-4")
        assert target == "%22"
        assert backend._agent_registry["c-4"].kind == "pane"
        assert backend._agent_registry["c-4"].parent == "team-4"

    @patch("subprocess.run")
    def test_create_pane_agent_failure(self, mock_run):
        mock_run.return_value = _mock_run(returncode=1, stderr="no space for pane")
        backend = TmuxBackend()

        with pytest.raises(RuntimeError, match="Failed to create pane"):
            backend.create_agent("c-4", "claude", parent_session="team-4")


# ---------------------------------------------------------------------------
# TestKillAgent — registry-driven
# ---------------------------------------------------------------------------

class TestKillAgent:

    @patch("subprocess.run")
    def test_kill_pane_agent(self, mock_run):
        mock_run.return_value = _mock_run(returncode=0)
        backend = TmuxBackend()
        backend.register_agent("c-4", "%18", "pane", parent="team-4")

        result = backend.kill_agent("c-4")
        assert result is True
        assert "c-4" not in backend._agent_registry
        # Should use kill-pane, not kill-session
        mock_run.assert_called_with(
            ["tmux", "kill-pane", "-t", "%18"],
            capture_output=True, timeout=5,
        )

    @patch("subprocess.run")
    def test_kill_session_agent(self, mock_run):
        mock_run.return_value = _mock_run(returncode=0)
        backend = TmuxBackend()
        backend.register_agent("c-2", "c-2", "session")

        result = backend.kill_agent("c-2")
        assert result is True
        mock_run.assert_called_with(
            ["tmux", "kill-session", "-t", "c-2"],
            capture_output=True, timeout=5,
        )


# ---------------------------------------------------------------------------
# TestHasAgent — resolves without raising
# ---------------------------------------------------------------------------

class TestHasAgent:

    def test_registered_agent(self):
        backend = TmuxBackend()
        backend.register_agent("c-4", "%18", "pane", parent="team-4")
        assert backend.has_agent("c-4") is True

    @patch("subprocess.run")
    def test_unregistered_missing(self, mock_run):
        # has-session fails, list-sessions finds no team sessions
        def side_effect(cmd, **kwargs):
            return _mock_run(returncode=1)

        mock_run.side_effect = side_effect
        backend = TmuxBackend()
        assert backend.has_agent("nope") is False


# ---------------------------------------------------------------------------
# TestSingleton
# ---------------------------------------------------------------------------

class TestSingleton:

    def test_get_backend_creates_instance(self):
        import overseer.tmux_backend as mod
        mod._backend = None
        backend = get_backend()
        assert isinstance(backend, TmuxBackend)
        assert mod._backend is backend

    def test_get_backend_returns_same_instance(self):
        import overseer.tmux_backend as mod
        mod._backend = None
        b1 = get_backend()
        b2 = get_backend()
        assert b1 is b2


# ---------------------------------------------------------------------------
# TestStripAnsi
# ---------------------------------------------------------------------------

class TestStripAnsi:

    def test_strips_color_codes(self):
        assert _strip_ansi("\x1b[31mRed\x1b[0m") == "Red"

    def test_preserves_plain_text(self):
        assert _strip_ansi("plain") == "plain"
