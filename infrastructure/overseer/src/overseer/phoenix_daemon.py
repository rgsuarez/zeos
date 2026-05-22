#!/usr/bin/env python3
"""
Phoenix Mode Daemon Monitor
Lightweight session rotation orchestrator — zero AI context consumption.

Watches a Primary agent's context usage via terminal heuristics. When context
approaches exhaustion, orchestrates a seamless handover to a Shadow agent:
  1. Warm Shadow (pre-load kernel/profile/soul)
  2. Single-shot Sonnet call to extract objective/decisions/next_actions
  3. Synthesize HANDOFF_DIGEST per spec v1.0.0
  4. Post digest, wait for Shadow intent, auto-approve, complete rotation

Usage:
    python -m overseer.phoenix_daemon \\
        --primary claude-1 --shadow claude2-1 \\
        --project zeos-dev --repo ~/projects/zeos

Requires: ANTHROPIC_API_KEY environment variable.
"""

import argparse
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
import uuid
from datetime import datetime, timezone
from pathlib import Path

from overseer.tmux_backend import get_backend as get_tmux_backend

try:
    import anthropic
except ImportError:
    print("ERROR: anthropic package required. Install with: pip install anthropic")
    sys.exit(1)

# ── Configuration ──────────────────────────────────────────────────────────────

DB_PATH = Path.home() / ".overseer" / "relay.db"
DEFAULT_POLL_INTERVAL = 60
DEFAULT_PREWARM_PCT = 55
DEFAULT_ROTATE_PCT = 75
SHADOW_TIMEOUT = 120
INTENT_TIMEOUT = 120
MAX_DIGEST_SIZE = 14000
MAX_DIFF_SIZE = 12000

JUDGMENT_MODEL = "claude-sonnet-4-20250514"

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    format="%(asctime)s [PHOENIX] %(levelname)s %(message)s",
    level=logging.INFO,
    datefmt="%H:%M:%S",
)
log = logging.getLogger("phoenix")

# ── ANSI stripping ─────────────────────────────────────────────────────────────

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")


def strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


# ── Redaction (mirrors overseer.server patterns) ──────────────────────────────

REDACTION_PATTERNS = [
    ("AWS_KEY", re.compile(r"AKIA[A-Z0-9]{16}"), "[REDACTED:AWS_KEY]"),
    ("AWS_TEMP_KEY", re.compile(r"ASIA[A-Z0-9]{16}"), "[REDACTED:AWS_TEMP_KEY]"),
    ("AWS_SECRET", re.compile(r'aws_secret_access_key["\s:=]+.{40}'), "[REDACTED:AWS_SECRET]"),
    ("AWS_SESSION", re.compile(r'aws_session_token["\s:=]+\S+'), "[REDACTED:AWS_SESSION]"),
    ("GITHUB_TOKEN", re.compile(r"ghp_[A-Za-z0-9]{36}"), "[REDACTED:GITHUB_TOKEN]"),
    ("GITHUB_PAT", re.compile(r"github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}"), "[REDACTED:GITHUB_PAT]"),
    ("GITHUB_OAUTH", re.compile(r"gho_[A-Za-z0-9]{36}"), "[REDACTED:GITHUB_OAUTH]"),
    ("GITHUB_APP", re.compile(r"ghs_[A-Za-z0-9]{36}"), "[REDACTED:GITHUB_APP]"),
    ("GITHUB_REFRESH", re.compile(r"ghu_[A-Za-z0-9]{36}"), "[REDACTED:GITHUB_REFRESH]"),
    ("STRIPE_LIVE", re.compile(r"sk_live_[A-Za-z0-9]{24,}"), "[REDACTED:STRIPE_LIVE]"),
    ("STRIPE_TEST", re.compile(r"sk_test_[A-Za-z0-9]{24,}"), "[REDACTED:STRIPE_TEST]"),
    ("STRIPE_RESTRICTED", re.compile(r"rk_(?:live|test)_[A-Za-z0-9]{24,}"), "[REDACTED:STRIPE_RESTRICTED]"),
    ("SLACK_TOKEN", re.compile(r"xox[baprs]-[A-Za-z0-9\-]+"), "[REDACTED:SLACK_TOKEN]"),
    ("PRIVATE_KEY", re.compile(r"-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----"), "[REDACTED:PRIVATE_KEY]"),
    ("API_KEY", re.compile(r'api[_\-]?key["\s:=]+[A-Za-z0-9]{20,}'), "[REDACTED:API_KEY]"),
    ("PASSWORD", re.compile(r'password["\s:=]+\S+'), "[REDACTED:PASSWORD]"),
    ("BEARER", re.compile(r"Bearer [A-Za-z0-9\-._~+/]+=*"), "[REDACTED:BEARER]"),
]


def redact_text(text: str) -> tuple:
    """Apply all 17 redaction patterns. Returns (redacted, count, types_found)."""
    count = 0
    types_found = []
    for name, pattern, replacement in REDACTION_PATTERNS:
        text, n = pattern.subn(replacement, text)
        if n > 0:
            count += n
            types_found.append(name)
    return text, count, types_found


# ── tmux helpers ───────────────────────────────────────────────────────────────


def capture_tmux(agent: str, lines: int = 200) -> str:
    """Capture terminal output from a tmux session."""
    output = get_tmux_backend().capture_output(agent, lines=lines)
    if output.startswith("Error:"):
        return ""
    return output


def tmux_display(message: str):
    """Show a transient message in tmux status line."""
    try:
        subprocess.run(["tmux", "display-message", message], capture_output=True, timeout=5)
    except Exception:
        pass


# ── Git helpers ────────────────────────────────────────────────────────────────


def run_git(repo: str, args: list) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", repo] + args,
            capture_output=True, text=True, timeout=10,
        )
        return result.stdout.strip()
    except Exception:
        return ""


def parse_git_status(porcelain: str) -> dict:
    staged = modified = untracked = 0
    for line in porcelain.splitlines():
        if not line or len(line) < 2:
            continue
        if line.startswith("??"):
            untracked += 1
        elif line[0] in "MADRCT":
            staged += 1
        elif line[1] in "MADRCT":
            modified += 1
    return {
        "clean": staged == 0 and modified == 0 and untracked == 0,
        "staged_count": staged,
        "modified_count": modified,
        "untracked_count": untracked,
    }


def parse_diff_files(numstat: str) -> list:
    files = []
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            added = int(parts[0]) if parts[0] != "-" else 0
            removed = int(parts[1]) if parts[1] != "-" else 0
            files.append({
                "path": parts[2],
                "status": "added" if added > 0 and removed == 0
                          else "deleted" if added == 0 and removed > 0
                          else "modified",
                "lines_added": added,
                "lines_removed": removed,
            })
    return files


# ── Relay DB helpers ───────────────────────────────────────────────────────────


def post_to_relay(agent: str, team_id: str, content: dict, msg_type: str) -> int:
    """Post a message to the Overseer relay DB. Returns message ID."""
    conn = sqlite3.connect(str(DB_PATH))
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO messages (agent, content, type, team_id) VALUES (?, ?, ?, ?)",
        (agent, json.dumps(content), msg_type, team_id),
    )
    conn.commit()
    msg_id = cursor.lastrowid
    conn.close()
    return msg_id


def poll_relay(
    team_id: str, msg_type: str, rotation_id: str,
    timeout: int = 60, since_id: int = 0,
) -> dict | None:
    """Poll relay for a message matching type + rotation_id. Returns payload or None."""
    start = time.time()
    while (time.time() - start) < timeout:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, content FROM messages "
            "WHERE team_id = ? AND type = ? AND id > ? ORDER BY id",
            (team_id, msg_type, since_id),
        )
        for row in cursor.fetchall():
            try:
                payload = json.loads(row["content"])
                if payload.get("rotation_id") == rotation_id:
                    conn.close()
                    return payload
            except json.JSONDecodeError:
                continue
        conn.close()
        time.sleep(2)
    return None


# ── Context estimation ─────────────────────────────────────────────────────────


# Matches Claude Code status bar: "Opus 4.5 [===       ] 30% (139318 left)"
_STATUS_BAR_RE = re.compile(r"\]\s*(\d+)%\s*\((\d+)\s*left\)")


def estimate_context(agent: str) -> dict:
    """Estimate context window usage.

    Primary method: parse the actual percentage from the Claude Code status bar
    in the tmux pane (last few lines). This is the ground truth.

    Fallback: heuristic based on terminal output volume (inaccurate, legacy).
    """
    output = capture_tmux(agent, 500)
    if not output:
        return {"pct": 0, "turns": 0, "source": "none", "recommendation": "ok"}

    lines = output.splitlines()

    # ── Primary: parse status bar from last 10 lines ──
    status_pct = None
    tokens_left = None
    for line in reversed(lines[-10:]):
        m = _STATUS_BAR_RE.search(line)
        if m:
            status_pct = int(m.group(1))
            tokens_left = int(m.group(2))
            break

    if status_pct is not None:
        # Check for context warning signs in recent output
        warnings = False
        for line in lines[-50:]:
            lo = line.lower()
            if "context" in lo and ("limit" in lo or "window" in lo):
                warnings = True
            if "summariz" in lo and "conversation" in lo:
                warnings = True

        return {
            "pct": status_pct, "tokens_left": tokens_left,
            "source": "status_bar", "warnings": warnings,
            "recommendation": "ok",  # daemon compares pct directly
        }

    # ── Fallback: heuristic (no status bar found) ──
    turns = tool_calls = 0
    for line in lines:
        s = line.strip()
        if s.startswith(("❯", ">", "$")):
            turns += 1
        if any(kw in line for kw in ("Read(", "Edit(", "Bash(", "Write(", "Grep(", "Glob(")):
            tool_calls += 1
        if any(kw in line for kw in ("Thinking", "Cogitat")):
            turns += 1

    est_tokens = (len(lines) * 15) + (turns * 3000) + (tool_calls * 1500)
    pct = min(99, int((est_tokens / 200_000) * 100))

    warnings = False
    for line in lines[-50:]:
        lo = line.lower()
        if "context" in lo and ("limit" in lo or "window" in lo):
            warnings = True
        if "summariz" in lo and "conversation" in lo:
            warnings = True
            pct = max(pct, 75)

    return {
        "pct": pct, "turns": turns, "tool_calls": tool_calls,
        "source": "heuristic", "warnings": warnings,
        "recommendation": "ok",  # daemon compares pct directly
    }


# ── LLM judgment (single-shot Sonnet) ─────────────────────────────────────────

JUDGMENT_PROMPT = """\
You are analyzing an AI agent's terminal output to extract handoff context.
The agent is being rotated out due to context window exhaustion. Extract:

1. **objective**: What is the agent currently working on? (1-2 sentences)
2. **decisions**: Key decisions made this session (list of strings, max 5)
3. **next_actions_immediate**: What the replacement agent should do first (list, max 3)
4. **next_actions_queued**: Lower-priority follow-ups (list, max 3)
5. **ack_checks**: Critical invariants the replacement must confirm (list, max 3)
   Always include: current git branch, active objective, any hard constraints.

Respond with valid JSON only. No markdown fences, no explanation.

## Terminal Output (last 300 lines)
{terminal}

## Latest Journal
{journal}

## Project Memory
{memory}"""


def llm_judgment(client: anthropic.Anthropic, terminal: str,
                 journal: str | None, memory: str | None) -> dict:
    """Single-shot Sonnet call to extract judgment from primary's work."""
    prompt = JUDGMENT_PROMPT.format(
        terminal=terminal[-15000:],
        journal=(journal or "No journal available.")[:3000],
        memory=(memory or "No memory available.")[:2000],
    )
    try:
        response = client.messages.create(
            model=JUDGMENT_MODEL,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()
        # Strip markdown code fences if present
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        return json.loads(text.strip())
    except Exception as e:
        log.error(f"LLM judgment failed: {e}")
        return {
            "objective": "Unable to determine (LLM call failed)",
            "decisions": [],
            "next_actions_immediate": ["Review terminal output manually"],
            "next_actions_queued": [],
            "ack_checks": ["Verify current git branch"],
        }


# ── Digest synthesis ──────────────────────────────────────────────────────────


def synthesize_digest(
    rotation_id: str, project_id: str, repo: str,
    primary: str, shadow: str, judgment: dict,
    reason: str = "context_high", threshold_pct: int = 75,
) -> str:
    """Build HANDOFF_DIGEST per spec v1.0.0. Returns JSON string."""
    timestamp = datetime.now(timezone.utc).isoformat()

    # ── Git state ──
    branch = run_git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) or "unknown"
    last_hash = run_git(repo, ["rev-parse", "--short", "HEAD"]) or "unknown"
    last_msg = run_git(repo, ["log", "-1", "--format=%s"]) or ""
    last_ts = run_git(repo, ["log", "-1", "--format=%aI"]) or timestamp
    status_raw = run_git(repo, ["status", "--porcelain"])
    git_status = parse_git_status(status_raw)

    remote = run_git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    ab_raw = run_git(repo, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
    ahead = behind = 0
    if ab_raw and "\t" in ab_raw:
        parts = ab_raw.split("\t")
        behind = int(parts[0]) if parts[0].isdigit() else 0
        ahead = int(parts[1]) if parts[1].isdigit() else 0

    # ── Patch diff ──
    diff = run_git(repo, ["diff"]) or ""
    diff_cached = run_git(repo, ["diff", "--cached"]) or ""
    full_diff = (diff_cached + "\n" + diff).strip() if diff_cached else diff

    numstat = run_git(repo, ["diff", "--numstat"]) or ""
    numstat_cached = run_git(repo, ["diff", "--cached", "--numstat"]) or ""
    combined = (numstat_cached + "\n" + numstat).strip() if numstat_cached else numstat
    files_affected = parse_diff_files(combined)

    truncated = len(full_diff) > MAX_DIFF_SIZE
    storage_ref = None
    if truncated:
        storage_dir = Path(f"/tmp/zeos-handover/{rotation_id}")
        storage_dir.mkdir(parents=True, exist_ok=True)
        (storage_dir / "full_diff.patch").write_text(full_diff, encoding="utf-8")
        storage_ref = str(storage_dir / "full_diff.patch")
        full_diff = full_diff[:MAX_DIFF_SIZE]

    # ── Context summary (terminal + journal) ──
    terminal = capture_tmux(primary, 200)
    recent_lines = "\n".join(terminal.splitlines()[-30:]) if terminal else ""

    journal_content = _find_latest_journal(repo)
    context_pieces = []
    if recent_lines:
        context_pieces.append(f"Recent terminal:\n{recent_lines}")
    if journal_content:
        context_pieces.append(f"Latest journal:\n{journal_content[:1500]}")
    context_summary = "\n---\n".join(context_pieces)[:3200] if context_pieces else "No context."

    # ── Continuity ──
    continuity = {"last_checkpoint": None, "last_memory_entry": None, "active_blueprint": None}
    journal_dir = Path(repo) / "session-journals"
    if journal_dir.exists():
        js = sorted(journal_dir.glob("*.md"), reverse=True)
        if js:
            continuity["last_checkpoint"] = str(js[0])

    # ── Assemble digest ──
    today = datetime.now().strftime("%Y-%m-%d")
    digest = {
        "version": "1.0.0",
        "identity": {
            "project_id": project_id,
            "session_id": f"{today}-001",
            "primary_agent": primary,
            "shadow_agent": shadow,
            "handoff_reason": reason,
            "threshold_pct": threshold_pct,
            "active_blueprint_enforcement": None,
        },
        "repo_state": {
            "repo_root": repo,
            "branch": branch,
            "remote_tracking": remote or None,
            "ahead_behind": {"ahead": ahead, "behind": behind},
            "git_status": git_status,
            "last_commit": {"hash": last_hash, "message": last_msg, "timestamp": last_ts},
        },
        "patch_diff": {
            "format": "unified_diff",
            "encoding": "utf-8",
            "truncated": truncated,
            "truncation_reason": "Size exceeded 12000 chars" if truncated else None,
            "storage_ref": storage_ref,
            "content": full_diff,
            "files_affected": files_affected,
        },
        "work_context": {
            "objective": judgment.get("objective", ""),
            "files_touched": [f["path"] for f in files_affected[:20]],
            "decisions_made": [
                {"decision": d, "rationale": ""} for d in judgment.get("decisions", [])
            ],
            "tools_used": [],
            "tests_run": [],
            "active_processes": [],
        },
        "mental_model": {
            "token_budget": 800,
            "context_summary": context_summary,
            "pending_assumptions": [],
            "unresolved_anomalies": [],
            "user_preferences_discovered": [],
        },
        "next_actions": {
            "immediate": judgment.get("next_actions_immediate", []),
            "queued": judgment.get("next_actions_queued", []),
            "blocked_by": [],
        },
        "continuity": continuity,
        "verification": {
            "ack_checks": judgment.get("ack_checks", [f"Branch: {branch}"]),
            "digest_hash": "",
        },
        "redaction": {
            "applied": False,
            "scanner_version": "1.0.0",
            "types_scanned": [name for name, _, _ in REDACTION_PATTERNS],
            "redactions_made": 0,
        },
    }

    # ── Redact ──
    digest_str = json.dumps(digest)
    digest_str, redactions, _types = redact_text(digest_str)
    digest = json.loads(digest_str)
    digest["redaction"]["applied"] = True
    digest["redaction"]["redactions_made"] = redactions

    # ── Hash ──
    final_str = json.dumps(digest, sort_keys=True)
    digest["verification"]["digest_hash"] = (
        f"sha256:{hashlib.sha256(final_str.encode()).hexdigest()[:16]}"
    )

    # ── Size enforcement ──
    final = json.dumps(digest)
    if len(final) > MAX_DIGEST_SIZE:
        over = len(final) - MAX_DIGEST_SIZE + 200
        cs = digest["mental_model"]["context_summary"]
        if len(cs) > over:
            digest["mental_model"]["context_summary"] = cs[:-over] + "\n[TRUNCATED]"
        else:
            digest["mental_model"]["context_summary"] = cs[:500]
            digest["patch_diff"]["content"] = ""
            digest["patch_diff"]["truncated"] = True
            digest["patch_diff"]["truncation_reason"] = "Digest over size budget"
        final = json.dumps(digest)

    return final


def _find_latest_journal(repo: str) -> str | None:
    """Find today's latest session journal, or most recent overall."""
    journal_dir = Path(repo) / "session-journals"
    if not journal_dir.exists():
        return None
    today = datetime.now().strftime("%Y-%m-%d")
    journals = sorted(journal_dir.glob(f"{today}-*.md"), reverse=True)
    if not journals:
        journals = sorted(journal_dir.glob("*.md"), reverse=True)
    if journals:
        try:
            return journals[0].read_text(encoding="utf-8")[:4000]
        except Exception:
            return None
    return None


def _read_memory(repo: str) -> str | None:
    """Read MEMORY.md from repo."""
    p = Path(repo) / "MEMORY.md"
    if p.exists():
        try:
            return p.read_text(encoding="utf-8")[:4000]
        except Exception:
            return None
    return None


# ── Phoenix Daemon ─────────────────────────────────────────────────────────────


class PhoenixDaemon:
    """Stateless daemon that monitors Primary context and orchestrates rotation."""

    def __init__(
        self, primary: str, shadow: str, project_id: str, repo: str,
        team_id: str, profile: str = "operator",
        poll_interval: int = DEFAULT_POLL_INTERVAL,
        prewarm_pct: int = DEFAULT_PREWARM_PCT,
        rotate_pct: int = DEFAULT_ROTATE_PCT,
    ):
        self.primary = primary
        self.shadow = shadow
        self.project_id = project_id
        self.repo = os.path.expanduser(repo)
        self.team_id = team_id
        self.profile = profile
        self.poll_interval = poll_interval
        self.prewarm_pct = prewarm_pct
        self.rotate_pct = rotate_pct

        self.daemon_agent = f"phoenix-{team_id}"
        self.running = True
        self.rotation_id: str | None = None
        self.shadow_warmed = False
        self.client = anthropic.Anthropic()  # Uses ANTHROPIC_API_KEY env var

        signal.signal(signal.SIGINT, self._shutdown)
        signal.signal(signal.SIGTERM, self._shutdown)

    def _shutdown(self, *_):
        log.info("Shutting down...")
        self.running = False

    def run(self):
        log.info("Phoenix Daemon started")
        log.info(f"  Primary:    {self.primary}")
        log.info(f"  Shadow:     {self.shadow}")
        log.info(f"  Project:    {self.project_id}")
        log.info(f"  Repo:       {self.repo}")
        log.info(f"  Team:       {self.team_id}")
        log.info(f"  Model:      {JUDGMENT_MODEL}")
        log.info(f"  Poll:       {self.poll_interval}s")
        log.info(f"  Thresholds: pre-warm={self.prewarm_pct}% rotate={self.rotate_pct}%")

        while self.running:
            try:
                ctx = estimate_context(self.primary)
                source = ctx.get("source", "?")
                extra = (f"  tokens_left={ctx['tokens_left']}"
                         if "tokens_left" in ctx else
                         f"  turns={ctx.get('turns', 0)}  tools={ctx.get('tool_calls', 0)}")
                log.info(f"Context: {ctx['pct']}%{extra}  [{source}]")

                pct = ctx["pct"]
                # Use daemon thresholds, not the hardcoded ones in estimate_context
                if pct >= self.rotate_pct or ctx.get("warnings"):
                    log.warning(f"ROTATE NOW — context at {pct}%")
                    if not self.shadow_warmed:
                        self._prewarm()
                    if self.shadow_warmed:
                        self._rotate(pct)

                elif pct >= self.prewarm_pct and not self.shadow_warmed:
                    log.info(f"Pre-warming shadow at {pct}%")
                    self._prewarm()

            except Exception as e:
                log.error(f"Poll error: {e}", exc_info=True)

            # Interruptible sleep
            for _ in range(self.poll_interval):
                if not self.running:
                    break
                time.sleep(1)

        log.info("Phoenix Daemon stopped")

    # ── Pre-warm phase ─────────────────────────────────────────────────────────

    def _prewarm(self):
        """Send WARM_SHADOW and wait for Shadow to signal ready."""
        self.rotation_id = str(uuid.uuid4())
        ts = datetime.now(timezone.utc).isoformat()

        payload = {
            "message_type": "warm_shadow",
            "rotation_id": self.rotation_id,
            "timestamp": ts,
            "shadow_agent": self.shadow,
            "handoff_intent": {
                "reason": "context_high",
                "threshold_pct": self.rotate_pct,
            },
            "project_id": self.project_id,
            "profile": self.profile,
            "prewarm": {
                "load_level": "light",
                "include": ["kernel", "profile", "project_soul", "memory_hot"],
                "exclude": ["full_journals", "blueprints"],
            },
            "requested_ready_by": None,
        }

        msg_id = post_to_relay(self.daemon_agent, self.team_id, payload, "warm_shadow")
        log.info(f"WARM_SHADOW posted (msg={msg_id}, rotation={self.rotation_id[:8]})")

        log.info("Waiting for shadow to signal ready...")
        result = poll_relay(
            self.team_id, "ready_for_digest", self.rotation_id,
            timeout=SHADOW_TIMEOUT,
        )

        if result:
            log.info(f"Shadow ready — loaded: {result.get('loaded')}")
            self.shadow_warmed = True
        else:
            log.error("Shadow failed to warm within timeout")
            tmux_display(f"Phoenix: Shadow {self.shadow} failed to warm")
            self.rotation_id = None

    # ── Rotation phase ─────────────────────────────────────────────────────────

    def _rotate(self, context_pct: int):
        """Execute full rotation handover."""
        if not self.rotation_id:
            log.error("No rotation_id — prewarm must succeed first")
            return

        log.info("=== ROTATION PHASE ===")

        # 1. Capture primary terminal
        terminal = capture_tmux(self.primary, 500)
        log.info(f"Captured {len(terminal.splitlines())} lines from {self.primary}")

        # 2. Read journal + memory for LLM
        journal = _find_latest_journal(self.repo)
        memory = _read_memory(self.repo)

        # 3. LLM judgment (Sonnet, single-shot)
        log.info(f"Calling {JUDGMENT_MODEL} for judgment...")
        judgment = llm_judgment(self.client, terminal, journal, memory)
        log.info(f"Objective: {judgment.get('objective', '?')[:80]}")

        # 4. Synthesize digest
        log.info("Synthesizing handoff digest...")
        digest_str = synthesize_digest(
            self.rotation_id, self.project_id, self.repo,
            self.primary, self.shadow, judgment,
            threshold_pct=context_pct,
        )
        log.info(f"Digest: {len(digest_str)} chars")

        # 5. Post HANDOFF_DIGEST
        digest_obj = json.loads(digest_str)
        digest_obj["rotation_id"] = self.rotation_id
        digest_obj["message_type"] = "handoff_digest"
        digest_obj["timestamp"] = datetime.now(timezone.utc).isoformat()

        msg_id = post_to_relay(self.daemon_agent, self.team_id, digest_obj, "handoff_digest")
        log.info(f"HANDOFF_DIGEST posted (msg={msg_id})")

        # 6. Wait for INTENT_STATEMENT
        log.info("Waiting for shadow intent...")
        intent = poll_relay(
            self.team_id, "intent_statement", self.rotation_id,
            timeout=INTENT_TIMEOUT,
        )

        if not intent:
            log.error("Shadow failed to send intent — aborting rotation")
            tmux_display(f"Phoenix: Shadow {self.shadow} failed to respond — rotation aborted")
            return

        confidence = intent.get("confidence", "unknown")
        log.info(f"Intent received — confidence: {confidence}")

        if confidence == "low":
            log.warning("Shadow confidence LOW — proceeding but notifying operator")
            tmux_display(f"Phoenix: Shadow confidence LOW — review rotation {self.rotation_id[:8]}")

        # 7. Post FINAL_ACK (daemon auto-approves)
        ts = datetime.now(timezone.utc).isoformat()
        ack_payload = {
            "message_type": "final_ack",
            "rotation_id": self.rotation_id,
            "timestamp": ts,
            "primary_agent": self.primary,
            "shadow_agent": self.shadow,
            "ack_validation": {"all_checks_passed": True, "mismatches": []},
            "approved": True,
            "handover_authorized": True,
        }
        msg_id = post_to_relay(self.daemon_agent, self.team_id, ack_payload, "final_ack")
        log.info(f"FINAL_ACK posted (msg={msg_id}, approved=true)")

        # 8. Post SWITCH_ROUTE
        switch_payload = {
            "message_type": "switch_route",
            "rotation_id": self.rotation_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "from_agent": self.primary,
            "to_agent": self.shadow,
            "effective_immediately": True,
        }
        msg_id = post_to_relay(self.daemon_agent, self.team_id, switch_payload, "switch_route")
        log.info(f"SWITCH_ROUTE posted (msg={msg_id})")

        # 9. Notify operator
        tmux_display(f"Phoenix: Rotation complete — switch to {self.shadow}")
        log.info(f"Rotation complete: {self.primary} -> {self.shadow}")
        log.info(f"  Rotation ID: {self.rotation_id}")

        # Post rotation summary to relay
        post_to_relay(self.daemon_agent, self.team_id, {
            "message_type": "status",
            "event": "rotation_complete",
            "rotation_id": self.rotation_id,
            "from": self.primary,
            "to": self.shadow,
            "context_pct": context_pct,
            "objective": judgment.get("objective", ""),
            "shadow_confidence": confidence,
        }, "status")

        # Swap roles for next rotation cycle
        old_primary = self.primary
        self.primary = self.shadow
        self.shadow = old_primary
        self.rotation_id = None
        self.shadow_warmed = False
        log.info(f"Roles swapped — primary: {self.primary}, shadow: {self.shadow}")


# ── API Key Resolution ─────────────────────────────────────────────────────────

TOKENS_PATH = Path.home() / ".zeos" / "tokens"
ENV_FILE_PATHS = [
    Path.home() / ".zeos" / ".env",
    Path(__file__).resolve().parent.parent.parent / ".env",  # overseer/.env
]


def resolve_api_key() -> str | None:
    """Resolve ANTHROPIC_API_KEY from multiple sources (first match wins).

    Search order:
      1. ANTHROPIC_API_KEY environment variable
      2. ~/.zeos/tokens  (KEY=VALUE format, one per line)
      3. ~/.zeos/.env    (dotenv format)
      4. overseer/.env   (dotenv format)
    """
    # 1. Environment variable
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key

    # 2. ~/.zeos/tokens
    if TOKENS_PATH.exists():
        try:
            for line in TOKENS_PATH.read_text().splitlines():
                line = line.strip()
                if line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == "ANTHROPIC_API_KEY":
                    return v.strip().strip("'\"")
        except Exception:
            pass

    # 3-4. .env files
    for env_path in ENV_FILE_PATHS:
        if env_path.exists():
            try:
                for line in env_path.read_text().splitlines():
                    line = line.strip()
                    if line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    if k.strip() == "ANTHROPIC_API_KEY":
                        return v.strip().strip("'\"")
            except Exception:
                pass

    return None


# ── CLI ────────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Phoenix Mode Daemon Monitor — zero-context session rotation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  python -m overseer.phoenix_daemon \\
      --primary claude-1 --shadow claude2-1 \\
      --project zeos-dev --repo ~/projects/zeos

  python -m overseer.phoenix_daemon \\
      --primary claude-3 --shadow claude2-3 \\
      --project example-project --repo ~/projects/example-project-website \\
      --poll-interval 90 --rotate-threshold 70

Environment:
  ANTHROPIC_API_KEY    Sonnet judgment calls. Resolved from (first match):
                       1. ANTHROPIC_API_KEY env var
                       2. ~/.zeos/tokens (KEY=VALUE format)
                       3. ~/.zeos/.env or overseer/.env (dotenv format)
""",
    )
    parser.add_argument("--primary", required=True, help="Primary agent tmux session (e.g., claude-1)")
    parser.add_argument("--shadow", required=True, help="Shadow agent tmux session (e.g., claude2-1)")
    parser.add_argument("--project", required=True, help="Project ID (e.g., zeos-dev)")
    parser.add_argument("--repo", required=True, help="Repo path (e.g., ~/projects/zeos)")
    parser.add_argument("--team", default=None, help="Team ID (auto-extracted from primary if omitted)")
    parser.add_argument("--profile", default="operator", help="zeos profile (default: operator)")
    parser.add_argument("--poll-interval", type=int, default=DEFAULT_POLL_INTERVAL,
                        help=f"Seconds between context checks (default: {DEFAULT_POLL_INTERVAL})")
    parser.add_argument("--prewarm-threshold", type=int, default=DEFAULT_PREWARM_PCT,
                        help=f"Context %% to start pre-warming (default: {DEFAULT_PREWARM_PCT})")
    parser.add_argument("--rotate-threshold", type=int, default=DEFAULT_ROTATE_PCT,
                        help=f"Context %% to trigger rotation (default: {DEFAULT_ROTATE_PCT})")
    parser.add_argument("--verbose", "-v", action="store_true", help="Debug logging")

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger("phoenix").setLevel(logging.DEBUG)

    # Extract team from primary agent name
    team_id = args.team
    if not team_id:
        if "-" in args.primary:
            suffix = args.primary.split("-")[-1]
            if suffix.isdigit():
                team_id = suffix
    if not team_id:
        print("ERROR: Could not extract team ID from primary agent name. Use --team.")
        sys.exit(1)

    # Verify shadow is on same team
    if "-" in args.shadow:
        shadow_suffix = args.shadow.split("-")[-1]
        if shadow_suffix.isdigit() and shadow_suffix != team_id:
            print(f"ERROR: Team mismatch — primary team={team_id}, shadow team={shadow_suffix}")
            sys.exit(1)

    # Resolve API key from env, ~/.zeos/tokens, or .env files
    api_key = resolve_api_key()
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not found.")
        print("  Set it via one of:")
        print("    1. export ANTHROPIC_API_KEY=sk-...")
        print(f"    2. Add to {TOKENS_PATH}")
        print(f"    3. Add to ~/.zeos/.env")
        sys.exit(1)
    os.environ["ANTHROPIC_API_KEY"] = api_key

    # Verify relay DB exists
    if not DB_PATH.exists():
        print(f"ERROR: Relay DB not found at {DB_PATH}")
        print("  Start the Overseer MCP server first to initialize the database.")
        sys.exit(1)

    daemon = PhoenixDaemon(
        primary=args.primary,
        shadow=args.shadow,
        project_id=args.project,
        repo=args.repo,
        team_id=team_id,
        profile=args.profile,
        poll_interval=args.poll_interval,
        prewarm_pct=args.prewarm_threshold,
        rotate_pct=args.rotate_threshold,
    )
    daemon.run()


if __name__ == "__main__":
    main()
