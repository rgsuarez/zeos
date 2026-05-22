"""
TmuxBackend — Unified agent registry for Overseer.

Resolves agent names to tmux targets via a three-tier waterfall:
  1. In-memory registry (O(1) dict lookup)
  2. Session probe (`tmux has-session`)
  3. Pane title scan (discovers agents inside team-* sessions)

First hit wins and auto-registers for O(1) subsequent calls.
Supports both standalone sessions and pane-based team layouts transparently.

Multi-socket support: by default the backend enumerates the OS-default tmux
socket plus the ``zeos-lanes`` socket used by paired lanes, so codex
panes inside a control plane lanes are discoverable without extra config. Override the
list via ``OVERSEER_TMUX_SOCKETS=<csv>`` (priority order; first match wins).
A literal ``default`` token means the unflagged tmux socket; any other token is
passed as ``tmux -L <token>``.
"""

import logging
import os
import re
import sqlite3
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# ANSI escape code stripper
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")

# Default socket priority order. ``default`` is the unflagged OS socket;
# ``zeos-lanes`` is the dedicated socket used by a control plane's lane pairs.
DEFAULT_SOCKETS: Tuple[str, ...] = ("default", "zeos-lanes")
SOCKET_ENV_VAR = "OVERSEER_TMUX_SOCKETS"


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def configured_sockets() -> List[str]:
    """Return the ordered list of tmux sockets to consult.

    Priority: env var ``OVERSEER_TMUX_SOCKETS`` (comma-separated) wins; otherwise
    fall back to ``DEFAULT_SOCKETS``. Empty entries are dropped; duplicates are
    removed while preserving first-occurrence order. The literal ``default``
    token represents the unflagged OS tmux socket.
    """
    raw = os.getenv(SOCKET_ENV_VAR, "").strip()
    candidates: Iterable[str] = (
        (item.strip() for item in raw.split(",")) if raw else DEFAULT_SOCKETS
    )
    seen: Dict[str, None] = {}
    for token in candidates:
        if not token:
            continue
        seen.setdefault(token, None)
    if not seen:
        return list(DEFAULT_SOCKETS)
    return list(seen.keys())


def _tmux_cmd(socket: str, *args: str) -> List[str]:
    """Build a tmux invocation, injecting ``-L <socket>`` when non-default."""
    if socket and socket != "default":
        return ["tmux", "-L", socket, *args]
    return ["tmux", *args]


@dataclass
class AgentEntry:
    """Registry entry mapping an agent name to its tmux target."""
    name: str           # "c-4"
    target: str         # "c-4" (session) or "%18" (pane ID)
    kind: str           # "session" | "pane"
    parent: Optional[str] = None  # "team-4" if pane, None if session
    model: Optional[str] = None   # e.g. "opus", "gemini-3-pro"
    role: Optional[str] = None    # e.g. "director", "executor", "validator"
    socket: str = "default"       # tmux socket the agent lives on


class TmuxBackend:
    """Unified tmux backend with automatic agent discovery."""

    def __init__(self, db_path: Optional[Path] = None):
        self._agent_registry: Dict[str, AgentEntry] = {}
        self._team_sessions: Set[str] = set()
        self._db_path: Optional[Path] = db_path

    # -------------------------------------------------------------------
    # SQLite helpers (write-through cache)
    # -------------------------------------------------------------------

    def _get_db(self) -> Optional[sqlite3.Connection]:
        """Get a SQLite connection for pane registry persistence.
        Returns None if no db_path configured (pure in-memory mode)."""
        if self._db_path is None:
            return None
        conn = sqlite3.connect(str(self._db_path), timeout=30.0)
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    @staticmethod
    def _extract_team(name: str) -> Optional[str]:
        """Extract numeric team suffix from agent name (e.g., 'c-4' -> '4')."""
        if '-' in name:
            suffix = name.rsplit('-', 1)[-1]
            if suffix.isdigit():
                return suffix
        return None

    # -------------------------------------------------------------------
    # Registration API
    # -------------------------------------------------------------------

    def register_agent(self, name: str, target: str, kind: str,
                       parent: Optional[str] = None,
                       model: Optional[str] = None,
                       role: Optional[str] = None,
                       socket: str = "default") -> AgentEntry:
        """
        Explicitly register an agent.

        Args:
            name: Agent name (e.g., "c-4").
            target: tmux target — session name or pane ID (e.g., "%18").
            kind: "session" or "pane".
            parent: Parent session name for pane agents (e.g., "team-4").
            model: Optional model identifier (e.g., "opus", "gemini-3-pro").
            role: Optional role (e.g., "director", "executor", "validator").
            socket: tmux socket name ("default" for unflagged OS socket; any
                other token is passed as ``tmux -L <token>``).

        Returns:
            The registered AgentEntry.
        """
        entry = AgentEntry(name=name, target=target, kind=kind, parent=parent,
                           model=model, role=role, socket=socket)
        self._agent_registry[name] = entry
        logger.info(f"Registered agent {name} -> {target} ({kind}, socket={socket})")

        # Write-through to SQLite
        conn = self._get_db()
        if conn:
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO pane_registry "
                    "(agent_name, target, kind, parent, team_id, model, role, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
                    (name, target, kind, parent, self._extract_team(name), model, role)
                )
                conn.commit()
            except Exception:
                logger.warning("Failed to persist agent %s to SQLite", name, exc_info=True)
            finally:
                conn.close()

        return entry

    def unregister_agent(self, name: str) -> bool:
        """Remove an agent from the registry. Returns True if it existed."""
        existed = self._agent_registry.pop(name, None) is not None

        # Write-through delete from SQLite
        conn = self._get_db()
        if conn:
            try:
                conn.execute("DELETE FROM pane_registry WHERE agent_name = ?", (name,))
                conn.commit()
            except Exception:
                logger.warning("Failed to delete agent %s from SQLite", name, exc_info=True)
            finally:
                conn.close()

        return existed

    def register_team_session(self, session_name: str) -> None:
        """Mark a tmux session as a team parent (e.g., 'team-4')."""
        self._team_sessions.add(session_name)

    def unregister_team_session(self, session_name: str) -> None:
        """Remove a team session and all its pane agents from the registry."""
        self._team_sessions.discard(session_name)
        to_remove = [name for name, entry in self._agent_registry.items()
                     if entry.parent == session_name]
        for name in to_remove:
            del self._agent_registry[name]

        # Bulk delete from SQLite
        conn = self._get_db()
        if conn:
            try:
                conn.execute("DELETE FROM pane_registry WHERE parent = ?", (session_name,))
                conn.commit()
            except Exception:
                logger.warning("Failed to bulk-delete team %s from SQLite", session_name, exc_info=True)
            finally:
                conn.close()

    # -------------------------------------------------------------------
    # Resolution — three-tier waterfall
    # -------------------------------------------------------------------

    def resolve_entry(self, agent: str) -> AgentEntry:
        """
        Resolve an agent name to its full registry entry (with socket info).

        Three-tier waterfall:
          1. Registry lookup (O(1))
          2. Session probe across configured sockets (tmux -L <socket> has-session)
          3. Pane title scan across team sessions on each socket

        Raises:
            KeyError: If agent cannot be found in any tier.
        """
        # Tier 1: registry
        entry = self._agent_registry.get(agent)
        if entry:
            return entry

        # Tier 1.5: SQLite registry (cross-process)
        conn = self._get_db()
        if conn:
            try:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT target, kind, parent, model, role FROM pane_registry WHERE agent_name = ?",
                    (agent,)
                )
                row = cursor.fetchone()
                if row:
                    target, kind, parent, model, role = row
                    # SQLite doesn't store socket today — assume default and let
                    # subsequent tier-2 resolution refine it on next miss.
                    cached = AgentEntry(
                        name=agent, target=target, kind=kind, parent=parent,
                        model=model, role=role, socket="default",
                    )
                    self._agent_registry[agent] = cached
                    if parent:
                        self._team_sessions.add(parent)
                    return cached
            except Exception:
                logger.warning("SQLite lookup failed for %s", agent, exc_info=True)
            finally:
                conn.close()

        sockets = configured_sockets()

        # Tier 2: session probe (skip team-* names — those are parents, not agents)
        if not agent.startswith("team-"):
            for socket in sockets:
                try:
                    result = subprocess.run(
                        _tmux_cmd(socket, "has-session", "-t", agent),
                        capture_output=True, timeout=5,
                    )
                    if result.returncode == 0:
                        return self.register_agent(
                            agent, agent, "session", socket=socket
                        )
                except (subprocess.TimeoutExpired, FileNotFoundError):
                    continue

        # Tier 3: pane title scan
        # Auto-discover team sessions if none are registered
        if not self._team_sessions:
            self._discover_team_sessions()

        for session_name in self._team_sessions:
            for socket in sockets:
                pane_id = self._scan_pane_title(session_name, agent, socket=socket)
                if pane_id:
                    return self.register_agent(
                        agent, pane_id, "pane",
                        parent=session_name, socket=socket,
                    )

        raise KeyError(
            f"Agent '{agent}' not found. "
            f"Registry: {list(self._agent_registry.keys())}, "
            f"Team sessions: {list(self._team_sessions)}, "
            f"Sockets searched: {sockets}"
        )

    def resolve_target(self, agent: str) -> str:
        """Backward-compat shim: resolve and return only the tmux target string."""
        return self.resolve_entry(agent).target

    # -------------------------------------------------------------------
    # Agent lifecycle
    # -------------------------------------------------------------------

    def create_agent(self, agent: str, command: str,
                     parent_session: Optional[str] = None) -> str:
        """
        Launch an agent in tmux.

        Args:
            agent: Agent name (e.g., "c-4").
            command: CLI launch command.
            parent_session: If provided, create as pane in this session.
                           Otherwise create a standalone session.

        Returns:
            Target identifier — session name or pane ID.
        """
        if parent_session is None:
            # Standalone session
            subprocess.run(
                ["tmux", "new-session", "-d", "-s", agent],
                capture_output=True, timeout=5,
            )
            subprocess.run(
                ["tmux", "send-keys", "-t", agent, command, "C-m"],
                capture_output=True, timeout=5,
            )
            self.register_agent(agent, agent, "session")
            return agent

        # Pane in parent session
        result = subprocess.run(
            ["tmux", "split-window", "-t", parent_session, "-d",
             "-P", "-F", "#{pane_id}"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to create pane for {agent}: {result.stderr.strip()}"
            )
        pane_id = result.stdout.strip()

        # Set pane title for agent lookup
        subprocess.run(
            ["tmux", "select-pane", "-t", pane_id, "-T", agent],
            capture_output=True, timeout=5,
        )

        # Send launch command
        subprocess.run(
            ["tmux", "send-keys", "-t", pane_id, command, "C-m"],
            capture_output=True, timeout=5,
        )

        self.register_agent(agent, pane_id, "pane", parent=parent_session)
        return pane_id

    def create_team_session(self, session_name: str) -> None:
        """Create a parent tmux session for pane-based teams."""
        subprocess.run(
            ["tmux", "new-session", "-d", "-s", session_name],
            capture_output=True, timeout=5,
        )
        self.register_team_session(session_name)

    def finalize_layout(self, session_name: str) -> None:
        """
        Apply tiled layout and remove orphan panes for a team session.

        Call after all agents have been created via create_agent(parent_session=...).
        """
        # Tiled layout distributes space evenly
        subprocess.run(
            ["tmux", "select-layout", "-t", session_name, "tiled"],
            capture_output=True, timeout=5,
        )

        # Kill orphan panes (e.g., the empty initial pane from new-session)
        result = subprocess.run(
            ["tmux", "list-panes", "-t", session_name, "-F", "#{pane_id}"],
            capture_output=True, text=True, timeout=5,
        )
        panes = [p.strip() for p in result.stdout.strip().split("\n") if p.strip()]
        registered_ids = {
            entry.target for entry in self._agent_registry.values()
            if entry.parent == session_name
        }
        orphan_panes = [p for p in panes if p not in registered_ids]

        for orphan in orphan_panes:
            if len(panes) > 1:
                subprocess.run(
                    ["tmux", "kill-pane", "-t", orphan],
                    capture_output=True, timeout=5,
                )
                panes.remove(orphan)

    # -------------------------------------------------------------------
    # Agent operations
    # -------------------------------------------------------------------

    def capture_output(self, agent: str, lines: int = 200) -> str:
        """
        Capture terminal output from an agent.

        Returns:
            Cleaned terminal output (ANSI stripped), or error string.
        """
        try:
            entry = self.resolve_entry(agent)
        except KeyError as e:
            return f"Error: {e}"

        try:
            result = subprocess.run(
                _tmux_cmd(
                    entry.socket,
                    "capture-pane", "-t", entry.target, "-p", "-S", f"-{lines}",
                ),
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode != 0:
                return (f"Error: Could not capture from '{agent}' "
                        f"(target={entry.target}, socket={entry.socket}). "
                        f"{result.stderr.strip()}")
            return _strip_ansi(result.stdout).strip()
        except subprocess.TimeoutExpired:
            return f"Error: Timeout capturing from '{agent}'"
        except FileNotFoundError:
            return "Error: tmux is not installed or not in PATH"

    def send_keys(self, agent: str, *keys: str) -> subprocess.CompletedProcess:
        """
        Send keystrokes to an agent's tmux target.

        Args:
            agent: Agent name.
            *keys: Key arguments passed to `tmux send-keys`.

        Returns:
            CompletedProcess from subprocess.run.
        """
        entry = self.resolve_entry(agent)
        return subprocess.run(
            _tmux_cmd(entry.socket, "send-keys", "-t", entry.target, *keys),
            capture_output=True, timeout=5,
        )

    def has_agent(self, agent: str) -> bool:
        """Check if agent exists (resolves without raising)."""
        try:
            self.resolve_target(agent)
            return True
        except KeyError:
            return False

    def list_agents(self) -> List[str]:
        """
        List all agent names validated against live tmux state.

        Iterates every configured tmux socket (default + zeos-lanes by
        default; override with ``OVERSEER_TMUX_SOCKETS``). For each agent we
        also auto-register it under the socket where it was discovered, so
        subsequent send_keys / capture_pane calls land on the right server.

        Only returns agents whose tmux session or parent session is currently
        running. Stale entries from in-memory registry or SQLite are excluded.
        """
        agents: Set[str] = set()

        # 1. Ground truth: live tmux sessions + pane titles per socket
        live_sessions: Set[str] = set()
        live_pane_titles: Set[str] = set()

        for socket in configured_sockets():
            try:
                result = subprocess.run(
                    _tmux_cmd(socket, "list-sessions", "-F", "#{session_name}"),
                    capture_output=True, text=True, timeout=5,
                )
            except (subprocess.TimeoutExpired, FileNotFoundError):
                continue
            if result.returncode != 0:
                # Socket may not exist yet — that's fine, skip it.
                continue
            for name in result.stdout.strip().split("\n"):
                name = name.strip()
                if not name:
                    continue
                live_sessions.add(name)
                if not name.startswith("team-"):
                    agents.add(name)
                    # Auto-register so future send_keys / capture-pane uses
                    # the right -L socket. Don't clobber an existing entry —
                    # earlier sockets win (priority order).
                    if name not in self._agent_registry:
                        self.register_agent(name, name, "session", socket=socket)
                else:
                    # Discover pane titles in team sessions
                    try:
                        pr = subprocess.run(
                            _tmux_cmd(
                                socket,
                                "list-panes", "-t", name,
                                "-F", "#{pane_id}\t#{pane_title}",
                            ),
                            capture_output=True, text=True, timeout=5,
                        )
                    except (subprocess.TimeoutExpired, FileNotFoundError):
                        continue
                    if pr.returncode != 0:
                        continue
                    for line in pr.stdout.strip().split("\n"):
                        if "\t" not in line:
                            continue
                        pane_id, title = line.split("\t", 1)
                        title = title.strip()
                        pane_id = pane_id.strip()
                        if not title or not pane_id:
                            continue
                        live_pane_titles.add(title)
                        if title not in self._agent_registry:
                            self.register_agent(
                                title, pane_id, "pane",
                                parent=name, socket=socket,
                            )

        # 2. In-memory registry — only if validated live
        for name in self._agent_registry:
            if name in live_sessions or name in live_pane_titles:
                agents.add(name)

        # 3. SQLite pane_registry — only if parent session is live
        conn = self._get_db()
        if conn:
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT agent_name, parent FROM pane_registry")
                for row in cursor.fetchall():
                    agent_name, parent = row[0], row[1]
                    if parent in live_sessions or agent_name in live_pane_titles:
                        agents.add(agent_name)
            except Exception:
                logger.warning("SQLite list_agents query failed", exc_info=True)
            finally:
                conn.close()

        return sorted(agents)

    def kill_agent(self, agent: str) -> bool:
        """
        Kill a single agent.

        Pane agents: kills the pane. Session agents: kills the session.

        Returns:
            True if kill succeeded.
        """
        entry = self._agent_registry.get(agent)
        socket = entry.socket if entry else "default"

        if entry and entry.kind == "pane":
            result = subprocess.run(
                _tmux_cmd(socket, "kill-pane", "-t", entry.target),
                capture_output=True, timeout=5,
            )
            if result.returncode == 0:
                self.unregister_agent(agent)
                return True
            return False

        # Session agent (registered or not)
        target = entry.target if entry else agent
        result = subprocess.run(
            _tmux_cmd(socket, "kill-session", "-t", target),
            capture_output=True, timeout=5,
        )
        if result.returncode == 0:
            self.unregister_agent(agent)
            return True
        return False

    def kill_team(self, session_name: str) -> bool:
        """
        Kill a team session and purge all its pane agents from registry.

        Returns:
            True if the session was killed.
        """
        # Find the socket for this team — any registered pane agent under it
        # carries the socket, otherwise default.
        socket = "default"
        for entry in self._agent_registry.values():
            if entry.parent == session_name:
                socket = entry.socket
                break
        result = subprocess.run(
            _tmux_cmd(socket, "kill-session", "-t", session_name),
            capture_output=True, timeout=5,
        )
        self.unregister_team_session(session_name)
        return result.returncode == 0

    def kill_all(self) -> bool:
        """
        Kill all known agents and team sessions.

        Returns:
            True if all kills succeeded.
        """
        success = True

        # Kill team sessions first (atomic — kills all panes)
        for session_name in list(self._team_sessions):
            if not self.kill_team(session_name):
                success = False

        # Kill remaining standalone session agents
        for name, entry in list(self._agent_registry.items()):
            if entry.kind == "session":
                if not self.kill_agent(name):
                    success = False

        return success

    # -------------------------------------------------------------------
    # Private helpers
    # -------------------------------------------------------------------

    def _scan_pane_title(
        self,
        session_name: str,
        agent_name: str,
        socket: str = "default",
    ) -> Optional[str]:
        """Scan pane titles in a session for a specific agent. Returns pane ID or None."""
        try:
            result = subprocess.run(
                _tmux_cmd(
                    socket,
                    "list-panes", "-t", session_name,
                    "-F", "#{pane_id}\t#{pane_title}",
                ),
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode != 0:
                return None

            for line in result.stdout.strip().split("\n"):
                if "\t" not in line:
                    continue
                pane_id, title = line.split("\t", 1)
                if title.strip() == agent_name:
                    return pane_id.strip()
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
        return None

    def _discover_team_panes(
        self,
        session_name: str,
        socket: str = "default",
    ) -> Dict[str, str]:
        """Discover all pane agents in a team session. Returns {agent_name: pane_id}."""
        panes: Dict[str, str] = {}
        try:
            result = subprocess.run(
                _tmux_cmd(
                    socket,
                    "list-panes", "-t", session_name,
                    "-F", "#{pane_id}\t#{pane_title}",
                ),
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode != 0:
                return panes

            for line in result.stdout.strip().split("\n"):
                if "\t" not in line:
                    continue
                pane_id, title = line.split("\t", 1)
                pane_id = pane_id.strip()
                title = title.strip()
                if title and pane_id:
                    panes[title] = pane_id
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
        return panes

    def _discover_team_sessions(self) -> Set[str]:
        """Find all team-* tmux sessions across configured sockets and register them."""
        for socket in configured_sockets():
            try:
                result = subprocess.run(
                    _tmux_cmd(socket, "list-sessions", "-F", "#{session_name}"),
                    capture_output=True, text=True, timeout=5,
                )
            except (subprocess.TimeoutExpired, FileNotFoundError):
                continue
            if result.returncode != 0:
                continue
            for name in result.stdout.strip().split("\n"):
                name = name.strip()
                if name.startswith("team-"):
                    self._team_sessions.add(name)
        return self._team_sessions


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------
_backend: Optional[TmuxBackend] = None


def get_backend(db_path: Optional[Path] = None) -> TmuxBackend:
    """Get the module-level TmuxBackend singleton."""
    global _backend
    if _backend is None:
        _backend = TmuxBackend(db_path=db_path)
    return _backend
