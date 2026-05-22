"""
Overseer MCP server

Provides tools for inter-agent visibility:
- get_agent_output: Capture terminal output from tmux sessions
- post_message: Post messages to shared relay
- get_messages: Retrieve messages from relay
"""

import atexit
import fcntl
import hashlib
import json
import logging
import os
import re
import signal
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# MCP owns stdout for JSON-RPC — all logging goes to stderr
logging.basicConfig(
    stream=sys.stderr,
    level=logging.WARNING,
    format="%(asctime)s [overseer] %(levelname)s: %(message)s",
)
logger = logging.getLogger("overseer")

from mcp.server.fastmcp import FastMCP

from overseer.detector import StateDetector, AgentState
from overseer.teams.definitions import infer_role
from overseer.push import ClawdbotPushClient, PushEvent, PushResult
from overseer.summarization import TaskSummarizer
from overseer.rpc import AgentRPCClient, RPCResponse
from overseer.blueprint import BlueprintParser, Blueprint
from overseer.tmux_backend import get_backend as _get_backend_raw, TmuxBackend


def get_tmux_backend() -> TmuxBackend:
    """Get TmuxBackend singleton wired to the relay DB path."""
    return _get_backend_raw(db_path=DB_PATH)

# Clawdbot Push Configuration (P0-1.3)
CLAWDBOT_GATEWAY_URL = os.getenv("CLAWDBOT_GATEWAY_URL", "")
CLAWDBOT_GATEWAY_TOKEN = os.getenv("CLAWDBOT_GATEWAY_TOKEN", "")

# Singleton push client (initialized lazily)
_push_client: Optional[ClawdbotPushClient] = None


def get_push_client() -> Optional[ClawdbotPushClient]:
    """Get or create singleton push client."""
    global _push_client
    if _push_client is None and CLAWDBOT_GATEWAY_URL:
        _push_client = ClawdbotPushClient(CLAWDBOT_GATEWAY_URL, CLAWDBOT_GATEWAY_TOKEN)
    return _push_client


class RateLimiter:
    """Token bucket rate limiter for agent message throttling."""

    def __init__(self, tokens_per_second: float = 1.0, max_tokens: int = 10):
        self.tokens_per_second = tokens_per_second
        self.max_tokens = max_tokens
        self.buckets: Dict[str, Tuple[float, float]] = {}  # agent -> (tokens, last_update)

    def acquire(self, agent: str) -> bool:
        """Try to consume a token. Returns True if allowed, False if rate limited."""
        now = time.time()
        tokens, last_update = self.buckets.get(agent, (float(self.max_tokens), now))

        # Refill tokens based on elapsed time
        elapsed = now - last_update
        tokens = min(self.max_tokens, tokens + elapsed * self.tokens_per_second)

        if tokens >= 1:
            self.buckets[agent] = (tokens - 1, now)
            return True
        else:
            self.buckets[agent] = (tokens, now)
            return False

    def get_status(self, agent: str) -> dict:
        """Get current rate limit status for an agent."""
        now = time.time()
        tokens, last_update = self.buckets.get(agent, (float(self.max_tokens), now))
        elapsed = now - last_update
        current_tokens = min(self.max_tokens, tokens + elapsed * self.tokens_per_second)
        return {
            "agent": agent,
            "tokens_available": round(current_tokens, 2),
            "max_tokens": self.max_tokens,
            "refill_rate": self.tokens_per_second
        }


class MessageType(str, Enum):
    """Message types for structured relay communication."""
    TASK = "task"          # Assign work (Legacy)
    RESPONSE = "response"  # Answer to task/query (Legacy)
    QUERY = "query"        # Request info
    ACK = "ack"            # Acknowledge receipt
    STATUS = "status"      # State update
    RAW = "raw"            # Untyped (legacy)

    # Team Protocol
    TASK_ASSIGN = "task_assign"      # Director -> Worker: Assign specific task
    TASK_ACCEPT = "task_accept"      # Worker -> Director: Accepted assignment
    TASK_COMPLETE = "task_complete"  # Worker -> Director: Task done (with result)
    TASK_BLOCKED = "task_blocked"    # Worker -> Director: Cannot proceed

    # Coordination Multiplier Evolution
    HEARTBEAT = "heartbeat"          # Worker periodic status (every 60s during task)

    # 3-Way Handshake Protocol
    HANDSHAKE_SYN = "handshake_syn"          # Sender -> Receiver: Intent to send command
    HANDSHAKE_SYN_ACK = "handshake_syn_ack"  # Receiver -> Sender: Ready to receive
    HANDSHAKE_ACK = "handshake_ack"          # Sender -> Receiver: GO (contains command)

    # Session Continuity Protocol (Phoenix Mode)
    WARM_SHADOW = "warm_shadow"              # Monitor -> Shadow: Pre-warm for handover
    READY_FOR_DIGEST = "ready_for_digest"    # Shadow -> Monitor: Ready to receive digest
    HANDOFF_DIGEST = "handoff_digest"        # Monitor -> Shadow: Full handover payload
    INTENT_STATEMENT = "intent_statement"    # Shadow -> Monitor: Understanding confirmation
    FINAL_HANDOVER_ACK = "final_ack"         # Primary -> Monitor: Approve handover
    SWITCH_ROUTE = "switch_route"            # Monitor -> Proxy: Switch user input
    SESSION_CLOSED = "session_closed"        # Primary -> Monitor: Cleanup complete

# Initialize MCP server
mcp = FastMCP("overseer")

# Singleton rate limiter (1 msg/sec sustained, burst up to 10)
_rate_limiter = RateLimiter(tokens_per_second=1.0, max_tokens=10)

# Tool results cache (agent -> {tool_name: (timestamp, result)})
_tool_cache: Dict[str, Dict[str, Tuple[float, Any]]] = {}
CACHE_TTL = 30.0  # 30 second cache for terminal captures

# Team-based filtering constants
MESSAGE_TTL_HOURS = 24  # Messages expire after 24 hours
PRUNE_INTERVAL_SEC = 3600  # Prune at most once per hour
_last_prune_time: float = 0.0  # Module-level throttle state
DEBUG_ALLOWLIST_ENV = "OVERSEER_DEBUG_ALLOWLIST"
DEBUG_ALLOWLIST_DEFAULT = {"gemini-3"}

# Heartbeat registry (worker -> latest heartbeat data)
# Coordination Multiplier Evolution: Track worker heartbeats for frozen detection
_heartbeat_registry: Dict[str, Dict[str, Any]] = {}

# Subscribe tracking for idle watchdog
# worker_name -> {first_listen, last_listen, listen_count, last_task_received, team_id}
_subscribe_registry: Dict[str, Dict[str, Any]] = {}

# Retry count registry (task_id -> retry_count) for P1-4.1
_retry_registry: Dict[str, int] = {}
MAX_RETRIES = 3

# Session Continuity Protocol (Phoenix Mode) registry
# rotation_id -> {state, primary, shadow, monitor, timestamps, etc.}
_rotation_registry: Dict[str, Dict[str, Any]] = {}
ROTATION_STATES = ["initiated", "shadow_warming", "shadow_ready", "digest_sent",
                   "intent_received", "ack_received", "switched", "closed"]


def get_retry_count(task_id: str) -> int:
    """Get current retry count for a task (P1-4.1)."""
    return _retry_registry.get(task_id, 0)


def increment_retry_count(task_id: str) -> int:
    """Increment and return retry count for a task (P1-4.1)."""
    current = _retry_registry.get(task_id, 0)
    _retry_registry[task_id] = current + 1
    return _retry_registry[task_id]


def reset_retry_count(task_id: str):
    """Reset retry count for a task (P1-4.1)."""
    if task_id in _retry_registry:
        del _retry_registry[task_id]

# Thresholds from Coordination Multiplier Spec v1.0
HEARTBEAT_INTERVAL_SEC = 60      # Default heartbeat interval
STUCK_THRESHOLD_SEC = 300        # 5 min static WORKING output
CRASHED_THRESHOLD_SEC = 600      # 10 min no heartbeat + no output


def get_cached_result(agent: str, tool_name: str) -> Optional[any]:
    """Retrieve cached result if still valid."""
    if agent in _tool_cache and tool_name in _tool_cache[agent]:
        timestamp, result = _tool_cache[agent][tool_name]
        if (time.time() - timestamp) < CACHE_TTL:
            return result
    return None


def set_cached_result(agent: str, tool_name: str, result: any):
    """Store result in cache."""
    if agent not in _tool_cache:
        _tool_cache[agent] = {}
    _tool_cache[agent][tool_name] = (time.time(), result)


def _terminal_output_hash(output: str, tail_lines: int = 10) -> str:
    """Hash terminal output tail for prompt-activity verification."""
    lines = [line for line in output.splitlines() if line.strip()]
    tail = "\n".join(lines[-tail_lines:])
    if not tail:
        return ""
    return hashlib.sha256(tail.encode("utf-8")).hexdigest()


def _capture_tmux_output(agent: str, lines: int = 20) -> str:
    """Capture tmux output directly (no cache) for visual verification."""
    return get_tmux_backend().capture_output(agent, lines=lines)


def visual_verify(agent: str, pre_hash: Optional[str] = None, wait_sec: float = 3.0, lines: int = 20) -> dict:
    """
    Visual verification helper: wait, then confirm prompt/output activity via hash change.

    Args:
        agent: tmux session name
        pre_hash: optional hash of output before action
        wait_sec: seconds to wait before capture
        lines: number of lines to capture for hash

    Returns:
        Dict with verification status and post-state
    """
    time.sleep(wait_sec)
    post_output = _capture_tmux_output(agent, lines=lines)
    post_hash = _terminal_output_hash(post_output)
    verified = (pre_hash != post_hash) if pre_hash is not None else bool(post_hash)

    # Force detect_state to use latest output
    set_cached_result(agent, "get_agent_output", post_output)
    if agent in _tool_cache:
        _tool_cache[agent].pop("detect_state", None)
    post_state = detect_state(agent).get("state", AgentState.UNKNOWN.value)

    return {
        "verified": verified,
        "post_hash": post_hash,
        "post_state": post_state
    }


def get_debug_allowlist() -> set:
    """Resolve debug allowlist from env or defaults."""
    raw = os.getenv(DEBUG_ALLOWLIST_ENV)
    if raw:
        return {item.strip() for item in raw.split(",") if item.strip()}
    return set(DEBUG_ALLOWLIST_DEFAULT)


def extract_team(agent: str) -> Optional[str]:
    """
    Extract numeric team ID from agent name.

    Only returns team ID if suffix is numeric (1, 2, 3, etc.).
    Non-numeric suffixes are treated as legacy agents.

    Examples:
        'claude-3' -> '3'
        'gemini-1' -> '1'
        'codex-2' -> '2'
        'claude' -> None (legacy, no team)
        'claude-opus' -> None (non-numeric suffix)
        'overseer-admin' -> None (non-numeric suffix)
    """
    if '-' in agent:
        suffix = agent.split('-')[-1]
        # Only return numeric team IDs for strict isolation
        if suffix.isdigit():
            return suffix
    return None


def _requester_team(agent: str) -> Optional[str]:
    """
    Resolve a requester's team id with optional env fallback.

    Order: numeric suffix on the agent name (strict, identical to extract_team)
    falls back to OVERSEER_DEFAULT_TEAM_ID if set. The fallback applies ONLY to
    the *requester*, never to a *target* agent — so a caller can opt into a
    default team without weakening cross-team validation on send_to_agent etc.

    Bridge-mode caveat: OVERSEER_DEFAULT_TEAM_ID="0" is treated as the
    privileged bridge team and is honored only when the agent name is exactly
    "bridge-0". Any other agent claiming team 0 via env is rejected with a
    warning and treated as no team.
    """
    team = extract_team(agent)
    if team is not None:
        return team
    default = os.getenv("OVERSEER_DEFAULT_TEAM_ID", "").strip()
    if not default:
        return None
    if not default.isdigit():
        logger.warning(
            "OVERSEER_DEFAULT_TEAM_ID=%r is non-numeric; ignoring.", default
        )
        return None
    if default == "0" and agent != "bridge-0":
        logger.warning(
            "OVERSEER_DEFAULT_TEAM_ID=0 (bridge mode) ignored for non-bridge agent %r",
            agent,
        )
        return None
    return default


def enforce_team_filter(requesting_agent: str, target_agent: Optional[str] = None) -> Optional[str]:
    """
    Derive team from requesting agent and optionally validate target is same team.

    Args:
        requesting_agent: The agent making the request
        target_agent: Optional target agent to validate same-team access

    Returns:
        Team ID of requesting agent (or None for legacy agents)

    Raises:
        ValueError: If target_agent is on a different team
    """
    requester_team = _requester_team(requesting_agent)
    if target_agent:
        target_team = extract_team(target_agent)
        # Only enforce if both have team IDs
        if requester_team and target_team and requester_team != target_team:
            raise ValueError(f"Cross-team access denied: {requesting_agent} -> {target_agent}")
    return requester_team


def _messages_envelope(messages: list, *, timed_out: bool = False) -> dict:
    """
    Wrap a list of relay messages into a Codex-safe MCP response envelope.

    FastMCP serializes a top-level ``list[dict]`` return as ``structuredContent``
    plus a synthesized ``content`` array; codex's Rust MCP client (``rmcp``)
    rejects that shape as "Unexpected response type". A single ``dict`` return
    serializes as one ``TextContent`` and is universally parseable.

    See: LOE-zeos-overseer-codex-relay-compat (2026-05-04).
    """
    return {
        "status": "ok",
        "messages": messages,
        "count": len(messages),
        "timed_out": timed_out,
    }


# ---------------------------------------------------------------------------
# Pair registry helpers (LOE-zeos-overseer-npair-tmux-intercom, 2026-05-05)
# ---------------------------------------------------------------------------

PAIR_TEAM_ID_BASE_DEFAULT = 1000


def _pair_team_id_base() -> int:
    """Resolve OVERSEER_PAIR_TEAM_ID_BASE from env, defaulting to 1000.

    Non-numeric / non-positive values fall back to the default with a warning.
    There is no low-team-ID override env — explicit team_id < BASE always
    denies, including for bridge-0. Legacy low-ID interop is a separate LOE.
    """
    raw = os.getenv("OVERSEER_PAIR_TEAM_ID_BASE", "").strip()
    if not raw:
        return PAIR_TEAM_ID_BASE_DEFAULT
    try:
        value = int(raw)
    except ValueError:
        logger.warning("OVERSEER_PAIR_TEAM_ID_BASE=%r is non-numeric; using default %d.",
                       raw, PAIR_TEAM_ID_BASE_DEFAULT)
        return PAIR_TEAM_ID_BASE_DEFAULT
    if value <= 0:
        logger.warning("OVERSEER_PAIR_TEAM_ID_BASE=%r is non-positive; using default %d.",
                       raw, PAIR_TEAM_ID_BASE_DEFAULT)
        return PAIR_TEAM_ID_BASE_DEFAULT
    return value


def _pair_denial(error: str, *, pair_id: Optional[str] = None) -> dict:
    """Pair-tool denial dict shape. Never includes claude_session/codex_session/socket."""
    out: dict = {"status": "denied", "error": error}
    if pair_id is not None:
        out["pair_id"] = pair_id
    return out


def _pair_row_to_dict(row) -> dict:
    """Serialize a pair_registry row (sqlite3.Row) into a flat dict.

    Includes the tombstone columns (active, unregistered_at) added in the
    PR #9 second fixup. Pre-existing fixtures or older rows missing those
    columns degrade gracefully: ``active=1, unregistered_at=None``.
    """
    out = {
        "pair_id":        row["pair_id"],
        "team_id":        row["team_id"],
        "claude_session": row["claude_session"],
        "codex_session":  row["codex_session"],
        "socket":         row["socket"],
        "description":    row["description"],
        "created_at":     row["created_at"],
        "last_activity":  row["last_activity"],
    }
    try:
        out["active"] = int(row["active"]) if row["active"] is not None else 1
    except (KeyError, IndexError, TypeError):
        out["active"] = 1
    try:
        out["unregistered_at"] = row["unregistered_at"]
    except (KeyError, IndexError):
        out["unregistered_at"] = None
    return out


# Team-scoped surfaces queried by _team_in_use / _pair_allocate_team_id.
# Every (table, column) tuple holds (or held) a numeric team_id that — if
# left from a retired pair — could leak into a freshly allocated pair via
# heartbeats, cursors, pane registrations, audit history, or aliases.
# Order is irrelevant; the scans are MAX-aggregations.
_TEAM_SCOPED_SURFACES = (
    ("pair_registry", "team_id"),  # active + tombstoned
    ("messages",      "team_id"),
    ("heartbeats",    "team_id"),
    ("worker_cursors","team_id"),
    ("pane_registry", "team_id"),
    ("audit_log",     "team_id"),
    ("agent_aliases", "team_id"),  # numeric values only
)


def _max_numeric_team_id(conn, table: str, column: str) -> Optional[int]:
    """MAX(CAST(<column> AS INTEGER)) restricted to all-digit values.

    Tables like agent_aliases store non-numeric scope tokens (e.g., '*');
    those are excluded so the allocator stays inside the numeric partition.
    Returns None when the table is empty or has no numeric values.
    """
    try:
        cur = conn.execute(
            f"SELECT MAX(CAST({column} AS INTEGER)) FROM {table} "
            f"WHERE {column} IS NOT NULL AND {column} != '' "
            f"AND {column} GLOB '[0-9]*' AND {column} NOT GLOB '*[^0-9]*'"
        )
        row = cur.fetchone()
    except sqlite3.OperationalError:
        # Table missing in some test fixtures; treat as empty.
        return None
    if row is None or row[0] is None:
        return None
    return int(row[0])


def _team_in_use(conn, team_id: str) -> Optional[str]:
    """If any team-scoped surface has rows for ``team_id``, return the table
    name where evidence was found. Used by the explicit-team_id register
    path to deny binding a new pair to a team_id with surviving state from
    a previously unregistered pair.

    pair_registry is intentionally excluded here — the caller checks
    UNIQUE(pair_registry.team_id) separately and handles the tombstone
    case (see register_pair).
    """
    surfaces = [
        ("messages",      "team_id"),
        ("heartbeats",    "team_id"),
        ("worker_cursors","team_id"),
        ("pane_registry", "team_id"),
        ("audit_log",     "team_id"),
        ("agent_aliases", "team_id"),
    ]
    for table, column in surfaces:
        try:
            cur = conn.execute(
                f"SELECT 1 FROM {table} WHERE {column} = ? LIMIT 1",
                (team_id,),
            )
            if cur.fetchone() is not None:
                return table
        except sqlite3.OperationalError:
            continue
    return None


def _pair_allocate_team_id(conn) -> str:
    """Allocate the next monotonic team_id >= BASE.

    Pair team_ids are durable, non-recycled reservations. The allocator
    scans every team-scoped surface — including tombstoned pair_registry
    rows — so a previously retired team_id (which may still have
    heartbeats / cursors / pane registrations / audit rows / aliases on
    it) is NEVER reused.

    Allocation rule:
        next_id = max(BASE - 1,
                      MAX(team_id) across all _TEAM_SCOPED_SURFACES) + 1

    Pure read; the actual INSERT is the caller's responsibility (under the
    same connection / transaction). UNIQUE(team_id) protects against any race.
    """
    base = _pair_team_id_base()
    floor = base - 1
    candidates = [floor]
    for table, column in _TEAM_SCOPED_SURFACES:
        m = _max_numeric_team_id(conn, table, column)
        if m is not None:
            candidates.append(m)
    next_id = max(candidates) + 1
    return str(next_id)


def _is_bridge(requesting_agent: str) -> bool:
    """True iff the requester is the privileged bridge identity."""
    return requesting_agent == "bridge-0" and _requester_team(requesting_agent) == "0"


# Database path
DB_PATH = Path.home() / ".overseer" / "relay.db"

# PID tracking for orphan process cleanup
_PID_DIR = DB_PATH.parent / "pids"

# WAL mode initialized flag
_wal_initialized = False

# Database initialized flag — prevents redundant init_db() on every tool call.
# Tracks the DB_PATH that was initialized so tests with different temp DBs still work.
_db_initialized_path: Optional[Path] = None


def get_db() -> sqlite3.Connection:
    """Get a SQLite connection with WAL mode and busy timeout.

    WAL mode allows concurrent readers with a single writer (no full-file locks).
    busy_timeout tells SQLite to retry for up to 30 seconds instead of failing immediately.
    With 9+ concurrent processes sharing one DB, 5s was insufficient for WAL writer lock.
    """
    global _wal_initialized
    conn = sqlite3.connect(DB_PATH, timeout=60.0)
    if not _wal_initialized:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=60000")
        _wal_initialized = True
    else:
        conn.execute("PRAGMA busy_timeout=60000")
    return conn


@contextmanager
def db_connection():
    """Context manager for SQLite connections with guaranteed cleanup."""
    conn = get_db()
    try:
        yield conn
    finally:
        conn.close()


def log_action(
    agent: str,
    action: str,
    resource: Optional[str] = None,
    outcome: str = "success",
    metadata: Optional[Dict[str, Any]] = None
) -> int:
    """
    Log an action to the audit trail (P1-4.2).

    Args:
        agent: Agent performing the action
        action: Action type (e.g., "dispatch_task", "post_message")
        resource: Optional resource affected (e.g., task_id, message_id)
        outcome: Result of action (success, denied, error)
        metadata: Optional additional context as dict

    Returns:
        Audit log entry ID
    """
    init_db()
    team_id = extract_team(agent)
    metadata_json = json.dumps(metadata) if metadata else None

    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """INSERT INTO audit_log (agent, team_id, action, resource, outcome, metadata)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (agent, team_id, action, resource, outcome, metadata_json)
        )
        conn.commit()
        entry_id = cursor.lastrowid

    return entry_id


def normalize_agent_name(alias: str, team_id: Optional[str] = None) -> str:
    """
    Resolve agent alias to canonical name (P0-2.3).

    Args:
        alias: Agent name (possibly an alias like "claude-opus")
        team_id: Team ID for scoped resolution (None = global lookup)

    Returns:
        Canonical agent name if found, otherwise returns original alias (passthrough)

    Example:
        normalize_agent_name("claude-opus", "3") -> "claude-3"
        normalize_agent_name("unknown", "3") -> "unknown"  # passthrough
    """
    if not alias:
        return alias

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()

        # Try team-specific lookup first
        if team_id:
            cursor.execute(
                "SELECT canonical FROM agent_aliases WHERE alias = ? AND team_id = ?",
                (alias, team_id)
            )
            row = cursor.fetchone()
            if row:
                return row[0]

        # Fallback: try global lookup (team_id = '*' or any match)
        cursor.execute(
            "SELECT canonical FROM agent_aliases WHERE alias = ? ORDER BY team_id LIMIT 1",
            (alias,)
        )
        row = cursor.fetchone()

    if row:
        return row[0]

    # No alias found - return original (passthrough)
    return alias


def seed_default_aliases():
    """
    Seed default agent aliases for common model names (P0-2.4).

    Seeds aliases like:
    - claude-opus -> claude-3
    - gemini-2.0-flash -> gemini-3
    - codex-cli -> codex-3

    Uses INSERT OR IGNORE for idempotency.
    """
    init_db()

    # Default aliases for Team 3 (primary development team)
    default_aliases = [
        # Claude variants
        ("claude-3", "claude-opus", "3"),
        ("claude-3", "claude-sonnet", "3"),
        ("claude-3", "claude-4.5", "3"),
        ("claude-3", "opus", "3"),
        # Gemini variants
        ("gemini-3", "gemini-2.0-flash", "3"),
        ("gemini-3", "gemini-pro", "3"),
        ("gemini-3", "gemini-flash", "3"),
        # Codex variants
        ("codex-3", "codex-cli", "3"),
        ("codex-3", "codex", "3"),
        ("codex-3", "openai-codex", "3"),
        # Goose/Grok variants
        ("goose-3", "grok", "3"),
        ("goose-3", "grok-4", "3"),
        ("goose-3", "goose-cli", "3"),
        ("goose-3", "xai", "3"),
    ]

    with db_connection() as conn:
        for canonical, alias, team_id in default_aliases:
            conn.execute(
                "INSERT OR IGNORE INTO agent_aliases (canonical, alias, team_id) VALUES (?, ?, ?)",
                (canonical, alias, team_id)
            )
        conn.commit()


def prune_expired_messages():
    """
    Delete messages older than MESSAGE_TTL_HOURS (throttled).

    Only runs if PRUNE_INTERVAL_SEC has passed since last prune.
    """
    global _last_prune_time
    now = time.time()

    # Throttle: skip if pruned recently
    if (now - _last_prune_time) < PRUNE_INTERVAL_SEC:
        return 0

    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM messages WHERE timestamp < datetime('now', ?)",
            (f'-{MESSAGE_TTL_HOURS} hours',)
        )
        deleted = cursor.rowcount
        conn.commit()
    _last_prune_time = now
    return deleted


def migrate_team_ids():
    """Backfill team_id for existing messages based on agent name."""
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, agent FROM messages WHERE team_id IS NULL OR team_id = '' OR team_id GLOB '*[^0-9]*'"
        )
        rows = cursor.fetchall()
        for row in rows:
            team_id = extract_team(row[1])
            if team_id:
                conn.execute("UPDATE messages SET team_id = ? WHERE id = ?", (team_id, row[0]))
        conn.commit()
    return len(rows)


def get_task_cursor(worker_name: str, team_id: str) -> int:
    """Get the last-seen task_assign message ID for a worker."""
    init_db()
    with db_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT task_cursor FROM worker_cursors WHERE worker_name = ? AND team_id = ?",
                    (worker_name, team_id))
        row = cur.fetchone()
    return row[0] if row else 0


def update_task_cursor(worker_name: str, team_id: str, new_cursor: int) -> None:
    """Advance the task cursor for a worker (called on task match only)."""
    init_db()
    with db_connection() as conn:
        conn.execute("""
            INSERT INTO worker_cursors (worker_name, team_id, task_cursor, last_updated)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(worker_name, team_id) DO UPDATE SET
                task_cursor = excluded.task_cursor, last_updated = CURRENT_TIMESTAMP
        """, (worker_name, team_id, new_cursor))
        conn.commit()


def reset_team_cursors(team_id: str) -> int:
    """Reset all worker cursors for a team (called on clear_team_messages)."""
    init_db()
    with db_connection() as conn:
        cur = conn.execute("DELETE FROM worker_cursors WHERE team_id = ?", (team_id,))
        deleted = cur.rowcount
        conn.commit()
    return deleted


def _run_schema_migration(conn: sqlite3.Connection) -> None:
    """Run destructive RENAME/CREATE/INSERT/DROP migration under file lock.

    Uses fcntl.flock to serialize across all concurrent overseer processes.
    Double-check pattern: re-verifies migration is still needed after acquiring lock.
    """
    lock_path = DB_PATH.parent / "init.lock"
    lock_path.touch(exist_ok=True)
    with open(lock_path, "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            # Re-check after acquiring lock — another process may have completed migration
            cursor = conn.cursor()
            cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'")
            row = cursor.fetchone()
            table_sql = row[0] if row else ""
            if "team_id TEXT NOT NULL" in table_sql and "CHECK" in table_sql and "GLOB" in table_sql:
                return  # Already migrated by another process

            conn.execute("ALTER TABLE messages RENAME TO messages_old")
            conn.execute("""
                CREATE TABLE messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent TEXT NOT NULL,
                    content TEXT NOT NULL,
                    type TEXT DEFAULT 'raw',
                    ref_id INTEGER DEFAULT NULL,
                    team_id TEXT NOT NULL CHECK (team_id GLOB '[0-9]*' AND team_id != '' AND team_id NOT GLOB '*[^0-9]*'),
                    activation_epoch TEXT DEFAULT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (ref_id) REFERENCES messages(id)
                )
            """)
            # activation_epoch column already added via ALTER TABLE migration above,
            # so messages_old always has it by this point
            conn.execute("""
                INSERT INTO messages (id, agent, content, type, ref_id, team_id, activation_epoch, timestamp)
                SELECT id, agent, content, type, ref_id, team_id, activation_epoch, timestamp
                FROM messages_old
                WHERE team_id IS NOT NULL
                  AND team_id != ''
                  AND team_id NOT GLOB '*[^0-9]*'
            """)
            conn.execute("DROP TABLE messages_old")
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def _init_db_inner():
    """Core database initialization logic (called by init_db with retry)."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent TEXT NOT NULL,
                content TEXT NOT NULL,
                type TEXT DEFAULT 'raw',
                ref_id INTEGER DEFAULT NULL,
                team_id TEXT NOT NULL CHECK (team_id GLOB '[0-9]*' AND team_id != '' AND team_id NOT GLOB '*[^0-9]*'),
                activation_epoch TEXT DEFAULT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ref_id) REFERENCES messages(id)
            )
        """)

        # P0-2.1: Agent aliases table for identity resolution
        conn.execute("""
            CREATE TABLE IF NOT EXISTS agent_aliases (
                canonical TEXT NOT NULL,
                alias TEXT NOT NULL,
                team_id TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (alias, team_id)
            )
        """)

        # P1-4.1: Audit log table for security/compliance
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                agent TEXT NOT NULL,
                team_id TEXT,
                action TEXT NOT NULL,
                resource TEXT,
                outcome TEXT,
                metadata TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent)")

        # Worker task cursors for BUG-11 fix (since_id skip isolation)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS worker_cursors (
                worker_name TEXT NOT NULL,
                team_id TEXT NOT NULL,
                task_cursor INTEGER DEFAULT 0,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (worker_name, team_id)
            )
        """)

        # Pane registry: cross-process agent→pane persistence (BUG-19 fix)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pane_registry (
                agent_name  TEXT NOT NULL PRIMARY KEY,
                target      TEXT NOT NULL,
                kind        TEXT NOT NULL,
                parent      TEXT DEFAULT NULL,
                team_id     TEXT DEFAULT NULL,
                updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pane_registry_parent ON pane_registry(parent)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pane_registry_team ON pane_registry(team_id)")

        # Heartbeat persistence table (cross-process heartbeat visibility)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS heartbeats (
                worker      TEXT NOT NULL,
                team_id     TEXT NOT NULL,
                task_id     TEXT,
                progress_pct INTEGER DEFAULT 0,
                current_action TEXT DEFAULT '',
                current_milestone TEXT DEFAULT '',
                state       TEXT,
                terminal_hash TEXT,
                frozen_warning INTEGER DEFAULT 0,
                hash_changed_at REAL,
                epoch       REAL NOT NULL,
                timestamp   TEXT NOT NULL,
                updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (worker, team_id)
            )
        """)

        # Pair registry — N-pair tmux intercom isolation (LOE-zeos-overseer-npair-tmux-intercom)
        # Maps an operator-meaningful pair_id to a unique numeric team_id (>= BASE)
        # so N concurrent tmux pairs each get a strict isolation domain. Additive only:
        # the messages table is unchanged; isolation is still enforced via extract_team /
        # enforce_team_filter. The registry is a discovery/audit layer, never an
        # enforcement layer. CREATE-IF-NOT-EXISTS — never invokes _run_schema_migration.
        #
        # Tombstones (PR #9 second fixup, 2026-05-05): pair team_ids are durable,
        # non-recycled reservations. unregister_pair sets active=0 instead of DELETE,
        # so allocator + explicit-team checks can see retired team_ids and refuse
        # reuse. Reactivation is out of scope here.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pair_registry (
                pair_id          TEXT PRIMARY KEY,
                team_id          TEXT NOT NULL UNIQUE
                                   CHECK (team_id GLOB '[0-9]*'
                                          AND team_id != ''
                                          AND team_id NOT GLOB '*[^0-9]*'),
                claude_session   TEXT,
                codex_session    TEXT,
                socket           TEXT NOT NULL DEFAULT 'default',
                description      TEXT,
                created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_activity    DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pair_team_id ON pair_registry(team_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pair_socket  ON pair_registry(socket)")

        # Tombstone migration: ALTER TABLE ADD COLUMN only when missing. Idempotent
        # across overseer restarts. Never invokes the destructive
        # _run_schema_migration path.
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(pair_registry)")
        pair_cols = {col[1] for col in cursor.fetchall()}
        if "active" not in pair_cols:
            conn.execute(
                "ALTER TABLE pair_registry ADD COLUMN active INTEGER "
                "NOT NULL DEFAULT 1 CHECK(active IN (0,1))"
            )
        if "unregistered_at" not in pair_cols:
            conn.execute(
                "ALTER TABLE pair_registry ADD COLUMN unregistered_at "
                "DATETIME DEFAULT NULL"
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_pair_active ON pair_registry(active)"
        )

        # Migration: add model/role columns to pane_registry (for existing DBs)
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(pane_registry)")
        pane_columns = [col[1] for col in cursor.fetchall()]
        if 'model' not in pane_columns:
            conn.execute("ALTER TABLE pane_registry ADD COLUMN model TEXT DEFAULT NULL")
        if 'role' not in pane_columns:
            conn.execute("ALTER TABLE pane_registry ADD COLUMN role TEXT DEFAULT NULL")

        # Migration: add columns to messages if they don't exist (for existing DBs)
        cursor.execute("PRAGMA table_info(messages)")
        columns = [col[1] for col in cursor.fetchall()]
        if 'type' not in columns:
            conn.execute("ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'raw'")
        if 'ref_id' not in columns:
            conn.execute("ALTER TABLE messages ADD COLUMN ref_id INTEGER DEFAULT NULL")
        if 'team_id' not in columns:
            conn.execute("ALTER TABLE messages ADD COLUMN team_id TEXT DEFAULT NULL")
        if 'activation_epoch' not in columns:
            conn.execute("ALTER TABLE messages ADD COLUMN activation_epoch TEXT DEFAULT NULL")

        # Backfill missing/invalid team IDs before enforcing constraints
        conn.commit()

    migrate_team_ids()

    # Enforce strict team_id constraints via table rebuild if needed (file-locked)
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'")
        table_sql_row = cursor.fetchone()
        table_sql = table_sql_row[0] if table_sql_row else ""
        needs_migration = (
            "team_id TEXT NOT NULL" not in table_sql
            or "CHECK" not in table_sql
            or "GLOB" not in table_sql
        )
        if needs_migration:
            _run_schema_migration(conn)

        # Create indexes for performance
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_team ON messages(team_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_team_id ON messages(team_id, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_epoch ON messages(activation_epoch)")

        conn.commit()

    # Run pruning
    prune_expired_messages()

    # ABSOLUTE PURGE: Remove any NULL, empty, or non-numeric team_id messages
    # This ensures strict team isolation with zero legacy data leakage
    with db_connection() as conn:
        conn.execute("DELETE FROM messages WHERE team_id IS NULL")
        conn.execute("DELETE FROM messages WHERE team_id = ''")
        conn.execute("DELETE FROM messages WHERE team_id NOT GLOB '[0-9]*'")
        conn.execute("DELETE FROM messages WHERE team_id GLOB '*[^0-9]*'")
        conn.commit()


_INIT_DB_MAX_RETRIES = 3
_INIT_DB_BASE_DELAY = 1.0  # seconds


def init_db():
    """Initialize SQLite database for message relay.

    Guarded: runs once per DB path per process (skips if already initialized).
    Retries: up to 3 attempts with exponential backoff on sqlite3.OperationalError.
    """
    global _db_initialized_path
    if _db_initialized_path == DB_PATH:
        return

    last_error = None
    for attempt in range(_INIT_DB_MAX_RETRIES):
        try:
            _init_db_inner()
            _db_initialized_path = DB_PATH
            return
        except sqlite3.OperationalError as e:
            last_error = e
            delay = _INIT_DB_BASE_DELAY * (2 ** attempt)
            logger.warning(
                "init_db attempt %d/%d failed: %s (retrying in %.1fs)",
                attempt + 1, _INIT_DB_MAX_RETRIES, e, delay,
            )
            time.sleep(delay)

    raise sqlite3.OperationalError(
        f"init_db failed after {_INIT_DB_MAX_RETRIES} attempts: {last_error}"
    )


def strip_ansi(text: str) -> str:
    """Remove ANSI escape codes from text."""
    ansi_pattern = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]')
    return ansi_pattern.sub('', text)


def _fetch_messages(
    since_id: int = 0,
    agent_filter: Optional[str] = None,
    type_filter: Optional[str] = None,
    team_filter: Optional[str] = None,
    team_ids: Optional[List[int]] = None,
    activation_epoch: Optional[str] = None
) -> list:
    """
    Helper to fetch messages from DB with optional filters.

    Args:
        since_id: Only return messages after this ID
        agent_filter: Filter by sender agent
        type_filter: Filter by message type
        team_filter: Single team filter (legacy, for backward compatibility)
        team_ids: Multi-team filter list (P0-1.7). None = all teams (bridge/director mode)
        activation_epoch: Filter to messages from this activation epoch (BUG-12 fix).
                          None = no epoch filtering (matches all messages).

    Note: team_ids takes precedence over team_filter when both are provided.
    """
    init_db()
    with db_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # Build query dynamically based on filters
        query = "SELECT id, agent, content, type, ref_id, team_id, activation_epoch, timestamp FROM messages WHERE id > ?"
        params: List[Any] = [since_id]

        if agent_filter:
            query += " AND agent = ?"
            params.append(agent_filter)

        if type_filter:
            query += " AND type = ?"
            params.append(type_filter)

        # Multi-team filtering (P0-1.7)
        if team_ids is not None:
            # Explicit team list provided - filter to those teams
            if team_ids:
                placeholders = ",".join("?" * len(team_ids))
                query += f" AND team_id IN ({placeholders})"
                params.extend(str(t) for t in team_ids)
            else:
                # Empty list = return no results
                query += " AND 1=0"  # Always false condition
        elif team_filter:
            # Legacy single team filter (backward compatible)
            query += " AND team_id = ?"
            params.append(team_filter)
        # If neither team_ids nor team_filter: return all teams (bridge mode)

        # Activation epoch filtering (BUG-12 fix)
        if activation_epoch is not None:
            query += " AND (activation_epoch = ? OR activation_epoch IS NULL)"
            params.append(activation_epoch)

        query += " ORDER BY id"
        cursor.execute(query, params)

        rows = cursor.fetchall()

    return [
        {
            "id": row["id"],
            "agent": row["agent"],
            "content": row["content"],
            "type": row["type"],
            "ref_id": row["ref_id"],
            "team_id": row["team_id"],
            "activation_epoch": row["activation_epoch"],
            "timestamp": row["timestamp"]
        }
        for row in rows
    ]


@mcp.tool()
def get_agent_output(agent: str, lines: int = 200) -> str:
    """
    Get recent terminal output from another agent's tmux session.

    Args:
        agent: tmux session name (e.g., "claude", "gemini")
        lines: Number of lines to capture (default 200, max 1000)

    Returns:
        Cleaned terminal output with ANSI codes stripped
    """
    # Check cache first
    cached = get_cached_result(agent, "get_agent_output")
    if cached:
        return cached

    lines = min(lines, 1000)  # Cap at 1000 lines

    output = get_tmux_backend().capture_output(agent, lines=lines)
    final_output = output or f"(Session '{agent}' has no output)"

    # Update cache (only if not an error)
    if not final_output.startswith("Error:"):
        set_cached_result(agent, "get_agent_output", final_output)
    return final_output


@mcp.tool()
def post_message(
    agent: str,
    content: str,
    msg_type: str = "raw",
    ref_id: Optional[int] = None,
    push_to_clawdbot: bool = False,
    activation_epoch: Optional[str] = None
) -> dict:
    """
    Post a message to the shared relay for other agents to read.

    Args:
        agent: Identifier for the sending agent
        content: Message content
        msg_type: Message type (task, response, query, ack, status, raw)
        ref_id: Optional reference to parent message ID (for threading)
        push_to_clawdbot: If True, also push to Clawdbot gateway (P0-1.4)
        activation_epoch: Optional epoch identifier for session isolation (BUG-12 fix)

    Returns:
        Message ID and timestamp
    """
    # Extract team_id from agent name (before normalization for rate limiting key)
    team_id = extract_team(agent)

    # Normalize agent name via alias resolution (P0-2.5)
    original_agent = agent
    if team_id:
        agent = normalize_agent_name(agent, team_id)
        # Re-extract team_id if agent changed
        if agent != original_agent:
            team_id = extract_team(agent)

    # Rate limiting check (use normalized agent)
    if not _rate_limiter.acquire(agent):
        status = _rate_limiter.get_status(agent)
        return {
            "status": "rate_limited",
            "agent": agent,
            "error": f"Rate limit exceeded. Tokens available: {status['tokens_available']}",
            "retry_after_seconds": round(1.0 / _rate_limiter.tokens_per_second, 2)
        }

    if team_id is None:
        return {
            "status": "denied",
            "agent": agent,
            "error": f"Agent '{agent}' has no team assignment"
        }

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id, activation_epoch) VALUES (?, ?, ?, ?, ?, ?)",
            (agent, content, msg_type, ref_id, team_id, activation_epoch)
        )
        conn.commit()
        msg_id = cursor.lastrowid

    result = {
        "id": msg_id,
        "agent": agent,
        "type": msg_type,
        "ref_id": ref_id,
        "team_id": team_id,
        "activation_epoch": activation_epoch,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": "posted"
    }

    # Push to Clawdbot if requested (P0-1.4)
    if push_to_clawdbot:
        push_client = get_push_client()
        if push_client:
            try:
                # Parse content if JSON, otherwise wrap as string
                try:
                    data = json.loads(content)
                except (json.JSONDecodeError, TypeError):
                    data = {"content": content}

                push_event = PushEvent(
                    event=msg_type,
                    data=data,
                    session=agent
                )
                push_result = push_client.push(push_event)
                result["push_status"] = "success" if push_result.success else "failed"
                if not push_result.success:
                    result["push_error"] = push_result.error
            except Exception as e:
                # Graceful degradation: relay write succeeds even if push fails
                result["push_status"] = "failed"
                result["push_error"] = str(e)[:100]
        else:
            result["push_status"] = "skipped"
            result["push_error"] = "Push client not configured"

    return result


@mcp.tool()
def get_messages(
    requesting_agent: str,
    since_id: int = 0,
    agent_filter: Optional[str] = None,
    team_ids: Optional[List[int]] = None
) -> dict:
    """
    Retrieve messages from the relay.

    Args:
        requesting_agent: Agent making the request (REQUIRED for team-based filtering)
        since_id: Only return messages after this ID (default 0 = all)
        agent_filter: Optional filter by sender agent
        team_ids: Multi-team filter (P0-1.7). None = use requesting_agent's team.
                  Empty list [] = no teams. List [3,4] = filter to teams 3 and 4.
                  For bridge/director mode that needs ALL teams, pass team_ids=None
                  and use a privileged agent (e.g., "bridge-0" with team_id "0").

    Returns:
        Codex-safe envelope: ``{"status":"ok","messages":[...],"count":N,"timed_out":False}``.
        Denial path returns ``{"status":"denied","error":...}`` unchanged for backward compat.
    """
    # Validate requesting_agent is provided
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required for team isolation", "status": "denied"}

    # Derive team filter from requesting agent
    agent_team = enforce_team_filter(requesting_agent)

    # If no team (legacy agent), deny access for isolation
    if agent_team is None:
        return {"error": f"Agent '{requesting_agent}' has no team assignment", "status": "denied"}

    # Normalize agent_filter via alias resolution (P0-2.5)
    if agent_filter:
        agent_filter = normalize_agent_name(agent_filter, agent_team)

    # Multi-team mode (P0-1.7)
    if team_ids is not None:
        # Explicit team list provided - use it
        messages = _fetch_messages(since_id, agent_filter, team_ids=team_ids)
    else:
        # Default: filter to requesting agent's team (backward compatible)
        messages = _fetch_messages(since_id, agent_filter, team_filter=agent_team)
    return _messages_envelope(messages)


@mcp.tool()
def clear_team_messages(requesting_agent: str, team_id: str) -> dict:
    """
    Delete all messages for a team. Used during /team activate to prevent stale task pickup.

    Args:
        requesting_agent: Agent making the request (REQUIRED for team-based filtering)
        team_id: The team_id whose messages should be deleted

    Returns:
        Dict with status and count of deleted messages
    """
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required", "status": "denied"}

    if not team_id or not team_id.strip():
        return {"error": "team_id is required", "status": "denied"}

    # Validate team_id is numeric
    if not team_id.isdigit():
        return {"error": f"team_id must be numeric, got '{team_id}'", "status": "denied"}

    init_db()
    with db_connection() as conn:
        cursor = conn.execute("DELETE FROM messages WHERE team_id = ?", (team_id,))
        deleted = cursor.rowcount
        conn.commit()

    # Reset worker cursors for this team (BUG-11/12: prevent stale cursor state)
    cursors_reset = reset_team_cursors(team_id)

    # Audit log the clear action
    log_action(
        agent=requesting_agent,
        action="clear_team_messages",
        resource=f"team_{team_id}",
        outcome="success",
        metadata={"team_id": team_id, "messages_deleted": deleted, "cursors_reset": cursors_reset}
    )

    return {"status": "cleared", "team_id": team_id, "messages_deleted": deleted, "cursors_reset": cursors_reset}


@mcp.tool()
def debug_get_messages(
    requesting_agent: str,
    since_id: int = 0,
    agent_filter: Optional[str] = None
) -> dict:
    """
    Debug-only: retrieve messages across teams for authorized agents.

    Args:
        requesting_agent: Agent making the request (must be allowlisted)
        since_id: Only return messages after this ID (default 0 = all)
        agent_filter: Optional filter by sender agent

    Returns:
        Codex-safe envelope: ``{"status":"ok","messages":[...],"count":N,"timed_out":False}``.
        Denial path returns ``{"status":"denied","error":...}``.
    """
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required for debug access", "status": "denied"}

    allowlist = get_debug_allowlist()
    if requesting_agent not in allowlist:
        return {
            "error": f"Agent '{requesting_agent}' is not authorized for debug access",
            "status": "denied"
        }

    return _messages_envelope(_fetch_messages(since_id, agent_filter))


# ---------------------------------------------------------------------------
# Pair registry — N-pair tmux intercom isolation
# LOE-zeos-overseer-npair-tmux-intercom (2026-05-05)
# ---------------------------------------------------------------------------


@mcp.tool()
def register_pair(
    requesting_agent: str,
    pair_id: str,
    claude_session: Optional[str] = None,
    codex_session: Optional[str] = None,
    socket: str = "zeos-lanes",
    description: Optional[str] = None,
    team_id: Optional[str] = None,
) -> dict:
    """
    Register a tmux pair for N-pair intercom isolation.

    Authenticated. Auto-allocates a numeric team_id >= OVERSEER_PAIR_TEAM_ID_BASE
    (default 1000) when team_id is None. Idempotent on existing pair_id (updates
    participant fields and last_activity, but team_id is immutable post-creation).

    Returns the Codex-safe envelope ``{"status":"ok",...,"created":<bool>}`` on
    success, or the legacy denial dict ``{"status":"denied","error":"...","pair_id":...}``
    on rejection. Denial dicts NEVER include claude_session / codex_session / socket.

    Authorization:
      - Empty requesting_agent → denied.
      - Bare/legacy requester (no team via _requester_team) → denied.
      - Cross-team registration (explicit team_id != requester's team) → denied,
        unless requester is bridge-0.
      - Explicit team_id < OVERSEER_PAIR_TEAM_ID_BASE → ALWAYS denied (no override,
        bridge-0 inclusive). Legacy low-ID interop is a separate LOE.
      - Explicit team_id non-numeric → denied.
      - pair_id exists with a different supplied team_id → denied (immutable).
      - pair_id exists owned by a different team and requester is not bridge-0 → denied.
      - team_id collision with another pair_id → denied.
    """
    if not requesting_agent or not requesting_agent.strip():
        return _pair_denial("requesting_agent is required for pair registration",
                            pair_id=pair_id)

    if not pair_id or not pair_id.strip():
        return _pair_denial("pair_id is required for pair registration")

    requester_team = _requester_team(requesting_agent)
    bridge = _is_bridge(requesting_agent)
    if requester_team is None and not bridge:
        return _pair_denial(
            f"requester '{requesting_agent}' has no team assignment",
            pair_id=pair_id,
        )

    base = _pair_team_id_base()

    # Validate explicit team_id (numeric + >= BASE) BEFORE looking at existing rows.
    if team_id is not None:
        if not isinstance(team_id, str) or not team_id or not team_id.isdigit():
            return _pair_denial("team_id must be numeric", pair_id=pair_id)
        try:
            team_int = int(team_id)
        except ValueError:
            return _pair_denial("team_id must be numeric", pair_id=pair_id)
        if team_int < base:
            return _pair_denial(
                f"team_id {team_id} below OVERSEER_PAIR_TEAM_ID_BASE ({base})",
                pair_id=pair_id,
            )
        # Self-registration cross-team check (bridge-0 may register any team).
        if not bridge and requester_team is not None and team_id != requester_team:
            return _pair_denial(
                f"requester team {requester_team} cannot register team {team_id}",
                pair_id=pair_id,
            )

    init_db()
    with db_connection() as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(
            "SELECT * FROM pair_registry WHERE pair_id = ?", (pair_id,)
        )
        existing = cur.fetchone()

        if existing is not None:
            # Idempotent re-registration. Tombstoned (active=0) pair_ids are
            # retired and CANNOT be reactivated in this PR — reactivation is
            # a separate LOE. Treat the row as a hard reservation.
            try:
                existing_active = int(existing["active"])
            except (KeyError, IndexError, TypeError):
                # Pre-tombstone schema → treat as active.
                existing_active = 1
            if existing_active == 0:
                return _pair_denial(
                    f"pair_id '{pair_id}' is retired (tombstoned); "
                    f"reactivation is out of scope for this LOE",
                    pair_id=pair_id,
                )
            existing_team = existing["team_id"]
            if not bridge and requester_team != existing_team:
                return _pair_denial(
                    f"pair_id '{pair_id}' owned by team {existing_team}; "
                    f"requester is team {requester_team}",
                    pair_id=pair_id,
                )
            if team_id is not None and team_id != existing_team:
                return _pair_denial(
                    f"pair_id '{pair_id}' already registered to team_id "
                    f"{existing_team}; cannot rebind to {team_id}",
                    pair_id=pair_id,
                )
            conn.execute(
                """
                UPDATE pair_registry
                   SET claude_session = COALESCE(?, claude_session),
                       codex_session  = COALESCE(?, codex_session),
                       socket         = ?,
                       description    = COALESCE(?, description),
                       last_activity  = CURRENT_TIMESTAMP
                 WHERE pair_id = ?
                """,
                (claude_session, codex_session, socket, description, pair_id),
            )
            conn.commit()
            cur = conn.execute(
                "SELECT * FROM pair_registry WHERE pair_id = ?", (pair_id,)
            )
            row = cur.fetchone()
            payload = _pair_row_to_dict(row)
            payload.update({
                "status": "ok",
                "created": False,
                "requester": requesting_agent,
            })
            return payload

        # New pair: allocate team_id if not supplied.
        allocated = False
        if team_id is None:
            if requester_team is None and not bridge:
                # Defense in depth — already caught above, but be explicit.
                return _pair_denial(
                    f"requester '{requesting_agent}' has no team assignment",
                    pair_id=pair_id,
                )
            team_id = _pair_allocate_team_id(conn)
            allocated = True

        # UNIQUE(team_id) collision pre-check (gives a clean error string).
        # This catches BOTH active and tombstoned pair_registry rows — a
        # retired team_id is a permanent reservation.
        cur = conn.execute(
            "SELECT pair_id, active FROM pair_registry WHERE team_id = ?",
            (team_id,),
        )
        collision = cur.fetchone()
        if collision is not None:
            try:
                collision_active = int(collision["active"])
            except (KeyError, IndexError, TypeError):
                collision_active = 1
            if collision_active == 0:
                return _pair_denial(
                    f"team_id {team_id} is retired (previously held by "
                    f"pair_id '{collision['pair_id']}')",
                    pair_id=pair_id,
                )
            return _pair_denial(
                f"team_id {team_id} already registered to pair_id "
                f"'{collision['pair_id']}'",
                pair_id=pair_id,
            )

        # Stale-state guard: an explicit team_id with surviving rows on ANY
        # team-scoped surface (messages, heartbeats, worker_cursors,
        # pane_registry, audit_log, agent_aliases) and no current registry
        # owner would let the new pair inherit state from a previously
        # unregistered pair. Deny — there is no override.
        # Auto-allocation handles the same hazard via _pair_allocate_team_id.
        evidence = _team_in_use(conn, team_id)
        if evidence is not None:
            return _pair_denial(
                f"team_id {team_id} has existing {evidence} state and no "
                f"active registry owner; cannot bind a new pair to it",
                pair_id=pair_id,
            )

        try:
            conn.execute(
                """
                INSERT INTO pair_registry
                    (pair_id, team_id, claude_session, codex_session,
                     socket, description)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (pair_id, team_id, claude_session, codex_session,
                 socket, description),
            )
            conn.commit()
        except sqlite3.IntegrityError as exc:
            # Late-binding race condition (UNIQUE/CHECK).
            return _pair_denial(
                f"pair_registry insert failed: {exc}",
                pair_id=pair_id,
            )

        cur = conn.execute(
            "SELECT * FROM pair_registry WHERE pair_id = ?", (pair_id,)
        )
        row = cur.fetchone()

    payload = _pair_row_to_dict(row)
    payload.update({
        "status": "ok",
        "created": True,
        "requester": requesting_agent,
        "auto_allocated": allocated,
    })
    return payload


@mcp.tool()
def unregister_pair(requesting_agent: str, pair_id: str) -> dict:
    """
    Retire a pair from the active registry.

    Owner-only by default; bridge-0 may retire any pair. Tombstones the row
    (active=0, unregistered_at=CURRENT_TIMESTAMP) instead of DELETE so the
    team_id remains a permanent reservation and is never reused. Existing
    relay messages, heartbeats, cursors, pane registrations, and audit rows
    on that team_id are preserved as evidence.

    Reactivation of a tombstoned pair_id is out of scope for this LOE —
    re-registering one is denied.

    Idempotency: unregistering an already-tombstoned pair_id returns
    {"removed": False} — the row is already retired.

    Returns the original {"status":"ok","pair_id":...,"removed":<bool>}
    envelope unchanged for backward compatibility.
    """
    if not requesting_agent or not requesting_agent.strip():
        return _pair_denial("requesting_agent is required for pair unregistration",
                            pair_id=pair_id)
    if not pair_id or not pair_id.strip():
        return _pair_denial("pair_id is required for pair unregistration")

    requester_team = _requester_team(requesting_agent)
    bridge = _is_bridge(requesting_agent)
    if requester_team is None and not bridge:
        return _pair_denial(
            f"requester '{requesting_agent}' has no team assignment",
            pair_id=pair_id,
        )

    init_db()
    with db_connection() as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(
            "SELECT team_id, active FROM pair_registry WHERE pair_id = ?",
            (pair_id,),
        )
        row = cur.fetchone()
        if row is None:
            return {"status": "ok", "pair_id": pair_id, "removed": False}
        registered_team = row["team_id"]
        try:
            already_inactive = int(row["active"]) == 0
        except (KeyError, IndexError, TypeError):
            already_inactive = False
        if not bridge and requester_team != registered_team:
            return _pair_denial(
                f"pair_id '{pair_id}' owned by team {registered_team}; "
                f"requester is team {requester_team}",
                pair_id=pair_id,
            )
        if already_inactive:
            # Idempotent: pair is already tombstoned.
            return {"status": "ok", "pair_id": pair_id, "removed": False}
        conn.execute(
            "UPDATE pair_registry SET active = 0, "
            "unregistered_at = CURRENT_TIMESTAMP, "
            "last_activity = CURRENT_TIMESTAMP "
            "WHERE pair_id = ?",
            (pair_id,),
        )
        conn.commit()

    return {"status": "ok", "pair_id": pair_id, "removed": True}


@mcp.tool()
def list_pairs(requesting_agent: str, include_others: bool = False) -> dict:
    """
    List pairs visible to the requester.

    Default: returns ONLY the requester's own pair (matched via _requester_team).
    include_others=True requires bridge-0 — returns every pair in the registry.
    Codex-safe envelope; the bare-call shape of `list_agents` is preserved
    elsewhere — pair diagnostics live exclusively here.
    """
    if not requesting_agent or not requesting_agent.strip():
        return _pair_denial("requesting_agent is required for list_pairs")

    requester_team = _requester_team(requesting_agent)
    bridge = _is_bridge(requesting_agent)
    if requester_team is None and not bridge:
        return _pair_denial(
            f"requester '{requesting_agent}' has no team assignment"
        )

    if include_others and not bridge:
        return _pair_denial(
            "include_others=True requires bridge-0"
        )

    init_db()
    with db_connection() as conn:
        conn.row_factory = sqlite3.Row
        if include_others:
            # Bridge view: include tombstoned pairs as evidence/audit (active
            # field is in the payload so callers can filter).
            cur = conn.execute(
                "SELECT * FROM pair_registry "
                "ORDER BY CAST(team_id AS INTEGER)"
            )
        else:
            # Default: requester's own ACTIVE pair only. Tombstoned rows on
            # the same team_id are not surfaced — the requester typically
            # already moved on to a new pair_id by then.
            cur = conn.execute(
                "SELECT * FROM pair_registry WHERE team_id = ? AND active = 1 "
                "ORDER BY CAST(team_id AS INTEGER)",
                (requester_team,),
            )
        rows = cur.fetchall()

    pairs = [_pair_row_to_dict(r) for r in rows]
    return {"status": "ok", "pairs": pairs, "count": len(pairs)}


@mcp.tool()
def resolve_pair(
    requesting_agent: str,
    pair_id: Optional[str] = None,
    team_id: Optional[str] = None,
) -> dict:
    """
    Authenticated pair metadata lookup.

    Exactly one of pair_id / team_id must be supplied. Default scope:
    requester can resolve only its own pair (matching _requester_team).
    Cross-pair resolution requires bridge-0. Sensitive metadata
    (claude_session / codex_session / socket) is included on success only;
    denials NEVER expose any of those fields.
    """
    if not requesting_agent or not requesting_agent.strip():
        return _pair_denial("requesting_agent is required for resolve_pair",
                            pair_id=pair_id)

    if (pair_id is None) == (team_id is None):
        return _pair_denial(
            "exactly one of pair_id or team_id must be provided",
            pair_id=pair_id,
        )

    requester_team = _requester_team(requesting_agent)
    bridge = _is_bridge(requesting_agent)
    if requester_team is None and not bridge:
        return _pair_denial(
            f"requester '{requesting_agent}' has no team assignment",
            pair_id=pair_id,
        )

    init_db()
    with db_connection() as conn:
        conn.row_factory = sqlite3.Row
        if pair_id is not None:
            cur = conn.execute(
                "SELECT * FROM pair_registry WHERE pair_id = ?", (pair_id,)
            )
        else:
            cur = conn.execute(
                "SELECT * FROM pair_registry WHERE team_id = ?", (team_id,)
            )
        row = cur.fetchone()

    if row is None:
        out = {"status": "not_found"}
        if pair_id is not None:
            out["pair_id"] = pair_id
        if team_id is not None:
            out["team_id"] = team_id
        return out

    target_team = row["team_id"]
    if not bridge and requester_team != target_team:
        # Metadata-leak guard: do NOT include claude_session/codex_session/socket
        # in this denial dict. Only echo the requested pair_id (which the caller
        # already knows).
        return _pair_denial(
            f"requester team {requester_team} cannot resolve pair on team {target_team}",
            pair_id=row["pair_id"],
        )

    return {"status": "ok", "pair": _pair_row_to_dict(row)}


@mcp.tool()
def subscribe(
    requesting_agent: str,
    since_id: int = 0,
    timeout: int = 30,
    filter_type: Optional[str] = None,
    filter_agent: Optional[str] = None,
    team_ids: Optional[List[int]] = None
) -> dict:
    """
    Subscribe to new messages (long-polling).
    Blocks until a matching message > since_id arrives or timeout is reached.

    Args:
        requesting_agent: Agent making the request (REQUIRED for team-based filtering)
        since_id: The last message ID the client has seen.
        timeout: Max seconds to wait (default 30).
        filter_type: Only return messages of this type (e.g., "heartbeat", "task_assign")
        filter_agent: Only return messages from this agent
        team_ids: Multi-team filter (P0-1.7). None = use requesting_agent's team.
                  List [3,4] = filter to teams 3 and 4 only.
                  For bridge/director mode observing ALL teams, use special agent like "bridge-0".

    Returns:
        Codex-safe envelope:
            ``{"status":"ok","messages":[...],"count":N,"timed_out":<bool>}``
        ``timed_out=True`` indicates the long-poll elapsed without any matching
        message; ``messages`` will be empty in that case.
        Denial path returns ``{"status":"denied","error":...}``.

    Example:
        # Director listening only for heartbeats from own team
        subscribe(requesting_agent="gemini-3", since_id=100, timeout=60, filter_type="heartbeat")

        # Bridge observing multiple teams
        subscribe(requesting_agent="bridge-0", since_id=100, team_ids=[3, 4, 5])
    """
    # Validate requesting_agent is provided
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required for team isolation", "status": "denied"}

    # Derive team filter from requesting agent
    agent_team = enforce_team_filter(requesting_agent)

    # If no team (legacy agent), deny access for isolation
    if agent_team is None:
        return {"error": f"Agent '{requesting_agent}' has no team assignment", "status": "denied"}

    start_time = time.time()

    # Determine fetch mode
    if team_ids is not None:
        # Multi-team mode (P0-1.7)
        fetch_kwargs = {"team_ids": team_ids}
    else:
        # Legacy single-team mode
        fetch_kwargs = {"team_filter": agent_team}

    # Check immediately first
    messages = _fetch_messages(since_id, agent_filter=filter_agent, type_filter=filter_type, **fetch_kwargs)
    if messages:
        return _messages_envelope(messages)

    poll_interval = min(30.0, max(0.5, timeout / 2))  # Scale poll interval to timeout
    while (time.time() - start_time) < timeout:
        remaining = timeout - (time.time() - start_time)
        if remaining <= 0:
            break
        time.sleep(min(poll_interval, remaining))
        messages = _fetch_messages(since_id, agent_filter=filter_agent, type_filter=filter_type, **fetch_kwargs)
        if messages:
            return _messages_envelope(messages)

    return _messages_envelope([], timed_out=True)


@mcp.tool()
def send_to_agent(
    agent: str,
    message: str,
    interrupt_if_busy: bool = False,
    execute: bool = True,
    verify: bool = True
) -> dict:
    """
    Send a message to another agent's tmux session (types into their terminal).

    WARNING: This will type the message into the target terminal.
    Use with caution.

    Args:
        agent: tmux session name
        message: Text to send
        interrupt_if_busy: If True and agent is WORKING, send C-c first to interrupt
        execute: If True, send a carriage return (C-m) after the message
        verify: If True, wait 3s and verify output activity

    Returns:
        Status of the send operation with pre-flight state and verification
    """
    # Rate limiting check (uses "terminal:{agent}" key to separate from relay messages)
    rate_key = f"terminal:{agent}"
    if not _rate_limiter.acquire(rate_key):
        status = _rate_limiter.get_status(rate_key)
        return {
            "status": "rate_limited",
            "agent": agent,
            "error": f"Rate limit exceeded. Tokens available: {status['tokens_available']}",
            "retry_after_seconds": round(1.0 / _rate_limiter.tokens_per_second, 2)
        }

    try:
        # Pre-flight: detect agent state (busy-check)
        pre_state = detect_state(agent)
        agent_state = pre_state.get("state", AgentState.UNKNOWN.value)
        pre_output = _capture_tmux_output(agent, lines=20)
        pre_hash = _terminal_output_hash(pre_output)

        # Handle busy agent
        if agent_state == AgentState.WORKING.value:
            if interrupt_if_busy:
                # Send C-c to interrupt current operation
                get_tmux_backend().send_keys(agent, "C-c")
                time.sleep(0.3)  # Brief pause for interrupt to process
            else:
                return {
                    "status": "blocked",
                    "agent": agent,
                    "agent_state": agent_state,
                    "error": "Agent is WORKING. Set interrupt_if_busy=True to interrupt."
                }

        # Step 1: Send the message text
        if message:
            result = get_tmux_backend().send_keys(agent, message)
            if result.returncode != 0:
                return {
                    "status": "error",
                    "agent": agent,
                    "error": f"tmux send-keys failed: {result.stderr.decode()}"
                }

        # Step 2: Settle delay — wait for tmux to fully render the message
        # text into the target pane's input buffer before sending Enter.
        # Without this, C-m can arrive before the text is fully injected,
        # leaving the message stranded in the input field unsent.
        if message and execute:
            time.sleep(3.0)

        # Step 3: Send the explicit carriage return (C-m) if execute=True
        if execute:
            result = get_tmux_backend().send_keys(agent, "C-m")
            if result.returncode != 0:
                return {
                    "status": "error",
                    "agent": agent,
                    "error": f"tmux send-keys C-m failed: {result.stderr.decode()}"
                }

        response = {
            "status": "sent",
            "agent": agent,
            "message_length": len(message),
            "pre_state": agent_state,
            "execute": execute
        }

        # Unified Post-send verification (Single 3s pass)
        if verify:
            time.sleep(3.0)  # Allow time for message to appear and prompt to update
            post_output = _capture_tmux_output(agent, lines=20)
            post_hash = _terminal_output_hash(post_output)
            
            # Text-based verification
            message_preview = message[:50] if len(message) > 50 else message
            response["verified"] = message_preview in post_output
            
            # Visual/Hash-based verification
            visual_verified = (pre_hash != post_hash)
            response["visual_verified"] = visual_verified
            
            # Update state cache and response
            if agent in _tool_cache:
                _tool_cache[agent].pop("detect_state", None)
            post_state_info = detect_state(agent)
            response["post_state"] = post_state_info.get("state", AgentState.UNKNOWN.value)
            
            if not visual_verified and execute:
                response["visual_warning"] = "No terminal activity detected after execution signal"

        return response

    except subprocess.TimeoutExpired:
        return {"status": "error", "error": f"Timeout sending to session '{agent}'"}
    except FileNotFoundError:
        return {"status": "error", "error": "tmux is not installed or not in PATH"}


@mcp.tool()
def activate_dev_team(director: str, agents: List[str]) -> dict:
    """
    Activate a dev team by launching workers in existing agent sessions.

    Args:
        director: Agent making the request (team-gated)
        agents: List of agent session names to activate

    Returns:
        Dict with per-agent activation status
    """
    if not director or not director.strip():
        return {"error": "director is required for team activation", "status": "denied"}

    team_filter = enforce_team_filter(director)
    if team_filter is None:
        return {"error": f"Agent '{director}' has no team assignment", "status": "denied"}

    results: Dict[str, Any] = {}
    for agent in agents:
        try:
            enforce_team_filter(director, agent)
        except ValueError as exc:
            results[agent] = {"status": "denied", "error": str(exc)}
            continue

        state_info = detect_state(agent)
        agent_state = state_info.get("state", AgentState.UNKNOWN.value)
        if agent_state != AgentState.IDLE.value:
            results[agent] = {
                "status": "skipped",
                "reason": "not idle",
                "agent_state": agent_state
            }
            continue

        role = infer_role(agent, team_filter)
        role_label = role.value.upper() if role else "UNASSIGNED"
        activation_message = (
            f"ACTIVATION: You are {role_label}. Monitor relay for tasks."
        )
        send_result = send_to_agent(agent, activation_message, verify=True)
        if send_result.get("status") == "sent" and send_result.get("visual_verified"):
            results[agent] = {
                "status": "activated",
                "send_status": send_result.get("status"),
                "pre_state": send_result.get("pre_state"),
                "visual_verified": send_result.get("visual_verified")
            }
        elif send_result.get("status") == "sent":
            results[agent] = {
                "status": "unverified",
                "send_status": send_result.get("status"),
                "pre_state": send_result.get("pre_state"),
                "visual_verified": send_result.get("visual_verified"),
                "warning": send_result.get("visual_warning")
            }
        else:
            results[agent] = {
                "status": "error",
                "send_status": send_result.get("status"),
                "error": send_result.get("error")
            }

    return results


@mcp.tool()
def list_agents() -> list:
    """
    List all running tmux sessions that could be agents.

    Returns:
        List of tmux session names
    """
    return get_tmux_backend().list_agents()


# Singleton detector instance
_detector = StateDetector()


@mcp.tool()
def detect_state(agent: str) -> dict:
    """
    Detect the current operational state of an agent.

    Args:
        agent: tmux session name (e.g., "claude", "gemini")

    Returns:
        Dict with agent, state, and confidence level
    """
    # 1. Primary: Check Heartbeat Registry (Explicit Signaling)
    # Coordination Multiplier Evolution: Trust self-reported state if fresh
    heartbeat = _heartbeat_registry.get(agent)
    if heartbeat:
        last_epoch = heartbeat.get("epoch", 0)
        time_since_heartbeat = time.time() - last_epoch
        explicit_state = heartbeat.get("state")
        
        # If heartbeat is fresh (<90s) and has explicit state, use it
        if explicit_state and time_since_heartbeat < (HEARTBEAT_INTERVAL_SEC * 1.5):
            return {
                "agent": agent,
                "state": explicit_state,
                "confidence": "total",  # Explicit signaling = absolute truth
                "source": "heartbeat",
                "seconds_since_update": int(time_since_heartbeat)
            }

    # 2. Secondary: Check Tool Cache
    cached = get_cached_result(agent, "detect_state")
    if cached:
        return cached

    # 3. Fallback: Heuristic Analysis (Regex)
    output = get_agent_output(agent, lines=50)

    if output.startswith("Error:"):
        return {
            "agent": agent,
            "state": AgentState.UNKNOWN.value,
            "confidence": "none",
            "error": output
        }

    # Normalize numbered agent names (e.g., "c-2" -> "claude", "g-2" -> "gemini")
    base_agent = agent.split('-')[0] if '-' in agent and agent.split('-')[-1].isdigit() else agent
    # Map short prefixes to full agent names for heuristic lookup
    prefix_map = {"c": "claude", "d": "claude", "o": "claude", "g": "gemini", "x": "codex", "k": "kimi", "r": "goose"}
    base_agent = prefix_map.get(base_agent, base_agent)

    state = _detector.detect(base_agent, output)
    confidence = "high" if base_agent in _detector.heuristics else "low"

    result = {
        "agent": agent,
        "state": state.value,
        "confidence": confidence,
        "source": "heuristic"
    }
    
    # Update cache
    set_cached_result(agent, "detect_state", result)
    return result


@mcp.tool()
def listen_for_task(worker_name: str, timeout: int = 60, since_id: int = 0,
                    activation_epoch: Optional[str] = None) -> dict:
    """
    Listen for task assignments addressed to this worker (Team Protocol).

    Blocks until a TASK_ASSIGN message with matching assigned_to arrives,
    or timeout is reached. Only receives tasks from same team.

    Args:
        worker_name: The worker's identifier (e.g., "claude-3", "codex-2")
        timeout: Max seconds to wait (default 60)
        since_id: Only consider messages after this ID (default 0)
        activation_epoch: Only receive tasks from this activation epoch (BUG-12 fix).
                          None = no epoch filtering (backward compatible).

    Returns:
        Dict with task assignment or empty result on timeout
    """
    import json

    # Validate worker_name is provided
    if not worker_name or not worker_name.strip():
        return {"error": "worker_name is required", "status": "denied"}

    # Normalize worker_name via alias resolution (P0-2.5)
    # Try normalization first - it handles team lookup internally
    original_worker = worker_name
    worker_name = normalize_agent_name(worker_name, None)  # Global lookup

    # Derive team from (normalized) worker name for filtering
    team_filter = extract_team(worker_name)

    # If no team (legacy agent), deny access for isolation
    if team_filter is None:
        return {"error": f"Worker '{original_worker}' has no team assignment", "status": "denied"}

    # Cap timeout at 50s to stay safely under MCP client 60s transport limit
    timeout = min(timeout, 50)

    # Idle watchdog: track subscribe loop entry
    now = time.time()
    if worker_name not in _subscribe_registry:
        _subscribe_registry[worker_name] = {
            "first_listen": now, "last_listen": now,
            "listen_count": 1, "last_task_received": None,
            "team_id": team_filter,
        }
    else:
        _subscribe_registry[worker_name]["last_listen"] = now
        _subscribe_registry[worker_name]["listen_count"] += 1

    # BUG-11 fix: Use server-side cursor to avoid since_id skip problem.
    # The cursor tracks the last task_assign message ID this worker consumed,
    # independent of heartbeat or other message IDs that may leapfrog tasks.
    task_cursor = get_task_cursor(worker_name, team_filter)
    effective_cursor = max(task_cursor, since_id)

    start_time = time.time()

    while (time.time() - start_time) < timeout:
        # Fetch only task_assign messages from same team, using effective cursor
        messages = _fetch_messages(effective_cursor, type_filter="task_assign",
                                   team_filter=team_filter, activation_epoch=activation_epoch)

        for msg in messages:
            try:
                payload = json.loads(msg.get("content", "{}"))
                # Check if assigned to this worker
                if payload.get("assigned_to") == worker_name:
                    # Idle watchdog: mark task received
                    if worker_name in _subscribe_registry:
                        _subscribe_registry[worker_name]["last_task_received"] = time.time()
                    # Persist cursor ONLY on match — non-matching tasks
                    # advance local effective_cursor but not the DB cursor
                    update_task_cursor(worker_name, team_filter, msg["id"])
                    # BUG-8 fix: Auto-ACK so dispatch_task_sync can detect delivery.
                    # Workers post ad-hoc ACKs (type="ack", no ref_id) which don't
                    # match dispatch_task_sync's query (type="task_accept", ref_id=msg_id).
                    # This server-side ACK is deterministic and immediate.
                    try:
                        ack_content = json.dumps({
                            "worker": worker_name,
                            "task_id": payload.get("task_id", ""),
                            "status": "accepted"
                        })
                        with db_connection() as ack_conn:
                            ack_cursor = ack_conn.cursor()
                            ack_cursor.execute(
                                "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
                                (worker_name, ack_content, "task_accept", msg["id"], team_filter)
                            )
                            ack_conn.commit()
                    except Exception:
                        pass  # Best-effort — don't block task delivery on ACK failure
                    return {
                        "status": "task_received",
                        "message_id": msg["id"],
                        "task": payload,
                        "team_id": msg.get("team_id"),
                        "activation_epoch": msg.get("activation_epoch"),
                        "timestamp": msg["timestamp"]
                    }
            except json.JSONDecodeError:
                pass

            # Advance local cursor past this message to avoid re-checking
            effective_cursor = max(effective_cursor, msg["id"])

        time.sleep(5.0)  # Poll every 5s for responsive task pickup (was 30s)

    return {
        "status": "timeout",
        "worker": worker_name,
        "team_id": team_filter,
        "waited_seconds": timeout
    }


@mcp.tool()
def dispatch_task(
    director: str,
    worker: str,
    task_id: str,
    description: str,
    priority: str = "medium",
    context: Optional[str] = None,
    activation_epoch: Optional[str] = None,
    target_team: Optional[str] = None
) -> dict:
    """
    Dispatch a task to a worker (Team Protocol - Director use).

    Sends a TASK_ASSIGN message with proper structure.
    Director and worker must be on the same team, OR an unaffiliated
    operator can specify target_team to dispatch cross-team.

    Args:
        director: The director's identifier (sender)
        worker: Target worker's identifier (assigned_to)
        task_id: Unique task identifier
        description: Task description
        priority: low|medium|high|critical (default medium)
        context: Optional JSON string with additional context
        activation_epoch: Optional epoch identifier for session isolation (BUG-12 fix)
        target_team: Optional team ID for external operator dispatch.
            Only unaffiliated agents (no team suffix) may use this.

    Returns:
        Message posting result with task details
    """
    import json

    director_team = extract_team(director)

    # External operator override: unaffiliated agent dispatches to a specific team
    if target_team:
        if director_team is not None:
            return {
                "status": "error",
                "error": f"target_team rejected: '{director}' already on team '{director_team}'",
                "director": director, "worker": worker
            }
        if not target_team.isdigit():
            return {
                "status": "error",
                "error": f"target_team must be numeric, got '{target_team}'",
                "director": director, "worker": worker
            }
        worker = normalize_agent_name(worker, target_team)
        worker_team = extract_team(worker)
        if worker_team and worker_team != target_team:
            return {
                "status": "error",
                "error": f"Worker '{worker}' is on team {worker_team}, not target_team {target_team}",
                "director": director, "worker": worker
            }
        team_id = target_team
    else:
        # Standard same-team dispatch
        if director_team:
            worker = normalize_agent_name(worker, director_team)
        try:
            team_id = enforce_team_filter(director, worker)
        except ValueError as e:
            return {
                "status": "error",
                "error": str(e),
                "director": director,
                "worker": worker
            }

    # Guard: team_id must resolve to a valid numeric string for DB constraint
    if not team_id or not str(team_id).isdigit():
        return {
            "status": "error",
            "error": "No team resolved. Use target_team param for unaffiliated dispatch.",
            "director": director, "worker": worker
        }

    # Build task payload
    task_payload = {
        "task_id": task_id,
        "description": description,
        "assigned_to": worker,
        "priority": priority,
        "parent_task_id": None,
        "context": json.loads(context) if context else None,
        "acceptance_criteria": [],
        "deadline_seconds": None,
        "team_id": team_id
    }

    # Use post_message with TASK_ASSIGN type
    content = json.dumps(task_payload)

    # Bypass rate limiter for director dispatches? No - keep it fair
    if not _rate_limiter.acquire(director):
        status = _rate_limiter.get_status(director)
        return {
            "status": "rate_limited",
            "director": director,
            "error": f"Rate limit exceeded. Tokens available: {status['tokens_available']}",
            "retry_after_seconds": round(1.0 / _rate_limiter.tokens_per_second, 2)
        }

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id, activation_epoch) VALUES (?, ?, ?, ?, ?, ?)",
            (director, content, "task_assign", None, team_id, activation_epoch)
        )
        conn.commit()
        msg_id = cursor.lastrowid

    return {
        "status": "dispatched",
        "message_id": msg_id,
        "task_id": task_id,
        "assigned_to": worker,
        "team_id": team_id,
        "activation_epoch": activation_epoch,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@mcp.tool()
def dispatch_task_sync(
    director: str,
    worker: str,
    task_id: str,
    description: str,
    priority: str = "medium",
    context: Optional[str] = None,
    ack_timeout: int = 30,
    activation_epoch: Optional[str] = None,
    target_team: Optional[str] = None
) -> dict:
    """
    Dispatch a task and wait for worker acknowledgement (Positive ACK Loop).

    Sends TASK_ASSIGN and blocks until TASK_ACCEPT is received or timeout.

    Args:
        director: The director's identifier (sender)
        worker: Target worker's identifier (assigned_to)
        task_id: Unique task identifier
        description: Task description
        priority: low|medium|high|critical (default medium)
        context: Optional JSON string with additional context
        ack_timeout: Seconds to wait for ACK (default 30)
        activation_epoch: Optional epoch identifier for session isolation (BUG-12 fix)
        target_team: Optional team ID for external operator dispatch.
            Only unaffiliated agents (no team suffix) may use this.

    Returns:
        Dict with status: "accepted" (success) or "timeout" (no ACK received)
    """
    # First dispatch the task
    dispatch_result = dispatch_task(
        director, worker, task_id, description, priority, context,
        activation_epoch, target_team
    )

    if dispatch_result.get("status") != "dispatched":
        return dispatch_result  # Error or rate limited

    msg_id = dispatch_result["message_id"]
    team_id = dispatch_result["team_id"]

    # Wait for TASK_ACCEPT referencing our message
    start_time = time.time()
    poll_interval = 2.0

    while (time.time() - start_time) < ack_timeout:
        # Query for task_accept messages referencing our dispatch
        with db_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                """SELECT id, agent, content, type, ref_id, timestamp
                   FROM messages
                   WHERE type = 'task_accept' AND ref_id = ? AND team_id = ?
                   ORDER BY id DESC LIMIT 1""",
                (msg_id, team_id)
            )
            row = cursor.fetchone()

        if row:
            return {
                "status": "accepted",
                "message_id": msg_id,
                "ack_message_id": row["id"],
                "task_id": task_id,
                "worker": worker,
                "team_id": team_id,
                "ack_timestamp": row["timestamp"]
            }

        time.sleep(poll_interval)

    # Timeout - no ACK received
    return {
        "status": "timeout",
        "message_id": msg_id,
        "task_id": task_id,
        "worker": worker,
        "team_id": team_id,
        "error": f"Worker did not acknowledge within {ack_timeout}s"
    }


# =============================================================================
# Coordination Multiplier Evolution: Heartbeat Protocol
# =============================================================================

def compute_terminal_hash(agent: str) -> str:
    """Compute hash of agent's terminal output for activity detection."""
    output = get_agent_output(agent, lines=50)
    return hashlib.sha256(output[-500:].encode()).hexdigest()[:8]


@mcp.tool()
def post_heartbeat(
    worker: str,
    task_id: str,
    progress_pct: int = 0,
    current_action: str = "",
    state: Optional[str] = None,
    terminal_hash: Optional[str] = None,
    current_milestone: str = ""
) -> dict:
    """
    Post a heartbeat from a worker (Coordination Multiplier Protocol).

    Workers should call this every 60s during active task execution
    to signal progress and prove activity.

    Args:
        worker: Worker identifier (e.g., "claude-1", "codex-2")
        task_id: Current task being executed
        progress_pct: Estimated progress percentage (0-100)
        current_action: Brief description of current action
        state: Explicit state (idle, working, waiting)
        terminal_hash: SHA256 hash of terminal output (auto-computed if None)
        current_milestone: Current milestone in task execution (P1-1.2)

    Returns:
        Heartbeat confirmation with registry status
    """
    now = time.time()
    timestamp = datetime.now(timezone.utc).isoformat()

    # Extract team_id from worker name
    team_id = extract_team(worker)
    if team_id is None:
        return {
            "status": "denied",
            "worker": worker,
            "error": f"Worker '{worker}' has no team assignment"
        }

    # Auto-compute terminal hash if not provided
    if terminal_hash is None:
        terminal_hash = compute_terminal_hash(worker)

    # Build heartbeat payload
    heartbeat_data = {
        "worker": worker,
        "task_id": task_id,
        "progress_pct": progress_pct,
        "current_action": current_action,
        "current_milestone": current_milestone,
        "state": state,
        "terminal_hash": terminal_hash,
        "team_id": team_id,
        "timestamp": timestamp,
        "epoch": now
    }

    # Check for frozen condition (same hash as previous heartbeat)
    previous = _heartbeat_registry.get(worker)
    frozen_warning = False
    if previous and previous.get("terminal_hash") == terminal_hash:
        time_since_change = now - previous.get("hash_changed_at", now)
        if time_since_change > STUCK_THRESHOLD_SEC:
            frozen_warning = True
            heartbeat_data["frozen_warning"] = True
            heartbeat_data["static_duration_sec"] = int(time_since_change)
    else:
        heartbeat_data["hash_changed_at"] = now

    # Preserve hash_changed_at if hash unchanged
    if previous and previous.get("terminal_hash") == terminal_hash:
        heartbeat_data["hash_changed_at"] = previous.get("hash_changed_at", now)

    # Update registry
    _heartbeat_registry[worker] = heartbeat_data

    # Post to relay for Director visibility + persist to heartbeats table
    content = json.dumps(heartbeat_data)
    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
            (worker, content, "heartbeat", None, team_id)
        )
        # Dual-write: persist to heartbeats table for cross-process visibility
        cursor.execute(
            """INSERT OR REPLACE INTO heartbeats
               (worker, team_id, task_id, progress_pct, current_action, current_milestone,
                state, terminal_hash, frozen_warning, hash_changed_at, epoch, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (worker, team_id or "", task_id, progress_pct, current_action, current_milestone,
             state, terminal_hash, 1 if frozen_warning else 0,
             heartbeat_data.get("hash_changed_at", now), now, timestamp)
        )
        conn.commit()
        msg_id = cursor.lastrowid

    return {
        "status": "heartbeat_posted",
        "message_id": msg_id,
        "worker": worker,
        "task_id": task_id,
        "team_id": team_id,
        "frozen_warning": frozen_warning,
        "timestamp": timestamp
    }


@mcp.tool()
def get_worker_heartbeats(
    requesting_agent: str,
    workers: Optional[List[str]] = None
) -> dict:
    """
    Get latest heartbeat status for workers (Director use).

    Args:
        requesting_agent: Agent making the request (REQUIRED for team-based filtering)
        workers: List of worker names to query (None = all workers in same team)

    Returns:
        Dict with worker heartbeat status and health assessment
    """
    # Validate requesting_agent is provided
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required for team isolation", "status": "denied"}

    # Derive team filter from requesting agent
    team_filter = enforce_team_filter(requesting_agent)

    # If no team (legacy agent), deny access for isolation
    if team_filter is None:
        return {"error": f"Agent '{requesting_agent}' has no team assignment", "status": "denied"}

    now = time.time()

    result = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "team_id": team_filter,
        "workers": {}
    }

    # If workers specified, use those; otherwise get all from registry
    if workers:
        target_workers = workers
    else:
        target_workers = list(_heartbeat_registry.keys())

        # Cross-process fallback: discover workers from heartbeats table
        # (indexed primary key lookup, not full relay scan)
        if not target_workers:
            try:
                init_db()
                with db_connection() as conn:
                    cursor = conn.cursor()
                    cursor.execute(
                        "SELECT DISTINCT worker FROM heartbeats WHERE team_id = ?",
                        (team_filter,)
                    )
                    target_workers = [r[0] for r in cursor.fetchall()]
            except Exception:
                pass

    for worker in target_workers:
        # Filter by team if team_filter is set
        worker_team = extract_team(worker)
        if team_filter and worker_team and worker_team != team_filter:
            continue  # Skip workers from other teams

        heartbeat = _heartbeat_registry.get(worker)

        # Cross-process fallback: query heartbeats table (indexed PK lookup)
        if not heartbeat:
            try:
                init_db()
                with db_connection() as conn:
                    cursor = conn.cursor()
                    cursor.execute(
                        "SELECT task_id, progress_pct, current_action, current_milestone, "
                        "state, terminal_hash, frozen_warning, hash_changed_at, epoch, timestamp "
                        "FROM heartbeats WHERE worker = ? AND team_id = ?",
                        (worker, team_filter)
                    )
                    row = cursor.fetchone()
                if row:
                    heartbeat = {
                        "task_id": row[0], "progress_pct": row[1],
                        "current_action": row[2], "current_milestone": row[3],
                        "state": row[4], "terminal_hash": row[5],
                        "frozen_warning": bool(row[6]), "hash_changed_at": row[7],
                        "epoch": row[8], "timestamp": row[9],
                        "team_id": team_filter, "worker": worker
                    }
            except Exception:
                pass

        if not heartbeat:
            result["workers"][worker] = {
                "status": "no_heartbeat",
                "last_seen": None
            }
            continue

        last_epoch = heartbeat.get("epoch", 0)
        time_since_heartbeat = now - last_epoch

        # Determine health status
        if time_since_heartbeat > CRASHED_THRESHOLD_SEC:
            health = "CRASHED"
        elif heartbeat.get("frozen_warning"):
            health = "STUCK"
        elif time_since_heartbeat > HEARTBEAT_INTERVAL_SEC * 2:
            health = "STALE"
        else:
            health = "HEALTHY"

        result["workers"][worker] = {
            "status": health,
            "task_id": heartbeat.get("task_id"),
            "progress_pct": heartbeat.get("progress_pct", 0),
            "current_action": heartbeat.get("current_action", ""),
            "terminal_hash": heartbeat.get("terminal_hash"),
            "team_id": heartbeat.get("team_id"),
            "last_heartbeat": heartbeat.get("timestamp"),
            "seconds_since_heartbeat": int(time_since_heartbeat)
        }

    return result


@mcp.tool()
def get_task_progress(
    requesting_agent: str,
    task_id: str
) -> dict:
    """
    Get progress information for a specific task (P1-1.3).

    Queries heartbeat registry for the worker currently executing the task
    and returns progress details.

    Args:
        requesting_agent: Agent making the request (REQUIRED for team-based filtering)
        task_id: Task ID to query progress for

    Returns:
        Dict with progress_pct, milestone, worker, last_updated (or empty if not found)
    """
    # Validate requesting_agent is provided
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required for team isolation", "status": "denied"}

    # Derive team filter from requesting agent
    team_filter = enforce_team_filter(requesting_agent)

    if team_filter is None:
        return {"error": f"Agent '{requesting_agent}' has no team assignment", "status": "denied"}

    # Search heartbeat registry for task_id
    for worker, heartbeat in _heartbeat_registry.items():
        if heartbeat.get("task_id") == task_id:
            # Verify same team
            worker_team = extract_team(worker)
            if team_filter and worker_team and worker_team != team_filter:
                continue  # Skip workers from other teams

            return {
                "task_id": task_id,
                "worker": worker,
                "progress_pct": heartbeat.get("progress_pct", 0),
                "milestone": heartbeat.get("current_milestone", ""),
                "current_action": heartbeat.get("current_action", ""),
                "state": heartbeat.get("state"),
                "last_updated": heartbeat.get("timestamp"),
                "team_id": heartbeat.get("team_id")
            }

    # Cross-process fallback: query heartbeats table
    try:
        init_db()
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT worker, progress_pct, current_milestone, current_action, "
                "state, timestamp, team_id FROM heartbeats "
                "WHERE task_id = ? AND team_id = ?",
                (task_id, team_filter)
            )
            row = cursor.fetchone()
        if row:
            return {
                "task_id": task_id,
                "worker": row[0],
                "progress_pct": row[1],
                "milestone": row[2],
                "current_action": row[3],
                "state": row[4],
                "last_updated": row[5],
                "team_id": row[6]
            }
    except Exception:
        pass

    # Task not found in any active heartbeat
    return {}


# Singleton summarizer instance
_summarizer = TaskSummarizer()


@mcp.tool()
def get_audit_log(
    requesting_agent: str,
    since_timestamp: Optional[str] = None,
    action_filter: Optional[str] = None,
    limit: int = 100
) -> list:
    """
    Retrieve audit log entries (P1-4.3).

    Args:
        requesting_agent: Agent making the request (REQUIRED for team-based filtering)
        since_timestamp: Only return entries after this ISO timestamp (optional)
        action_filter: Filter by action type (e.g., "dispatch_task")
        limit: Maximum entries to return (default 100, max 1000)

    Returns:
        List of audit log entries
    """
    # Validate requesting_agent is provided
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required for team isolation", "status": "denied"}

    # Derive team filter from requesting agent
    team_filter = enforce_team_filter(requesting_agent)

    if team_filter is None:
        return {"error": f"Agent '{requesting_agent}' has no team assignment", "status": "denied"}

    init_db()
    with db_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # Build query
        query = "SELECT * FROM audit_log WHERE team_id = ?"
        params: List[Any] = [team_filter]

        if since_timestamp:
            query += " AND timestamp > ?"
            params.append(since_timestamp)

        if action_filter:
            query += " AND action = ?"
            params.append(action_filter)

        query += " ORDER BY id DESC LIMIT ?"
        params.append(min(limit, 1000))

        cursor.execute(query, params)
        rows = cursor.fetchall()

    return [
        {
            "id": row["id"],
            "timestamp": row["timestamp"],
            "agent": row["agent"],
            "team_id": row["team_id"],
            "action": row["action"],
            "resource": row["resource"],
            "outcome": row["outcome"],
            "metadata": json.loads(row["metadata"]) if row["metadata"] else None
        }
        for row in rows
    ]


@mcp.tool()
def summarize_task(
    requesting_agent: str,
    task_id: str
) -> dict:
    """
    Summarize task context from relay messages (P1-2.3).

    Fetches all messages related to a task and generates a compressed summary.
    Useful for reducing context tokens when reviewing completed tasks.

    Args:
        requesting_agent: Agent making the request (REQUIRED for team-based filtering)
        task_id: Task ID to summarize

    Returns:
        Dict with task_id, summary, compressed_tokens (tokens saved)
    """
    # Validate requesting_agent is provided
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required for team isolation", "status": "denied"}

    # Derive team filter from requesting agent
    team_filter = enforce_team_filter(requesting_agent)

    if team_filter is None:
        return {"error": f"Agent '{requesting_agent}' has no team assignment", "status": "denied"}

    # Fetch messages for this task from relay
    all_messages = _fetch_messages(team_filter=team_filter)

    # Filter to messages containing this task_id
    task_messages = []
    for msg in all_messages:
        content = msg.get("content", "")
        if task_id in content:
            task_messages.append(msg)

    if not task_messages:
        return {
            "task_id": task_id,
            "summary": "No messages found for task",
            "compressed_tokens": 0,
            "message_count": 0
        }

    # Generate summary
    task_summary = _summarizer.summarize_full(task_messages)

    return {
        "task_id": task_id,
        "summary": task_summary.summary_text,
        "worker": task_summary.worker,
        "outcome": task_summary.outcome,
        "duration_seconds": task_summary.duration_seconds,
        "compressed_tokens": task_summary.compressed_tokens,
        "message_count": len(task_messages)
    }


# =============================================================================
# 3-Way Handshake Protocol
# =============================================================================

# Default handshake timeout per step (seconds)
HANDSHAKE_TIMEOUT_SEC = 30
HANDSHAKE_POLL_INTERVAL = 2.0


def _generate_handshake_id(team_id: str) -> str:
    """Generate a unique handshake ID: hs-{team}-{timestamp_hash}."""
    raw = f"{team_id}-{time.time()}-{os.getpid()}"
    h = hashlib.sha256(raw.encode()).hexdigest()[:8]
    return f"hs-{team_id}-{h}"


@mcp.tool()
def execute_command_reliable(
    sender: str,
    target_agent: str,
    command: str,
    timeout: int = HANDSHAKE_TIMEOUT_SEC
) -> dict:
    """
    Send a command to a target agent using the 3-Way Handshake Protocol.

    Implements the Sender side: SYN -> wait SYN-ACK -> ACK (with command).
    Ensures the receiver is ready before transmitting.

    Args:
        sender: The sending agent's identifier (e.g., "gemini-3")
        target_agent: The target agent's tmux session name (e.g., "claude-3")
        command: The command or instruction to deliver
        timeout: Max seconds to wait per handshake step (default 30)

    Returns:
        Dict with handshake outcome and execution status
    """
    # --- Validate team isolation ---
    try:
        team_id = enforce_team_filter(sender, target_agent)
    except ValueError as e:
        return {"status": "denied", "error": str(e)}

    if team_id is None:
        return {"status": "denied", "error": f"Agent '{sender}' has no team assignment"}

    # --- Pre-flight: detect_state must be IDLE ---
    pre_state = detect_state(target_agent)
    agent_state = pre_state.get("state", AgentState.UNKNOWN.value)
    if agent_state != AgentState.IDLE.value:
        return {
            "status": "preflight_failed",
            "error": f"Target '{target_agent}' is not IDLE (state: {agent_state})",
            "agent_state": agent_state
        }

    # --- Phase 1: SYN ---
    handshake_id = _generate_handshake_id(team_id)
    syn_payload = json.dumps({
        "handshake_id": handshake_id,
        "sender": sender,
        "receiver": target_agent,
        "intent": command[:100],
        "timeout_sec": timeout,
        "timestamp": datetime.now(timezone.utc).isoformat()
    })

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
            (sender, syn_payload, "handshake_syn", None, team_id)
        )
        conn.commit()
        syn_msg_id = cursor.lastrowid

    # --- Phase 2: Wait for SYN-ACK ---
    start_time = time.time()
    syn_ack_received = False

    while (time.time() - start_time) < timeout:
        with db_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                """SELECT id, content FROM messages
                   WHERE type = 'handshake_syn_ack' AND team_id = ? AND id > ?
                   ORDER BY id""",
                (team_id, syn_msg_id)
            )
            rows = cursor.fetchall()

        for row in rows:
            try:
                payload = json.loads(row["content"])
                if payload.get("handshake_id") == handshake_id:
                    ready = payload.get("ready", False)
                    if not ready:
                        return {
                            "status": "busy",
                            "handshake_id": handshake_id,
                            "error": f"Receiver '{target_agent}' is not ready: {payload.get('reason', 'unknown')}"
                        }
                    syn_ack_received = True
                    break
            except json.JSONDecodeError:
                continue

        if syn_ack_received:
            break
        time.sleep(HANDSHAKE_POLL_INTERVAL)

    if not syn_ack_received:
        return {
            "status": "timeout",
            "phase": "syn_ack_wait",
            "handshake_id": handshake_id,
            "error": f"No SYN-ACK from '{target_agent}' within {timeout}s"
        }

    # --- Phase 3: ACK (GO) with command ---
    ack_payload = json.dumps({
        "handshake_id": handshake_id,
        "sender": sender,
        "receiver": target_agent,
        "command": command,
        "timestamp": datetime.now(timezone.utc).isoformat()
    })

    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
            (sender, ack_payload, "handshake_ack", syn_msg_id, team_id)
        )
        conn.commit()
        ack_msg_id = cursor.lastrowid

    return {
        "status": "connected",
        "handshake_id": handshake_id,
        "syn_msg_id": syn_msg_id,
        "ack_msg_id": ack_msg_id,
        "target_agent": target_agent,
        "command_delivered": True,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@mcp.tool()
def await_handshake(
    receiver: str,
    timeout: int = HANDSHAKE_TIMEOUT_SEC,
    since_id: int = 0
) -> dict:
    """
    Listen for an incoming handshake and auto-respond (Receiver side).

    Waits for a SYN, responds with SYN-ACK if ready, then waits for ACK
    containing the command to execute.

    Args:
        receiver: This agent's identifier (e.g., "claude-3")
        timeout: Max seconds to wait for SYN (default 30)
        since_id: Only consider messages after this ID (default 0)

    Returns:
        Dict with handshake result and command to execute
    """
    # --- Validate team ---
    team_id = extract_team(receiver)
    if team_id is None:
        return {"status": "denied", "error": f"Agent '{receiver}' has no team assignment"}

    # --- Phase 1: Wait for SYN ---
    start_time = time.time()
    syn_data = None
    syn_msg_id = None

    while (time.time() - start_time) < timeout:
        with db_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                """SELECT id, content FROM messages
                   WHERE type = 'handshake_syn' AND team_id = ? AND id > ?
                   ORDER BY id""",
                (team_id, since_id)
            )
            rows = cursor.fetchall()

        for row in rows:
            try:
                payload = json.loads(row["content"])
                if payload.get("receiver") == receiver:
                    syn_data = payload
                    syn_msg_id = row["id"]
                    break
            except json.JSONDecodeError:
                continue

        if syn_data:
            break
        time.sleep(HANDSHAKE_POLL_INTERVAL)

    if not syn_data:
        return {
            "status": "timeout",
            "phase": "syn_wait",
            "receiver": receiver,
            "error": f"No SYN received within {timeout}s"
        }

    handshake_id = syn_data["handshake_id"]
    sender = syn_data["sender"]

    # --- Phase 2: Send SYN-ACK ---
    # Check own readiness
    my_state = detect_state(receiver)
    am_idle = my_state.get("state", AgentState.UNKNOWN.value) == AgentState.IDLE.value

    syn_ack_payload = json.dumps({
        "handshake_id": handshake_id,
        "sender": receiver,
        "receiver": sender,
        "ready": am_idle,
        "reason": None if am_idle else f"state={my_state.get('state')}",
        "state": my_state.get("state"),
        "timestamp": datetime.now(timezone.utc).isoformat()
    })

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
            (receiver, syn_ack_payload, "handshake_syn_ack", syn_msg_id, team_id)
        )
        conn.commit()
        syn_ack_msg_id = cursor.lastrowid

    if not am_idle:
        return {
            "status": "busy",
            "handshake_id": handshake_id,
            "sender": sender,
            "error": f"Not IDLE, sent SYN-ACK with ready=false"
        }

    # --- Phase 3: Wait for ACK (contains command) ---
    ack_timeout = syn_data.get("timeout_sec", HANDSHAKE_TIMEOUT_SEC)
    ack_start = time.time()
    command = None

    while (time.time() - ack_start) < ack_timeout:
        with db_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                """SELECT id, content FROM messages
                   WHERE type = 'handshake_ack' AND team_id = ? AND id > ?
                   ORDER BY id""",
                (team_id, syn_ack_msg_id)
            )
            rows = cursor.fetchall()

        for row in rows:
            try:
                payload = json.loads(row["content"])
                if payload.get("handshake_id") == handshake_id:
                    command = payload.get("command")
                    break
            except json.JSONDecodeError:
                continue

        if command is not None:
            break
        time.sleep(HANDSHAKE_POLL_INTERVAL)

    if command is None:
        return {
            "status": "timeout",
            "phase": "ack_wait",
            "handshake_id": handshake_id,
            "sender": sender,
            "error": f"No ACK from '{sender}' within {ack_timeout}s"
        }

    return {
        "status": "connected",
        "handshake_id": handshake_id,
        "sender": sender,
        "command": command,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


# =============================================================================
# Native RPC Tools (P1-3)
# =============================================================================

# RPC port registry (agent -> port)
_rpc_ports: Dict[str, int] = {}


def register_rpc_port(agent: str, port: int):
    """Register an agent's RPC port."""
    _rpc_ports[agent] = port


def get_rpc_port(agent: str) -> Optional[int]:
    """Get an agent's registered RPC port."""
    return _rpc_ports.get(agent)


@mcp.tool()
def execute_on_agent(
    requesting_agent: str,
    target_agent: str,
    command: str,
    timeout: int = 30
) -> dict:
    """
    Execute a command on a target agent via RPC (P1-3.4).

    Requires target agent to be running an RPC server.

    Args:
        requesting_agent: Agent making the request
        target_agent: Agent to execute command on
        command: Command to execute
        timeout: RPC timeout in seconds

    Returns:
        Dict with result or error
    """
    # Validate team isolation
    try:
        team_id = enforce_team_filter(requesting_agent, target_agent)
    except ValueError as e:
        return {"status": "denied", "error": str(e)}

    if team_id is None:
        return {"status": "denied", "error": f"Agent '{requesting_agent}' has no team assignment"}

    # Get target RPC port
    port = get_rpc_port(target_agent)
    if not port:
        return {"status": "error", "error": f"No RPC port registered for '{target_agent}'"}

    # Make RPC call
    client = AgentRPCClient("127.0.0.1", port, timeout=float(timeout))
    response = client.call("execute", {"command": command}, sender=requesting_agent)

    if response.error:
        return {
            "status": "error",
            "error": response.error,
            "request_id": response.request_id
        }

    return {
        "status": "success",
        "result": response.result,
        "request_id": response.request_id
    }


# =============================================================================
# Auto-Retry Tools (P1-4)
# =============================================================================

@mcp.tool()
def auto_remediate_stalls(
    requesting_agent: str,
    max_retries: int = MAX_RETRIES
) -> dict:
    """
    Auto-remediate stalled workers (P1-4.2).

    Detects STUCK/CRASHED workers and attempts recovery by:
    1. Sending interrupt (C-c)
    2. Reassigning task if retries not exhausted

    Args:
        requesting_agent: Agent making the request (must be Director)
        max_retries: Maximum retries before giving up

    Returns:
        Dict with remediation actions taken
    """
    # Validate requesting_agent
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required", "status": "denied"}

    team_filter = enforce_team_filter(requesting_agent)
    if team_filter is None:
        return {"error": f"Agent '{requesting_agent}' has no team assignment", "status": "denied"}

    now = time.time()
    actions = []

    # Build worker heartbeats from in-memory + heartbeats table fallback
    worker_heartbeats = {
        w: hb for w, hb in _heartbeat_registry.items()
        if extract_team(w) == team_filter
    }
    if not worker_heartbeats:
        try:
            init_db()
            with db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT worker, task_id, progress_pct, current_action, state, "
                    "terminal_hash, frozen_warning, epoch, timestamp "
                    "FROM heartbeats WHERE team_id = ?",
                    (team_filter,)
                )
                for row in cursor.fetchall():
                    worker_heartbeats[row[0]] = {
                        "task_id": row[1], "progress_pct": row[2],
                        "current_action": row[3], "state": row[4],
                        "terminal_hash": row[5], "frozen_warning": bool(row[6]),
                        "epoch": row[7], "timestamp": row[8],
                        "team_id": team_filter
                    }
        except Exception:
            pass

    for worker, heartbeat in worker_heartbeats.items():
        # Skip workers from other teams
        worker_team = extract_team(worker)
        if team_filter and worker_team and worker_team != team_filter:
            continue

        last_epoch = heartbeat.get("epoch", 0)
        time_since = now - last_epoch
        task_id = heartbeat.get("task_id")

        # Check for STUCK or CRASHED
        if heartbeat.get("frozen_warning") or time_since > CRASHED_THRESHOLD_SEC:
            status = "STUCK" if heartbeat.get("frozen_warning") else "CRASHED"

            # Check retry count
            retries = get_retry_count(task_id) if task_id else 0

            if retries >= max_retries:
                actions.append({
                    "worker": worker,
                    "task_id": task_id,
                    "status": status,
                    "action": "ABANDON",
                    "reason": f"Max retries ({max_retries}) exceeded"
                })
                continue

            # Attempt remediation
            increment_retry_count(task_id)

            # Send interrupt
            try:
                get_tmux_backend().send_keys(worker, "C-c")
                actions.append({
                    "worker": worker,
                    "task_id": task_id,
                    "status": status,
                    "action": "INTERRUPT",
                    "retry_count": retries + 1
                })
            except Exception as e:
                actions.append({
                    "worker": worker,
                    "task_id": task_id,
                    "status": status,
                    "action": "FAILED",
                    "error": str(e)
                })

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "team_id": team_filter,
        "actions": actions,
        "workers_checked": len(worker_heartbeats)
    }


# =============================================================================
# Fleet Idle Watchdog (subscribe loop starvation detection)
# =============================================================================

@mcp.tool()
def register_team_agents(
    requesting_agent: str,
    team_session: str,
    agents: Dict[str, str],
    agent_models: Optional[Dict[str, str]] = None,
    agent_roles: Optional[Dict[str, str]] = None
) -> dict:
    """
    Register pane-based agents. Called by team skill after creating panes.

    Args:
        requesting_agent: Agent making the request (team-gated)
        team_session: Parent tmux session name (e.g., "team-4")
        agents: Mapping of agent name -> pane ID (e.g., {"c-4": "%18", "g-4": "%19"})
        agent_models: Optional mapping of agent name -> model (e.g., {"c-4": "opus"})
        agent_roles: Optional mapping of agent name -> role (e.g., {"g-4": "director"})

    Returns:
        Dict with registration status
    """
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required", "status": "denied"}

    backend = get_tmux_backend()
    backend.register_team_session(team_session)

    agent_models = agent_models or {}
    agent_roles = agent_roles or {}

    registered = []
    for agent_name, pane_id in agents.items():
        backend.register_agent(
            agent_name, pane_id, "pane", parent=team_session,
            model=agent_models.get(agent_name),
            role=agent_roles.get(agent_name)
        )
        registered.append(agent_name)

    return {
        "status": "registered",
        "team_session": team_session,
        "agents": registered,
        "count": len(registered)
    }


@mcp.tool()
def watch_fleet_idle(
    requesting_agent: str,
    idle_threshold: int = 120,
    timeout: int = 300,
    check_interval: int = 60
) -> dict:
    """
    Long-poll for idle worker alerts (Director/Monitor use).

    Detects workers stuck in subscribe loops without receiving tasks.
    Returns immediately when alerts are found, or on timeout with status summary.

    Args:
        requesting_agent: Agent making the request (team-gated)
        idle_threshold: Seconds a worker can subscribe without a task before alert
        timeout: Max seconds to poll before returning
        check_interval: How often to check registry (min 60s)

    Returns:
        Dict with status, alerts list, and fleet_summary
    """
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required", "status": "denied"}

    team_filter = enforce_team_filter(requesting_agent)
    if team_filter is None:
        return {"error": f"Agent '{requesting_agent}' has no team assignment", "status": "denied"}

    check_interval = max(check_interval, 10)  # Floor at 10s for responsiveness
    start_time = time.time()

    def _build_fleet_from_registry(now: float) -> tuple:
        """Build fleet state from in-memory subscribe registry."""
        alerts = []
        fleet_summary = {}
        for worker, info in _subscribe_registry.items():
            if info.get("team_id") != team_filter:
                continue
            last_task = info.get("last_task_received")
            first_listen = info.get("first_listen", now)
            last_listen = info.get("last_listen", now)
            listen_count = info.get("listen_count", 0)
            time_since_last_listen = now - last_listen

            if time_since_last_listen > 70:
                state = "stale"
                idle_seconds = int(time_since_last_listen)
                if idle_seconds > idle_threshold:
                    alerts.append({
                        "worker": worker, "type": "SUBSCRIBE_STALE",
                        "idle_seconds": idle_seconds, "listen_count": listen_count,
                        "recommendation": "Worker may have crashed or exited subscribe loop"
                    })
            elif last_task is None:
                idle_seconds = int(now - first_listen)
                state = "subscribing"
                if idle_seconds > idle_threshold:
                    alerts.append({
                        "worker": worker, "type": "IDLE_NO_TASK",
                        "idle_seconds": idle_seconds, "listen_count": listen_count,
                        "recommendation": "Dispatch task or instruct to stand down"
                    })
            else:
                time_since_task = now - last_task
                if time_since_task > idle_threshold and last_listen > last_task:
                    idle_seconds = int(time_since_task)
                    state = "idle_between_tasks"
                    alerts.append({
                        "worker": worker, "type": "IDLE_BETWEEN_TASKS",
                        "idle_seconds": idle_seconds, "listen_count": listen_count,
                        "recommendation": "Dispatch next task or instruct to stand down"
                    })
                else:
                    idle_seconds = 0
                    state = "working"

            fleet_summary[worker] = {
                "state": state,
                "idle_seconds": idle_seconds if state != "working" else 0,
                "tasks_received": listen_count if last_task else 0,
                "listen_count": listen_count
            }
        return alerts, fleet_summary

    def _build_fleet_from_relay(now: float) -> tuple:
        """Cross-process fallback: build fleet state from relay heartbeat messages."""
        alerts = []
        fleet_summary = {}
        try:
            init_db()
            with db_connection() as conn:
                cursor = conn.cursor()
                # Get latest heartbeat per worker on this team
                cursor.execute(
                    "SELECT agent, content, MAX(id) FROM messages "
                    "WHERE type = 'heartbeat' AND team_id = ? "
                    "GROUP BY agent",
                    (team_filter,)
                )
                rows = cursor.fetchall()
                # Also check for recent task_assign/task_accept to determine if worker got tasks
                cursor.execute(
                    "SELECT DISTINCT json_extract(content, '$.assigned_to') FROM messages "
                    "WHERE type = 'task_assign' AND team_id = ? "
                    "AND json_extract(content, '$.assigned_to') IS NOT NULL",
                    (team_filter,)
                )
                workers_with_tasks = {r[0] for r in cursor.fetchall() if r[0]}

            for agent, content_str, _ in rows:
                if agent == requesting_agent:
                    continue  # Skip the director itself
                try:
                    hb = json.loads(content_str)
                except (json.JSONDecodeError, TypeError):
                    continue
                hb_epoch = hb.get("epoch", 0)
                hb_state = hb.get("state", "unknown")
                time_since_hb = now - hb_epoch

                if time_since_hb > 70:
                    state = "stale"
                    idle_seconds = int(time_since_hb)
                    if idle_seconds > idle_threshold:
                        alerts.append({
                            "worker": agent, "type": "SUBSCRIBE_STALE",
                            "idle_seconds": idle_seconds, "listen_count": 0,
                            "recommendation": "Worker may have crashed or exited subscribe loop"
                        })
                elif hb_state in ("idle", "waiting") and agent not in workers_with_tasks:
                    idle_seconds = int(time_since_hb)
                    state = "subscribing"
                    if idle_seconds > idle_threshold:
                        alerts.append({
                            "worker": agent, "type": "IDLE_NO_TASK",
                            "idle_seconds": idle_seconds, "listen_count": 0,
                            "recommendation": "Dispatch task or instruct to stand down"
                        })
                elif hb_state in ("idle", "waiting"):
                    idle_seconds = int(time_since_hb)
                    state = "idle_between_tasks"
                    if idle_seconds > idle_threshold:
                        alerts.append({
                            "worker": agent, "type": "IDLE_BETWEEN_TASKS",
                            "idle_seconds": idle_seconds, "listen_count": 0,
                            "recommendation": "Dispatch next task or instruct to stand down"
                        })
                else:
                    idle_seconds = 0
                    state = "working"

                fleet_summary[agent] = {
                    "state": state, "idle_seconds": idle_seconds,
                    "tasks_received": 1 if agent in workers_with_tasks else 0,
                    "listen_count": 0
                }
        except Exception:
            pass
        return alerts, fleet_summary

    while (time.time() - start_time) < timeout:
        now = time.time()

        # Prefer in-memory registry; fall back to relay for cross-process visibility
        alerts, fleet_summary = _build_fleet_from_registry(now)
        if not fleet_summary:
            alerts, fleet_summary = _build_fleet_from_relay(now)

        if alerts:
            return {
                "status": "alert",
                "alerts": alerts,
                "fleet_summary": fleet_summary
            }

        # Sleep before next check
        remaining = timeout - (time.time() - start_time)
        if remaining <= 0:
            break
        time.sleep(min(check_interval, remaining))

    # Timeout — build final summary
    now = time.time()
    _, fleet_summary = _build_fleet_from_registry(now)
    if not fleet_summary:
        _, fleet_summary = _build_fleet_from_relay(now)

    return {
        "status": "ok",
        "alerts": [],
        "fleet_summary": fleet_summary
    }


# =============================================================================
# Blueprint Tools (P1-5)
# =============================================================================

# Blueprint cache
_loaded_blueprints: Dict[str, Blueprint] = {}


@mcp.tool()
def load_blueprint(
    requesting_agent: str,
    blueprint_path: str
) -> dict:
    """
    Load and parse a blueprint YAML file (P1-5.4).

    Args:
        requesting_agent: Agent making the request
        blueprint_path: Path to blueprint YAML file

    Returns:
        Dict with blueprint metadata and task count
    """
    # Validate requesting_agent
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required", "status": "denied"}

    team_filter = enforce_team_filter(requesting_agent)
    if team_filter is None:
        return {"error": f"Agent '{requesting_agent}' has no team assignment", "status": "denied"}

    path = Path(blueprint_path)
    if not path.exists():
        return {"error": f"Blueprint file not found: {blueprint_path}", "status": "error"}

    try:
        parser = BlueprintParser()
        blueprint = parser.parse_file(path)

        # Cache the blueprint
        _loaded_blueprints[blueprint_path] = blueprint

        return {
            "status": "loaded",
            "path": blueprint_path,
            "name": blueprint.metadata.name,
            "version": blueprint.metadata.version,
            "task_count": len(blueprint.tasks),
            "tier_count": len(blueprint.tiers),
            "tiers": {str(k): len(v) for k, v in blueprint.tiers.items()}
        }

    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "path": blueprint_path
        }


# =============================================================================
# SESSION CONTINUITY PROTOCOL (Phoenix Mode)
# =============================================================================


def generate_rotation_id() -> str:
    """Generate a unique rotation ID (UUID4)."""
    import uuid
    return str(uuid.uuid4())


@mcp.tool()
def initiate_rotation(
    monitor: str,
    primary_agent: str,
    shadow_agent: str,
    project_id: str,
    profile: str = "operator",
    reason: str = "context_high",
    threshold_pct: int = 70
) -> dict:
    """
    Initiate a session rotation (Monitor use).

    Creates a rotation session and sends WARM_SHADOW to the shadow agent.
    This is step 1 of the Phoenix Mode handover protocol.

    Args:
        monitor: The monitor agent initiating rotation
        primary_agent: The agent being rotated out
        shadow_agent: The agent being rotated in
        project_id: Project identifier
        reason: Rotation reason (context_high, manual, error)
        threshold_pct: Context threshold that triggered rotation

    Returns:
        Dict with rotation_id and status
    """
    if not monitor or not monitor.strip():
        return {"error": "monitor agent is required", "status": "denied"}

    team_filter = enforce_team_filter(monitor)
    if team_filter is None:
        return {"error": f"Agent '{monitor}' has no team assignment", "status": "denied"}

    # Generate rotation ID
    rotation_id = generate_rotation_id()
    timestamp = datetime.now(timezone.utc).isoformat()

    # Create rotation session
    _rotation_registry[rotation_id] = {
        "state": "initiated",
        "monitor": monitor,
        "primary_agent": primary_agent,
        "shadow_agent": shadow_agent,
        "project_id": project_id,
        "reason": reason,
        "threshold_pct": threshold_pct,
        "team_id": team_filter,
        "initiated_at": timestamp,
        "timestamps": {
            "initiated": timestamp
        }
    }

    # Post WARM_SHADOW message
    warm_shadow_payload = {
        "message_type": MessageType.WARM_SHADOW.value,
        "rotation_id": rotation_id,
        "timestamp": timestamp,
        "shadow_agent": shadow_agent,  # Target shadow agent
        "handoff_intent": {
            "reason": reason,
            "threshold_pct": threshold_pct
        },
        "project_id": project_id,
        "profile": profile,
        "prewarm": {
            "load_level": "light",
            "include": ["kernel", "profile", "project_soul", "memory_hot"],
            "exclude": ["full_journals", "blueprints"]
        },
        "requested_ready_by": None  # No hard deadline for MVP
    }

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
            (monitor, json.dumps(warm_shadow_payload), MessageType.WARM_SHADOW.value, None, team_filter)
        )
        conn.commit()
        msg_id = cursor.lastrowid

    _rotation_registry[rotation_id]["state"] = "shadow_warming"
    _rotation_registry[rotation_id]["timestamps"]["warm_shadow_sent"] = timestamp

    return {
        "status": "initiated",
        "rotation_id": rotation_id,
        "message_id": msg_id,
        "primary_agent": primary_agent,
        "shadow_agent": shadow_agent,
        "project_id": project_id,
        "reason": reason
    }


@mcp.tool()
def listen_for_warm_shadow(
    shadow_agent: str,
    timeout: int = 60,
    since_id: int = 0
) -> dict:
    """
    Listen for WARM_SHADOW message (Shadow use).

    Shadow agents call this to wait for a rotation initiation.
    Blocks until WARM_SHADOW arrives or timeout.

    Args:
        shadow_agent: The shadow agent's identifier
        timeout: Max seconds to wait (default 60)
        since_id: Only consider messages after this ID

    Returns:
        Dict with rotation details or timeout status
    """
    if not shadow_agent or not shadow_agent.strip():
        return {"error": "shadow_agent is required", "status": "denied"}

    team_filter = enforce_team_filter(shadow_agent)
    if team_filter is None:
        return {"error": f"Agent '{shadow_agent}' has no team assignment", "status": "denied"}

    start_time = time.time()
    poll_interval = 2.0

    while (time.time() - start_time) < timeout:
        messages = _fetch_messages(
            since_id=since_id,
            type_filter=MessageType.WARM_SHADOW.value,
            team_filter=team_filter
        )

        for msg in messages:
            try:
                payload = json.loads(msg.get("content", "{}"))
                # Filter by shadow_agent to prevent race conditions
                if (payload.get("message_type") == MessageType.WARM_SHADOW.value and
                    payload.get("shadow_agent") == shadow_agent):
                    return {
                        "status": "received",
                        "rotation_id": payload.get("rotation_id"),
                        "project_id": payload.get("project_id"),
                        "profile": payload.get("profile"),
                        "handoff_intent": payload.get("handoff_intent"),
                        "prewarm": payload.get("prewarm"),
                        "message_id": msg.get("id")
                    }
            except json.JSONDecodeError:
                continue

        time.sleep(poll_interval)

    return {"status": "timeout", "waited_seconds": timeout}


@mcp.tool()
def shadow_ready(
    shadow_agent: str,
    rotation_id: str,
    loaded: list,
    capacity_max: int = 200000,
    capacity_current: int = 10000
) -> dict:
    """
    Signal shadow is ready for digest (Shadow use).

    Shadow calls this after completing prewarm to signal readiness.

    Args:
        shadow_agent: The shadow agent's identifier
        rotation_id: The rotation session ID
        loaded: List of components loaded (kernel, profile, etc.)
        capacity_max: Max context tokens available
        capacity_current: Current token usage estimate

    Returns:
        Dict with message posting status
    """
    if not shadow_agent or not shadow_agent.strip():
        return {"error": "shadow_agent is required", "status": "denied"}

    team_filter = enforce_team_filter(shadow_agent)
    if team_filter is None:
        return {"error": f"Agent '{shadow_agent}' has no team assignment", "status": "denied"}

    # NOTE: Registry check removed - registry is per-process, not shared across agents.
    # The message will be posted to relay regardless. Monitor's wait_for_* functions
    # receive via relay subscription, not registry lookup.

    timestamp = datetime.now(timezone.utc).isoformat()

    ready_payload = {
        "message_type": MessageType.READY_FOR_DIGEST.value,
        "rotation_id": rotation_id,
        "timestamp": timestamp,
        "shadow_agent": shadow_agent,
        "status": "ready",
        "loaded": loaded,
        "missing": [],
        "errors": [],
        "capacity": {
            "max_context_tokens": capacity_max,
            "current_estimate": capacity_current,
            "available_for_digest": capacity_max - capacity_current
        },
        "ready_at": timestamp
    }

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
            (shadow_agent, json.dumps(ready_payload), MessageType.READY_FOR_DIGEST.value, None, team_filter)
        )
        conn.commit()
        msg_id = cursor.lastrowid

    # Update rotation state if registry exists (Monitor's process only)
    if rotation_id in _rotation_registry:
        _rotation_registry[rotation_id]["state"] = "shadow_ready"
        _rotation_registry[rotation_id]["timestamps"]["shadow_ready"] = timestamp

    return {
        "status": "posted",
        "rotation_id": rotation_id,
        "message_id": msg_id,
        "available_tokens": capacity_max - capacity_current
    }


@mcp.tool()
def wait_for_shadow_ready(
    monitor: str,
    rotation_id: str,
    timeout: int = 60
) -> dict:
    """
    Wait for shadow to signal ready (Monitor use).

    Monitor calls this after sending WARM_SHADOW to wait for shadow readiness.

    Args:
        monitor: The monitor agent's identifier
        rotation_id: The rotation session ID
        timeout: Max seconds to wait

    Returns:
        Dict with shadow capacity info or timeout
    """
    if not monitor or not monitor.strip():
        return {"error": "monitor is required", "status": "denied"}

    team_filter = enforce_team_filter(monitor)
    if team_filter is None:
        return {"error": f"Agent '{monitor}' has no team assignment", "status": "denied"}

    start_time = time.time()
    poll_interval = 2.0

    while (time.time() - start_time) < timeout:
        messages = _fetch_messages(
            since_id=0,
            type_filter=MessageType.READY_FOR_DIGEST.value,
            team_filter=team_filter
        )

        for msg in messages:
            try:
                payload = json.loads(msg.get("content", "{}"))
                if (payload.get("rotation_id") == rotation_id and
                    payload.get("status") == "ready"):
                    return {
                        "status": "ready",
                        "rotation_id": rotation_id,
                        "shadow_agent": payload.get("shadow_agent"),
                        "capacity": payload.get("capacity"),
                        "loaded": payload.get("loaded")
                    }
            except json.JSONDecodeError:
                continue

        time.sleep(poll_interval)

    return {"status": "timeout", "rotation_id": rotation_id, "waited_seconds": timeout}


@mcp.tool()
def send_handoff_digest(
    monitor: str,
    rotation_id: str,
    digest: str
) -> dict:
    """
    Send handoff digest to shadow (Monitor use).

    Monitor calls this with the synthesized digest payload.
    The digest should be a JSON string matching HANDOVER_DIGEST_SPEC.md schema.

    Args:
        monitor: The monitor agent's identifier
        rotation_id: The rotation session ID
        digest: JSON string of the handoff digest

    Returns:
        Dict with message posting status
    """
    if not monitor or not monitor.strip():
        return {"error": "monitor is required", "status": "denied"}

    team_filter = enforce_team_filter(monitor)
    if team_filter is None:
        return {"error": f"Agent '{monitor}' has no team assignment", "status": "denied"}

    # NOTE: Registry check removed - registry is per-process, not shared across agents.
    # Monitor's registry will be updated if it exists.

    # Validate digest is valid JSON
    try:
        digest_obj = json.loads(digest)
    except json.JSONDecodeError as e:
        return {"error": f"Invalid digest JSON: {e}", "status": "error"}

    # Size validation (3500 tokens ≈ 14000 chars)
    MAX_DIGEST_SIZE = 14000
    if len(digest) > MAX_DIGEST_SIZE:
        return {
            "error": f"Digest exceeds size limit ({len(digest)} > {MAX_DIGEST_SIZE} chars)",
            "status": "error",
            "suggestion": "Truncate per HANDOVER_DIGEST_SPEC prioritization rules"
        }

    # Check redaction flag is present
    redaction = digest_obj.get("redaction", {})
    if not redaction.get("applied"):
        return {
            "error": "Digest missing redaction confirmation",
            "status": "error",
            "suggestion": "Run redaction filter before sending digest"
        }

    timestamp = datetime.now(timezone.utc).isoformat()

    # Inject rotation_id and message_type into digest
    digest_obj["rotation_id"] = rotation_id
    digest_obj["message_type"] = MessageType.HANDOFF_DIGEST.value
    digest_obj["timestamp"] = timestamp

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
            (monitor, json.dumps(digest_obj), MessageType.HANDOFF_DIGEST.value, None, team_filter)
        )
        conn.commit()
        msg_id = cursor.lastrowid

    # Update rotation state if registry exists (Monitor's process only)
    if rotation_id in _rotation_registry:
        _rotation_registry[rotation_id]["state"] = "digest_sent"
        _rotation_registry[rotation_id]["timestamps"]["digest_sent"] = timestamp

    return {
        "status": "posted",
        "rotation_id": rotation_id,
        "message_id": msg_id,
        "digest_size": len(digest)
    }


@mcp.tool()
def wait_for_digest(
    shadow_agent: str,
    rotation_id: str,
    timeout: int = 45
) -> dict:
    """
    Wait for handoff digest (Shadow use).

    Shadow calls this after signaling ready to receive the digest.

    Args:
        shadow_agent: The shadow agent's identifier
        rotation_id: The rotation session ID
        timeout: Max seconds to wait

    Returns:
        Dict with full digest payload or timeout
    """
    if not shadow_agent or not shadow_agent.strip():
        return {"error": "shadow_agent is required", "status": "denied"}

    team_filter = enforce_team_filter(shadow_agent)
    if team_filter is None:
        return {"error": f"Agent '{shadow_agent}' has no team assignment", "status": "denied"}

    start_time = time.time()
    poll_interval = 2.0

    while (time.time() - start_time) < timeout:
        messages = _fetch_messages(
            since_id=0,
            type_filter=MessageType.HANDOFF_DIGEST.value,
            team_filter=team_filter
        )

        for msg in messages:
            try:
                payload = json.loads(msg.get("content", "{}"))
                if payload.get("rotation_id") == rotation_id:
                    return {
                        "status": "received",
                        "rotation_id": rotation_id,
                        "digest": payload,
                        "message_id": msg.get("id")
                    }
            except json.JSONDecodeError:
                continue

        time.sleep(poll_interval)

    return {"status": "timeout", "rotation_id": rotation_id, "waited_seconds": timeout}


@mcp.tool()
def send_intent_statement(
    shadow_agent: str,
    rotation_id: str,
    objective: str,
    next_action: str,
    ack_responses: list,
    confidence: str = "high"
) -> dict:
    """
    Send intent statement (Shadow use).

    Shadow calls this after processing digest to prove understanding.

    Args:
        shadow_agent: The shadow agent's identifier
        rotation_id: The rotation session ID
        objective: Shadow's understanding of current goal
        next_action: What shadow will do first
        ack_responses: List of {check, response} dicts for invariant checks
        confidence: high, medium, or low

    Returns:
        Dict with message posting status
    """
    if not shadow_agent or not shadow_agent.strip():
        return {"error": "shadow_agent is required", "status": "denied"}

    team_filter = enforce_team_filter(shadow_agent)
    if team_filter is None:
        return {"error": f"Agent '{shadow_agent}' has no team assignment", "status": "denied"}

    # NOTE: Registry check removed - registry is per-process, not shared across agents.

    timestamp = datetime.now(timezone.utc).isoformat()

    intent_payload = {
        "message_type": MessageType.INTENT_STATEMENT.value,
        "rotation_id": rotation_id,
        "timestamp": timestamp,
        "shadow_agent": shadow_agent,
        "understanding": {
            "objective": objective,
            "next_action": next_action,
            "ack_responses": ack_responses
        },
        "confidence": confidence,
        "questions": []
    }

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
            (shadow_agent, json.dumps(intent_payload), MessageType.INTENT_STATEMENT.value, None, team_filter)
        )
        conn.commit()
        msg_id = cursor.lastrowid

    # Update rotation state if registry exists (Monitor's process only)
    if rotation_id in _rotation_registry:
        _rotation_registry[rotation_id]["state"] = "intent_received"
        _rotation_registry[rotation_id]["timestamps"]["intent_received"] = timestamp

    return {
        "status": "posted",
        "rotation_id": rotation_id,
        "message_id": msg_id,
        "confidence": confidence
    }


@mcp.tool()
def wait_for_intent(
    monitor: str,
    rotation_id: str,
    timeout: int = 30
) -> dict:
    """
    Wait for intent statement from shadow (Monitor use).

    Monitor calls this after sending digest to get shadow's understanding.

    Args:
        monitor: The monitor agent's identifier
        rotation_id: The rotation session ID
        timeout: Max seconds to wait

    Returns:
        Dict with intent statement or timeout
    """
    if not monitor or not monitor.strip():
        return {"error": "monitor is required", "status": "denied"}

    team_filter = enforce_team_filter(monitor)
    if team_filter is None:
        return {"error": f"Agent '{monitor}' has no team assignment", "status": "denied"}

    start_time = time.time()
    poll_interval = 2.0

    while (time.time() - start_time) < timeout:
        messages = _fetch_messages(
            since_id=0,
            type_filter=MessageType.INTENT_STATEMENT.value,
            team_filter=team_filter
        )

        for msg in messages:
            try:
                payload = json.loads(msg.get("content", "{}"))
                if payload.get("rotation_id") == rotation_id:
                    return {
                        "status": "received",
                        "rotation_id": rotation_id,
                        "shadow_agent": payload.get("shadow_agent"),
                        "understanding": payload.get("understanding"),
                        "confidence": payload.get("confidence"),
                        "message_id": msg.get("id")
                    }
            except json.JSONDecodeError:
                continue

        time.sleep(poll_interval)

    return {"status": "timeout", "rotation_id": rotation_id, "waited_seconds": timeout}


@mcp.tool()
def send_final_ack(
    primary_agent: str,
    rotation_id: str,
    shadow_agent: str,
    approved: bool,
    mismatches: list = None
) -> dict:
    """
    Send final handover ACK (Primary use).

    Primary calls this to approve or reject shadow's understanding.

    Args:
        primary_agent: The primary agent's identifier
        rotation_id: The rotation session ID
        shadow_agent: The shadow agent's identifier
        approved: Whether the handover is approved
        mismatches: List of any mismatches found (if not approved)

    Returns:
        Dict with message posting status
    """
    if not primary_agent or not primary_agent.strip():
        return {"error": "primary_agent is required", "status": "denied"}

    team_filter = enforce_team_filter(primary_agent)
    if team_filter is None:
        return {"error": f"Agent '{primary_agent}' has no team assignment", "status": "denied"}

    # NOTE: Registry check removed - registry is per-process, not shared across agents.

    timestamp = datetime.now(timezone.utc).isoformat()

    ack_payload = {
        "message_type": MessageType.FINAL_HANDOVER_ACK.value,
        "rotation_id": rotation_id,
        "timestamp": timestamp,
        "primary_agent": primary_agent,
        "shadow_agent": shadow_agent,
        "ack_validation": {
            "all_checks_passed": approved,
            "mismatches": mismatches or []
        },
        "approved": approved,
        "handover_authorized": approved
    }

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
            (primary_agent, json.dumps(ack_payload), MessageType.FINAL_HANDOVER_ACK.value, None, team_filter)
        )
        conn.commit()
        msg_id = cursor.lastrowid

    # Update rotation state if registry exists (Monitor's process only)
    if rotation_id in _rotation_registry:
        _rotation_registry[rotation_id]["state"] = "ack_received"
        _rotation_registry[rotation_id]["timestamps"]["ack_received"] = timestamp
        _rotation_registry[rotation_id]["approved"] = approved

    return {
        "status": "posted",
        "rotation_id": rotation_id,
        "message_id": msg_id,
        "approved": approved,
        "handover_authorized": approved
    }


@mcp.tool()
def wait_for_final_ack(
    monitor: str,
    rotation_id: str,
    timeout: int = 30
) -> dict:
    """
    Wait for final ACK from primary (Monitor use).

    Monitor calls this after forwarding intent to primary.

    Args:
        monitor: The monitor agent's identifier
        rotation_id: The rotation session ID
        timeout: Max seconds to wait

    Returns:
        Dict with ACK result or timeout
    """
    if not monitor or not monitor.strip():
        return {"error": "monitor is required", "status": "denied"}

    team_filter = enforce_team_filter(monitor)
    if team_filter is None:
        return {"error": f"Agent '{monitor}' has no team assignment", "status": "denied"}

    start_time = time.time()
    poll_interval = 2.0

    while (time.time() - start_time) < timeout:
        messages = _fetch_messages(
            since_id=0,
            type_filter=MessageType.FINAL_HANDOVER_ACK.value,
            team_filter=team_filter
        )

        for msg in messages:
            try:
                payload = json.loads(msg.get("content", "{}"))
                if payload.get("rotation_id") == rotation_id:
                    return {
                        "status": "received",
                        "rotation_id": rotation_id,
                        "approved": payload.get("approved"),
                        "handover_authorized": payload.get("handover_authorized"),
                        "mismatches": payload.get("ack_validation", {}).get("mismatches", []),
                        "message_id": msg.get("id")
                    }
            except json.JSONDecodeError:
                continue

        time.sleep(poll_interval)

    return {"status": "timeout", "rotation_id": rotation_id, "waited_seconds": timeout}


@mcp.tool()
def complete_rotation(
    monitor: str,
    rotation_id: str,
    primary_agent: str,
    shadow_agent: str
) -> dict:
    """
    Complete rotation and signal route switch (Monitor use).

    Monitor calls this after receiving approved ACK to finalize handover.

    Args:
        monitor: The monitor agent's identifier
        rotation_id: The rotation session ID
        primary_agent: The outgoing primary agent
        shadow_agent: The incoming shadow agent

    Returns:
        Dict with switch status
    """
    if not monitor or not monitor.strip():
        return {"error": "monitor is required", "status": "denied"}

    team_filter = enforce_team_filter(monitor)
    if team_filter is None:
        return {"error": f"Agent '{monitor}' has no team assignment", "status": "denied"}

    if rotation_id not in _rotation_registry:
        return {"error": f"Unknown rotation_id: {rotation_id}", "status": "error"}

    rotation = _rotation_registry[rotation_id]

    # Verify team matches
    if rotation.get("team_id") != team_filter:
        return {"error": "Access denied - different team", "status": "denied"}

    # Verify agents match rotation
    if rotation.get("primary_agent") != primary_agent:
        return {"error": f"Primary agent mismatch: expected {rotation.get('primary_agent')}", "status": "error"}
    if rotation.get("shadow_agent") != shadow_agent:
        return {"error": f"Shadow agent mismatch: expected {rotation.get('shadow_agent')}", "status": "error"}

    if not rotation.get("approved"):
        return {"error": "Rotation not approved", "status": "denied"}

    timestamp = datetime.now(timezone.utc).isoformat()

    switch_payload = {
        "message_type": MessageType.SWITCH_ROUTE.value,
        "rotation_id": rotation_id,
        "timestamp": timestamp,
        "from_agent": primary_agent,
        "to_agent": shadow_agent,
        "effective_immediately": True
    }

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
            (monitor, json.dumps(switch_payload), MessageType.SWITCH_ROUTE.value, None, team_filter)
        )
        conn.commit()
        msg_id = cursor.lastrowid

    # Update rotation state
    _rotation_registry[rotation_id]["state"] = "switched"
    _rotation_registry[rotation_id]["timestamps"]["switched"] = timestamp

    return {
        "status": "switched",
        "rotation_id": rotation_id,
        "message_id": msg_id,
        "from_agent": primary_agent,
        "to_agent": shadow_agent,
        "note": "Shadow is now active. Primary should run /end in background."
    }


@mcp.tool()
def signal_session_closed(
    primary_agent: str,
    rotation_id: str,
    session_id: str,
    journal_path: str,
    journal_committed: bool = True,
    memory_updated: bool = True
) -> dict:
    """
    Signal session closed after cleanup (Primary use).

    Primary calls this after completing /end to signal cleanup is done.

    Args:
        primary_agent: The primary agent's identifier
        rotation_id: The rotation session ID
        session_id: The session identifier
        journal_path: Path to the committed journal
        journal_committed: Whether journal was committed
        memory_updated: Whether MEMORY.md was updated

    Returns:
        Dict with closure status
    """
    if not primary_agent or not primary_agent.strip():
        return {"error": "primary_agent is required", "status": "denied"}

    team_filter = enforce_team_filter(primary_agent)
    if team_filter is None:
        return {"error": f"Agent '{primary_agent}' has no team assignment", "status": "denied"}

    # Verify team matches rotation if rotation exists
    if rotation_id in _rotation_registry:
        rotation = _rotation_registry[rotation_id]
        if rotation.get("team_id") != team_filter:
            return {"error": "Access denied - different team", "status": "denied"}

    timestamp = datetime.now(timezone.utc).isoformat()

    closed_payload = {
        "message_type": MessageType.SESSION_CLOSED.value,
        "rotation_id": rotation_id,
        "timestamp": timestamp,
        "agent": primary_agent,
        "session_id": session_id,
        "journal_committed": journal_committed,
        "journal_path": journal_path,
        "memory_updated": memory_updated,
        "cleanup_complete": True
    }

    init_db()
    with db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO messages (agent, content, type, ref_id, team_id) VALUES (?, ?, ?, ?, ?)",
            (primary_agent, json.dumps(closed_payload), MessageType.SESSION_CLOSED.value, None, team_filter)
        )
        conn.commit()
        msg_id = cursor.lastrowid

    # Update rotation state
    if rotation_id in _rotation_registry:
        _rotation_registry[rotation_id]["state"] = "closed"
        _rotation_registry[rotation_id]["timestamps"]["closed"] = timestamp

    return {
        "status": "closed",
        "rotation_id": rotation_id,
        "message_id": msg_id,
        "session_id": session_id,
        "cleanup_complete": True
    }


@mcp.tool()
def get_rotation_status(
    requesting_agent: str,
    rotation_id: str
) -> dict:
    """
    Get status of a rotation session.

    Args:
        requesting_agent: Agent making the request
        rotation_id: The rotation session ID

    Returns:
        Dict with rotation state and timestamps
    """
    if not requesting_agent or not requesting_agent.strip():
        return {"error": "requesting_agent is required", "status": "denied"}

    team_filter = enforce_team_filter(requesting_agent)
    if team_filter is None:
        return {"error": f"Agent '{requesting_agent}' has no team assignment", "status": "denied"}

    if rotation_id not in _rotation_registry:
        return {"error": f"Unknown rotation_id: {rotation_id}", "status": "not_found"}

    rotation = _rotation_registry[rotation_id]

    # Verify team access
    if rotation.get("team_id") != team_filter:
        return {"error": "Access denied - different team", "status": "denied"}

    return {
        "status": "found",
        "rotation_id": rotation_id,
        "state": rotation.get("state"),
        "monitor": rotation.get("monitor"),
        "primary_agent": rotation.get("primary_agent"),
        "shadow_agent": rotation.get("shadow_agent"),
        "project_id": rotation.get("project_id"),
        "reason": rotation.get("reason"),
        "approved": rotation.get("approved"),
        "timestamps": rotation.get("timestamps", {})
    }


# ─────────────────────────────────────────────────────────────────
# Phoenix Mode: Redaction Scanner, Digest Builder, Context Estimator
# ─────────────────────────────────────────────────────────────────

REDACTION_PATTERNS = [
    ("AWS_KEY", r"AKIA[A-Z0-9]{16}", "[REDACTED:AWS_KEY]"),
    ("AWS_TEMP_KEY", r"ASIA[A-Z0-9]{16}", "[REDACTED:AWS_TEMP_KEY]"),
    ("AWS_SECRET", r'aws_secret_access_key["\s:=]+.{40}', "[REDACTED:AWS_SECRET]"),
    ("AWS_SESSION", r'aws_session_token["\s:=]+\S+', "[REDACTED:AWS_SESSION]"),
    ("GITHUB_TOKEN", r"ghp_[A-Za-z0-9]{36}", "[REDACTED:GITHUB_TOKEN]"),
    ("GITHUB_PAT", r"github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}", "[REDACTED:GITHUB_PAT]"),
    ("GITHUB_OAUTH", r"gho_[A-Za-z0-9]{36}", "[REDACTED:GITHUB_OAUTH]"),
    ("GITHUB_APP", r"ghs_[A-Za-z0-9]{36}", "[REDACTED:GITHUB_APP]"),
    ("GITHUB_REFRESH", r"ghu_[A-Za-z0-9]{36}", "[REDACTED:GITHUB_REFRESH]"),
    ("STRIPE_LIVE", r"sk_live_[A-Za-z0-9]{24,}", "[REDACTED:STRIPE_LIVE]"),
    ("STRIPE_TEST", r"sk_test_[A-Za-z0-9]{24,}", "[REDACTED:STRIPE_TEST]"),
    ("STRIPE_RESTRICTED", r"rk_(?:live|test)_[A-Za-z0-9]{24,}", "[REDACTED:STRIPE_RESTRICTED]"),
    ("SLACK_TOKEN", r"xox[baprs]-[A-Za-z0-9\-]+", "[REDACTED:SLACK_TOKEN]"),
    ("PRIVATE_KEY", r"-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----", "[REDACTED:PRIVATE_KEY]"),
    ("API_KEY", r'api[_\-]?key["\s:=]+[A-Za-z0-9]{20,}', "[REDACTED:API_KEY]"),
    ("PASSWORD", r'password["\s:=]+\S+', "[REDACTED:PASSWORD]"),
    ("BEARER", r"Bearer [A-Za-z0-9\-._~+/]+=*", "[REDACTED:BEARER]"),
]

_compiled_redaction_patterns = [(name, re.compile(pat), repl) for name, pat, repl in REDACTION_PATTERNS]


def _redact_text(text: str) -> dict:
    """Apply all redaction patterns to text. Returns redacted text and stats."""
    redactions_made = 0
    types_found = set()
    result = text
    for name, pattern, replacement in _compiled_redaction_patterns:
        new_result, count = pattern.subn(replacement, result)
        if count > 0:
            redactions_made += count
            types_found.add(name)
        result = new_result
    return {
        "redacted_text": result,
        "redactions_made": redactions_made,
        "types_found": sorted(types_found),
        "scanner_version": "1.0.0"
    }


@mcp.tool()
def redact_secrets(
    text: str
) -> dict:
    """
    Scan text for secrets and redact them per HANDOVER_DIGEST_SPEC patterns.

    Scans for 17 credential patterns (AWS keys, GitHub tokens, Stripe keys,
    Slack tokens, private keys, API keys, passwords, bearer tokens).

    Args:
        text: Text to scan and redact

    Returns:
        Dict with redacted_text, redactions_made count, types_found list, scanner_version
    """
    if not text:
        return {"redacted_text": "", "redactions_made": 0, "types_found": [], "scanner_version": "1.0.0"}
    return _redact_text(text)


def _run_git(repo_path: str, args: list) -> str:
    """Run a git command in repo_path, return stdout or empty string on error."""
    try:
        result = subprocess.run(
            ["git", "-C", repo_path] + args,
            capture_output=True, text=True, timeout=10
        )
        return result.stdout.strip()
    except Exception:
        return ""


def _parse_git_status(porcelain_output: str) -> dict:
    """Parse git status --porcelain output into counts."""
    staged = 0
    modified = 0
    untracked = 0
    for line in porcelain_output.splitlines():
        if not line or len(line) < 2:
            continue
        x, y = line[0], line[1]
        if line.startswith("??"):
            untracked += 1
        elif x in "MADRCT":
            staged += 1
        elif y in "MADRCT":
            modified += 1
    clean = (staged == 0 and modified == 0 and untracked == 0)
    return {"clean": clean, "staged_count": staged, "modified_count": modified, "untracked_count": untracked}


def _parse_diff_files(diff_stat: str) -> list:
    """Parse git diff --numstat output into file change list."""
    files = []
    for line in diff_stat.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            added = int(parts[0]) if parts[0] != "-" else 0
            removed = int(parts[1]) if parts[1] != "-" else 0
            path = parts[2]
            status = "modified"
            if added > 0 and removed == 0:
                status = "added"
            elif added == 0 and removed > 0:
                status = "deleted"
            files.append({"path": path, "status": status, "lines_added": added, "lines_removed": removed})
    return files


def _find_latest_journal(repo_path: str) -> Optional[str]:
    """Find the latest session journal for today in the repo."""
    journal_dir = Path(repo_path) / "session-journals"
    if not journal_dir.exists():
        return None
    today = datetime.now().strftime("%Y-%m-%d")
    journals = sorted(journal_dir.glob(f"{today}-*.md"), reverse=True)
    if journals:
        try:
            return journals[0].read_text(encoding="utf-8")[:4000]
        except Exception:
            return None
    # Fall back to most recent journal
    journals = sorted(journal_dir.glob("*.md"), reverse=True)
    if journals:
        try:
            return journals[0].read_text(encoding="utf-8")[:4000]
        except Exception:
            return None
    return None


def _read_memory(repo_path: str) -> Optional[str]:
    """Read MEMORY.md from repo if it exists."""
    memory_path = Path(repo_path) / "MEMORY.md"
    if memory_path.exists():
        try:
            return memory_path.read_text(encoding="utf-8")[:4000]
        except Exception:
            return None
    return None


@mcp.tool()
def synthesize_handoff_digest(
    monitor: str,
    rotation_id: str,
    project_id: str,
    repo_path: str,
    primary_agent: str,
    shadow_agent: str,
    objective: str,
    next_actions_immediate: list,
    next_actions_queued: list = None,
    decisions: list = None,
    ack_checks: list = None,
    reason: str = "context_high",
    threshold_pct: int = 80
) -> dict:
    """
    Synthesize a HANDOFF_DIGEST per HANDOVER_DIGEST_SPEC v1.0.0.

    Automates: git state, patch diff, terminal capture, journal/memory reads, redaction.
    Monitor provides: objective, next_actions, decisions, ack_checks (judgment calls).

    Args:
        monitor: Monitor agent ID (e.g., "gemini-1")
        rotation_id: Active rotation UUID
        project_id: Project identifier (e.g., "zeos-dev")
        repo_path: Absolute path to project repo
        primary_agent: Outgoing agent ID
        shadow_agent: Incoming agent ID
        objective: Current high-level goal (Monitor's judgment)
        next_actions_immediate: What Shadow should do first (list of strings)
        next_actions_queued: Subsequent tasks (list of strings, optional)
        decisions: Key decisions made [{decision, rationale}] (optional)
        ack_checks: Invariants Shadow must confirm (list of strings, optional)
        reason: Handoff reason (context_high, manual, error)
        threshold_pct: Context threshold percentage

    Returns:
        Dict with status and assembled digest JSON string ready for send_handoff_digest
    """
    if not monitor or not monitor.strip():
        return {"error": "monitor is required", "status": "error"}

    team_filter = enforce_team_filter(monitor)
    if team_filter is None:
        return {"error": f"Agent '{monitor}' has no team assignment", "status": "denied"}

    repo_path = os.path.expanduser(repo_path)
    if not os.path.isdir(repo_path):
        return {"error": f"repo_path does not exist: {repo_path}", "status": "error"}

    timestamp = datetime.now(timezone.utc).isoformat()

    # ── Git state (automated) ──
    branch = _run_git(repo_path, ["rev-parse", "--abbrev-ref", "HEAD"]) or "unknown"
    last_hash = _run_git(repo_path, ["rev-parse", "--short", "HEAD"]) or "unknown"
    last_msg = _run_git(repo_path, ["log", "-1", "--format=%s"]) or ""
    last_ts = _run_git(repo_path, ["log", "-1", "--format=%aI"]) or timestamp
    status_raw = _run_git(repo_path, ["status", "--porcelain"])
    git_status = _parse_git_status(status_raw)

    # Remote tracking
    remote_tracking = _run_git(repo_path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    ahead_behind_raw = _run_git(repo_path, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
    ahead, behind = 0, 0
    if ahead_behind_raw and "\t" in ahead_behind_raw:
        parts = ahead_behind_raw.split("\t")
        behind = int(parts[0]) if parts[0].isdigit() else 0
        ahead = int(parts[1]) if parts[1].isdigit() else 0

    # Patch diff
    diff_content = _run_git(repo_path, ["diff"]) or ""
    diff_cached = _run_git(repo_path, ["diff", "--cached"]) or ""
    full_diff = diff_content
    if diff_cached:
        full_diff = diff_cached + "\n" + diff_content if full_diff else diff_cached

    diff_numstat = _run_git(repo_path, ["diff", "--numstat"]) or ""
    diff_cached_numstat = _run_git(repo_path, ["diff", "--cached", "--numstat"]) or ""
    combined_numstat = diff_numstat
    if diff_cached_numstat:
        combined_numstat = diff_cached_numstat + "\n" + diff_numstat if combined_numstat else diff_cached_numstat

    files_affected = _parse_diff_files(combined_numstat)

    MAX_DIFF_SIZE = 12000
    truncated = len(full_diff) > MAX_DIFF_SIZE
    storage_ref = None
    if truncated:
        storage_dir = Path(f"/tmp/zeos-handover/{rotation_id}")
        storage_dir.mkdir(parents=True, exist_ok=True)
        storage_path = storage_dir / "full_diff.patch"
        storage_path.write_text(full_diff, encoding="utf-8")
        storage_ref = str(storage_path)
        full_diff = full_diff[:MAX_DIFF_SIZE]

    # ── Terminal capture (automated) ──
    terminal_output = ""
    try:
        terminal_output = _capture_tmux_output(primary_agent, 200) or ""
    except Exception:
        pass

    # ── Journal + Memory (automated) ──
    journal_content = _find_latest_journal(repo_path)
    memory_content = _read_memory(repo_path)

    # ── Build context summary from terminal + journal ──
    context_pieces = []
    if terminal_output:
        # Last 30 lines of terminal for recency
        recent_lines = "\n".join(terminal_output.splitlines()[-30:])
        context_pieces.append(f"Recent terminal activity:\n{recent_lines}")
    if journal_content:
        context_pieces.append(f"Latest journal excerpt:\n{journal_content[:1500]}")

    context_summary = "\n---\n".join(context_pieces) if context_pieces else "No context captured."
    # Cap at ~800 tokens (~3200 chars)
    if len(context_summary) > 3200:
        context_summary = context_summary[:3200]

    # ── Files touched (from git + diff) ──
    files_touched = [f["path"] for f in files_affected]

    # ── Build decisions list ──
    decisions_list = []
    if decisions:
        for d in decisions:
            if isinstance(d, dict):
                decisions_list.append(d)
            elif isinstance(d, str):
                decisions_list.append({"decision": d, "rationale": ""})

    # ── Continuity links ──
    continuity = {
        "last_checkpoint": None,
        "last_memory_entry": None,
        "active_blueprint": None
    }
    if journal_content:
        journal_dir = Path(repo_path) / "session-journals"
        journals = sorted(journal_dir.glob("*.md"), reverse=True) if journal_dir.exists() else []
        if journals:
            continuity["last_checkpoint"] = str(journals[0])

    # ── Session ID ──
    today = datetime.now().strftime("%Y-%m-%d")
    session_id = f"{today}-001"

    # ── Assemble digest ──
    digest = {
        "version": "1.0.0",
        "identity": {
            "project_id": project_id,
            "session_id": session_id,
            "primary_agent": primary_agent,
            "shadow_agent": shadow_agent,
            "handoff_reason": reason,
            "threshold_pct": threshold_pct,
            "active_blueprint_enforcement": None
        },
        "repo_state": {
            "repo_root": repo_path,
            "branch": branch,
            "remote_tracking": remote_tracking or None,
            "ahead_behind": {"ahead": ahead, "behind": behind},
            "git_status": git_status,
            "last_commit": {
                "hash": last_hash,
                "message": last_msg,
                "timestamp": last_ts
            }
        },
        "patch_diff": {
            "format": "unified_diff",
            "encoding": "utf-8",
            "truncated": truncated,
            "truncation_reason": "Size exceeded 12000 chars" if truncated else None,
            "storage_ref": storage_ref,
            "content": full_diff,
            "files_affected": files_affected
        },
        "work_context": {
            "objective": objective,
            "files_touched": files_touched[:20],
            "decisions_made": decisions_list[:10],
            "tools_used": [],
            "tests_run": [],
            "active_processes": []
        },
        "mental_model": {
            "token_budget": 800,
            "context_summary": context_summary,
            "pending_assumptions": [],
            "unresolved_anomalies": [],
            "user_preferences_discovered": []
        },
        "next_actions": {
            "immediate": next_actions_immediate or [],
            "queued": next_actions_queued or [],
            "blocked_by": []
        },
        "continuity": continuity,
        "verification": {
            "ack_checks": ack_checks or [f"Current branch is {branch}", f"Objective: {objective}"],
            "digest_hash": ""
        },
        "redaction": {
            "applied": False,
            "scanner_version": "1.0.0",
            "types_scanned": [name for name, _, _ in REDACTION_PATTERNS],
            "redactions_made": 0
        }
    }

    # ── Apply redaction ──
    digest_str = json.dumps(digest)
    redaction_result = _redact_text(digest_str)
    digest_str = redaction_result["redacted_text"]

    # Re-parse to update redaction metadata
    digest = json.loads(digest_str)
    digest["redaction"]["applied"] = True
    digest["redaction"]["redactions_made"] = redaction_result["redactions_made"]

    # Compute digest hash
    final_str = json.dumps(digest, sort_keys=True)
    digest["verification"]["digest_hash"] = f"sha256:{hashlib.sha256(final_str.encode()).hexdigest()[:16]}"

    # Final serialization
    final_digest = json.dumps(digest)

    # Size check
    MAX_DIGEST_SIZE = 14000
    if len(final_digest) > MAX_DIGEST_SIZE:
        # Truncate context_summary to fit
        over_by = len(final_digest) - MAX_DIGEST_SIZE + 200
        if len(digest["mental_model"]["context_summary"]) > over_by:
            digest["mental_model"]["context_summary"] = digest["mental_model"]["context_summary"][:-over_by] + "\n[TRUNCATED]"
        else:
            digest["mental_model"]["context_summary"] = digest["mental_model"]["context_summary"][:500]
            digest["patch_diff"]["content"] = ""
            digest["patch_diff"]["truncated"] = True
            digest["patch_diff"]["truncation_reason"] = "Digest over size budget"
        final_digest = json.dumps(digest)

    return {
        "status": "synthesized",
        "rotation_id": rotation_id,
        "digest": final_digest,
        "digest_size": len(final_digest),
        "max_size": MAX_DIGEST_SIZE,
        "redactions_made": redaction_result["redactions_made"],
        "files_affected_count": len(files_affected),
        "git_clean": git_status["clean"],
        "branch": branch
    }


@mcp.tool()
def estimate_context_usage(
    agent: str,
    lines: int = 500
) -> dict:
    """
    Estimate an agent's context window usage from terminal output heuristics.

    Analyzes terminal output to count conversation turns, estimate token usage,
    and recommend whether rotation is needed.

    Args:
        agent: Agent tmux session name (e.g., "claude-1")
        lines: Number of terminal lines to capture

    Returns:
        Dict with estimated_pct, turns, recommendation (ok/pre-warm/rotate_now)
    """
    if not agent or not agent.strip():
        return {"error": "agent is required", "status": "error"}

    try:
        output = _capture_tmux_output(agent, lines)
    except Exception as e:
        return {"error": f"Failed to capture output: {e}", "status": "error"}

    if not output:
        return {
            "estimated_pct": 0,
            "turns": 0,
            "output_lines": 0,
            "recommendation": "ok",
            "details": "No output captured"
        }

    output_lines = output.splitlines()
    total_lines = len(output_lines)

    # Count conversation turns via prompt markers
    turn_markers = 0
    tool_calls = 0
    for line in output_lines:
        stripped = line.strip()
        # Claude prompt markers
        if stripped.startswith("❯") or stripped.startswith(">") or stripped.startswith("$"):
            turn_markers += 1
        # Goose prompt markers
        if "goose>" in stripped or stripped.startswith("goose session"):
            turn_markers += 1
        # Tool call indicators
        if "MCP" in line or "Read(" in line or "Edit(" in line or "Bash(" in line:
            tool_calls += 1
        if "Thinking" in line or "Cogitat" in line or "Cooked" in line:
            turn_markers += 1

    # Heuristic: each turn ~2000-4000 tokens, context window ~200K
    # Rough estimate based on output volume + turn count
    estimated_tokens = (total_lines * 15) + (turn_markers * 3000) + (tool_calls * 1500)
    max_tokens = 200000
    estimated_pct = min(99, int((estimated_tokens / max_tokens) * 100))

    # Check for context warning signs in output
    context_warnings = False
    for line in output_lines[-50:]:
        if "context" in line.lower() and ("limit" in line.lower() or "window" in line.lower()):
            context_warnings = True
        if "summariz" in line.lower() and "conversation" in line.lower():
            context_warnings = True
            estimated_pct = max(estimated_pct, 75)

    # Recommendation
    if estimated_pct >= 75 or context_warnings:
        recommendation = "rotate_now"
    elif estimated_pct >= 55:
        recommendation = "pre-warm"
    else:
        recommendation = "ok"

    return {
        "estimated_pct": estimated_pct,
        "turns": turn_markers,
        "tool_calls": tool_calls,
        "output_lines": total_lines,
        "estimated_tokens": estimated_tokens,
        "context_warnings_detected": context_warnings,
        "recommendation": recommendation
    }


def _register_pid() -> None:
    """Register this process's PID file for orphan detection."""
    try:
        _PID_DIR.mkdir(parents=True, exist_ok=True)
        pid = os.getpid()
        pid_file = _PID_DIR / f"{pid}.pid"
        pid_file.write_text(str(pid))
    except Exception:
        logger.warning("Failed to register PID file", exc_info=True)


def _unregister_pid() -> None:
    """Remove this process's PID file on exit."""
    try:
        pid = os.getpid()
        pid_file = _PID_DIR / f"{pid}.pid"
        if pid_file.exists():
            pid_file.unlink()
    except Exception:
        pass  # Best-effort on exit


def _cleanup_stale_pids() -> None:
    """Remove PID files for processes that are no longer running."""
    try:
        if not _PID_DIR.exists():
            return
        for pid_file in _PID_DIR.glob("*.pid"):
            try:
                pid = int(pid_file.stem)
                # Check if process is alive
                os.kill(pid, 0)
            except (ValueError, ProcessLookupError):
                # Process doesn't exist — stale PID file
                try:
                    pid_file.unlink()
                except Exception:
                    pass
            except PermissionError:
                pass  # Process exists but we can't signal it
    except Exception:
        logger.warning("Failed to cleanup stale PIDs", exc_info=True)


def _detect_zombie_processes() -> None:
    """Detect orphan overseer processes (monitoring only — no kill)."""
    try:
        result = subprocess.run(
            ["pgrep", "-f", "overseer.server"],
            capture_output=True, text=True, timeout=5,
        )
        pids = [int(p) for p in result.stdout.strip().split("\n") if p.strip()]
        my_pid = os.getpid()

        # Build set of known PIDs from PID dir
        known_pids = {my_pid}
        if _PID_DIR.exists():
            for pid_file in _PID_DIR.glob("*.pid"):
                try:
                    known_pids.add(int(pid_file.stem))
                except ValueError:
                    pass

        unknown = [p for p in pids if p != my_pid and p not in known_pids]
        other_count = max(0, len(pids) - 1)

        if unknown:
            logger.info(
                "Detected %d overseer processes (%d not in PID registry — tolerating)",
                other_count, len(unknown),
            )
    except Exception:
        pass


def main():
    """Run the Overseer MCP server."""
    try:
        _register_pid()
        atexit.register(_unregister_pid)
        signal.signal(signal.SIGTERM, lambda s, f: (_unregister_pid(), sys.exit(0)))
        _cleanup_stale_pids()
        _detect_zombie_processes()
        init_db()
        mcp.run()
    except Exception:
        logger.exception("Overseer MCP server crashed")
        sys.exit(1)


if __name__ == "__main__":
    main()
