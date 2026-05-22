"""
Multi-socket tmux discovery tests.

Codex agents that live inside paired lanes run under
``tmux -L zeos-lanes``. The default OS tmux socket is invisible to lane-
pair sessions and vice versa. This test suite confirms TmuxBackend now
enumerates multiple sockets, resolves agents on either socket, and threads
``-L <socket>`` through send_keys / capture-pane operations.

LOE: LOE-zeos-overseer-codex-relay-compat (2026-05-04).
"""

import subprocess
from unittest.mock import patch

import pytest

from overseer.tmux_backend import (
    DEFAULT_SOCKETS,
    SOCKET_ENV_VAR,
    TmuxBackend,
    _tmux_cmd,
    configured_sockets,
)


# ---------------------------------------------------------------------------
# Socket configuration
# ---------------------------------------------------------------------------


class TestConfiguredSockets:
    def test_default_sockets_is_default_plus_zeos_lanes(self, monkeypatch):
        monkeypatch.delenv(SOCKET_ENV_VAR, raising=False)
        assert configured_sockets() == ["default", "zeos-lanes"]
        assert configured_sockets() == list(DEFAULT_SOCKETS)

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv(SOCKET_ENV_VAR, "default,team-server,zeos-lanes")
        assert configured_sockets() == ["default", "team-server", "zeos-lanes"]

    def test_env_dedupes_and_strips(self, monkeypatch):
        monkeypatch.setenv(SOCKET_ENV_VAR, "default, default ,foo, foo,")
        assert configured_sockets() == ["default", "foo"]

    def test_empty_env_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv(SOCKET_ENV_VAR, "  ")
        assert configured_sockets() == list(DEFAULT_SOCKETS)


class TestTmuxCmd:
    def test_default_socket_no_flag(self):
        assert _tmux_cmd("default", "list-sessions") == ["tmux", "list-sessions"]

    def test_named_socket_injects_minus_L(self):
        assert _tmux_cmd("zeos-lanes", "list-sessions") == [
            "tmux", "-L", "zeos-lanes", "list-sessions",
        ]

    def test_empty_socket_treated_as_default(self):
        assert _tmux_cmd("", "list-sessions") == ["tmux", "list-sessions"]


# ---------------------------------------------------------------------------
# Discovery + resolution across sockets
# ---------------------------------------------------------------------------


def _mk_completed(stdout: str = "", returncode: int = 0):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout)


class TestResolveAcrossSockets:
    def test_resolve_on_default_socket(self, monkeypatch):
        monkeypatch.setenv(SOCKET_ENV_VAR, "default,zeos-lanes")
        backend = TmuxBackend()

        recorded: list[list[str]] = []

        def fake_run(cmd, **_):
            recorded.append(cmd)
            # has-session on the unflagged default socket returns 0 for the agent
            if cmd[:2] == ["tmux", "has-session"]:
                return _mk_completed(returncode=0)
            return _mk_completed(returncode=1)

        with patch("overseer.tmux_backend.subprocess.run", side_effect=fake_run):
            entry = backend.resolve_entry("claude-1")
        assert entry.target == "claude-1"
        assert entry.socket == "default"
        # First probe must be on default socket (no -L flag)
        assert recorded[0] == ["tmux", "has-session", "-t", "claude-1"]

    def test_resolve_on_zeos_lanes_socket(self, monkeypatch):
        monkeypatch.setenv(SOCKET_ENV_VAR, "default,zeos-lanes")
        backend = TmuxBackend()

        def fake_run(cmd, **_):
            # Default socket (no -L flag) — agent not present
            if cmd[:2] == ["tmux", "has-session"]:
                return _mk_completed(returncode=1)
            # zeos-lanes socket — agent present
            if cmd[:4] == ["tmux", "-L", "zeos-lanes", "has-session"]:
                return _mk_completed(returncode=0)
            return _mk_completed(returncode=1)

        with patch("overseer.tmux_backend.subprocess.run", side_effect=fake_run):
            entry = backend.resolve_entry("codex-1")
        assert entry.target == "codex-1"
        assert entry.socket == "zeos-lanes"

    def test_resolve_keyerror_when_missing_on_all_sockets(self, monkeypatch):
        monkeypatch.setenv(SOCKET_ENV_VAR, "default,zeos-lanes")
        backend = TmuxBackend()

        with patch(
            "overseer.tmux_backend.subprocess.run",
            return_value=_mk_completed(returncode=1),
        ):
            with pytest.raises(KeyError) as exc_info:
                backend.resolve_entry("ghost-1")
        msg = str(exc_info.value)
        assert "default" in msg and "zeos-lanes" in msg


class TestSendKeysSocketAware:
    def test_send_keys_uses_resolved_socket(self, monkeypatch):
        monkeypatch.setenv(SOCKET_ENV_VAR, "default,zeos-lanes")
        backend = TmuxBackend()
        # Pre-register on the zeos-lanes socket
        backend.register_agent("codex-1", "codex-1", "session", socket="zeos-lanes")

        calls: list[list[str]] = []

        def fake_run(cmd, **_):
            calls.append(cmd)
            return _mk_completed(returncode=0)

        with patch("overseer.tmux_backend.subprocess.run", side_effect=fake_run):
            backend.send_keys("codex-1", "echo hi", "C-m")

        assert calls == [
            ["tmux", "-L", "zeos-lanes", "send-keys", "-t", "codex-1", "echo hi", "C-m"]
        ]

    def test_capture_output_uses_resolved_socket(self, monkeypatch):
        monkeypatch.setenv(SOCKET_ENV_VAR, "default,zeos-lanes")
        backend = TmuxBackend()
        backend.register_agent("codex-1", "codex-1", "session", socket="zeos-lanes")

        def fake_run(cmd, **_):
            assert cmd[:3] == ["tmux", "-L", "zeos-lanes"]
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="output\n")

        with patch("overseer.tmux_backend.subprocess.run", side_effect=fake_run):
            text = backend.capture_output("codex-1", lines=10)
        assert text == "output"


class TestListAgentsAcrossSockets:
    def test_list_agents_unions_sockets_and_registers_socket(self, monkeypatch):
        monkeypatch.setenv(SOCKET_ENV_VAR, "default,zeos-lanes")
        backend = TmuxBackend()

        def fake_run(cmd, **_):
            if cmd == ["tmux", "list-sessions", "-F", "#{session_name}"]:
                return _mk_completed(stdout="claude-1\n")
            if cmd == [
                "tmux", "-L", "zeos-lanes",
                "list-sessions", "-F", "#{session_name}",
            ]:
                return _mk_completed(stdout="codex-1\nadvisor-3\n")
            return _mk_completed(returncode=1)

        with patch("overseer.tmux_backend.subprocess.run", side_effect=fake_run):
            agents = backend.list_agents()
        assert set(agents) == {"claude-1", "codex-1", "advisor-3"}

        # Each agent registered with the socket it was found on.
        assert backend._agent_registry["claude-1"].socket == "default"
        assert backend._agent_registry["codex-1"].socket == "zeos-lanes"
        assert backend._agent_registry["advisor-3"].socket == "zeos-lanes"

    def test_default_socket_wins_for_duplicate_names(self, monkeypatch):
        """If a session exists on both sockets with the same name, default wins (priority order)."""
        monkeypatch.setenv(SOCKET_ENV_VAR, "default,zeos-lanes")
        backend = TmuxBackend()

        def fake_run(cmd, **_):
            if cmd == ["tmux", "list-sessions", "-F", "#{session_name}"]:
                return _mk_completed(stdout="codex-1\n")
            if cmd == [
                "tmux", "-L", "zeos-lanes",
                "list-sessions", "-F", "#{session_name}",
            ]:
                return _mk_completed(stdout="codex-1\n")
            return _mk_completed(returncode=1)

        with patch("overseer.tmux_backend.subprocess.run", side_effect=fake_run):
            backend.list_agents()
        assert backend._agent_registry["codex-1"].socket == "default"

    def test_socket_failure_does_not_break_others(self, monkeypatch):
        monkeypatch.setenv(SOCKET_ENV_VAR, "default,zeos-lanes")
        backend = TmuxBackend()

        def fake_run(cmd, **_):
            if cmd[:3] == ["tmux", "-L", "zeos-lanes"]:
                # Simulate "no server" error for the missing socket.
                return _mk_completed(returncode=1, stdout="")
            if cmd == ["tmux", "list-sessions", "-F", "#{session_name}"]:
                return _mk_completed(stdout="claude-1\n")
            return _mk_completed(returncode=1)

        with patch("overseer.tmux_backend.subprocess.run", side_effect=fake_run):
            agents = backend.list_agents()
        assert agents == ["claude-1"]
