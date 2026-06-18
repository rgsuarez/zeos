#!/usr/bin/env bash
# zeos PreCompact auto-snap hook.
#
# Invoked by Claude Code as a PreCompact hook (a shell command). It reads the
# hook's stdin JSON payload, extracts the stable `session_id`, and asks the
# inject server's headless `snap` verb to checkpoint THAT session's journal
# before context compaction.
#
# Safety contract (this script is intentionally inert in most sessions):
#   - It passes ONLY the session id. The headless snap resolves a per-session
#     pointer (written by the inject server on `/project` load) and NO-OPS when
#     no pointer resolves - so a PreCompact in a non-zeos session writes nothing.
#   - It NEVER blocks compaction: every path exits 0. A failed or skipped
#     auto-capture must not stop the host from compacting.
#   - It contains no secrets and reads none; the journal write is redacted
#     downstream by the headless snap.
#   - It records actionable failures and infra-skips to a durable log so a real
#     auto-capture failure is visible (it is never surfaced to the host), while
#     recognized quiet outcomes (no pointer, no-op, wrote checkpoint) stay silent
#     so non-zeos sessions never spam the log.
#
# Node selection: a candidate must be an executable Node whose major version is
# >= 20 (matching `engines.node`); a stale sub-floor Node is refused rather than
# used. ZEOS_PRECOMPACT_NODE (default unset) is an EXCLUSIVE override: when set it
# is the sole candidate. It exists to make the hook-level never-block tests
# hermetic on a host that already has a real Node, and to let an operator pin the
# hook's runtime. Default-unset reproduces the prior selection exactly.
#
# Stdin payload (Claude Code PreCompact): a JSON object with at least
#   { "session_id": "...", "transcript_path": "...", "cwd": "...",
#     "hook_event_name": "PreCompact", "trigger": "manual"|"auto" }

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$INJECT_DIR/dist/index.js"
LIB="$SCRIPT_DIR/precompact-snap-lib.sh"

# Inline fallback logger for the ONLY case the lib's richer logger is
# unavailable: the sibling lib is missing or failed to source (the chicken-and-egg
# where we cannot use the lib's logger to report the lib missing). Mirrors the
# lib logger's HOME/`~/` guards and is equally never-blocking.
_boot_log() {
  local line="$1" root log
  root="${ZEOS_STATE_ROOT:-${HOME:-}/.zeos}"
  case "$root" in "~/"*) root="${HOME:-}${root#\~}" ;; esac
  [ -n "$root" ] || return 0
  [ "$root" = "/.zeos" ] && return 0
  log="$root/logs/precompact-snap.log"
  mkdir -p "$(dirname "$log")" 2>/dev/null || return 0
  # Group-wrap the append so a late open failure is suppressed regardless of
  # redirect ordering; never block.
  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" "$line" >>"$log"; } 2>/dev/null || true
}

# Source the lib FIRST, hardened against a corrupt/truncated sibling. After this
# point the richer precompact_log is available for every gate.
if [ -f "$LIB" ]; then
  . "$LIB" 2>/dev/null || { _boot_log "skip reason=lib-source-failed"; exit 0; }
else
  _boot_log "skip reason=lib-missing"; exit 0
fi

# If the server was never built, there is nothing to call - skip (logged).
[ -f "$ENTRY" ] || { precompact_log "skip reason=entry-missing"; exit 0; }

# Read the entire stdin payload (the hook contract delivers JSON on stdin).
PAYLOAD="$(cat 2>/dev/null || true)"

# Resolve a Node runtime: an explicit exclusive override, else vendored ->
# homebrew node@22 -> PATH. ${HOME:+...} omits the vendored candidate when HOME
# is unset so `set -u` never trips; an empty PATH-node element is skipped by
# select_supported_node. A sub-floor or absent Node is a logged skip, never an
# error.
if [ -n "${ZEOS_PRECOMPACT_NODE:-}" ]; then
  CANDS=( "$ZEOS_PRECOMPACT_NODE" )
else
  CANDS=( ${HOME:+"$HOME/.local/zeos/node/bin/node"} "/opt/homebrew/opt/node@22/bin/node" "$(command -v node 2>/dev/null || true)" )
fi
NODE_BIN="$(select_supported_node 20 "${CANDS[@]}")" || { precompact_log "skip reason=no-usable-node-ge-20"; exit 0; }

# Extract session_id from the payload using Node (always present where Node is),
# avoiding a hard jq dependency. Empty on any parse failure -> downstream no-op.
SESSION_ID="$(
  printf '%s' "$PAYLOAD" | "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", d => raw += d);
    process.stdin.on("end", () => {
      try {
        const o = JSON.parse(raw);
        const id = o && typeof o.session_id === "string" ? o.session_id : "";
        process.stdout.write(id);
      } catch { /* no id */ }
    });
  ' 2>/dev/null || true
)"

# No session id -> nothing to key a pointer on. Skip QUIETLY (the common non-zeos
# session case; logging it would spam the log on every non-zeos PreCompact).
[ -n "$SESSION_ID" ] || exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HANDOFF="[AUTO] PreCompact checkpoint $TS"

# Fire the headless snap, capturing stderr AND the exit code (stdout is unused).
# `2>&1 >/dev/null` is the load-bearing order: stderr is redirected to the
# capture, THEN stdout is sent to /dev/null, so OUT holds stderr only. The
# headless dispatch always process.exit(0)s, so rc != 0 means Node died BEFORE
# dispatch (e.g. a broken dist printing a stack trace).
OUT="$("$NODE_BIN" "$ENTRY" snap --session "$SESSION_ID" --handoff "$HANDOFF" 2>&1 >/dev/null)"; rc=$?
# Quiet ONLY on a clean outcome: rc 0 AND a recognized auto-snap outcome line.
# Anchoring on the recognized success/no-op line (rather than only grepping for
# `error`) catches a broken dist whose stack trace contains no `auto-snap` line:
# the absent recognized line and/or rc != 0 still logs it.
if [ "$rc" -eq 0 ] && printf '%s\n' "$OUT" | grep -Eq 'zeos auto-snap: (no-op|wrote checkpoint)'; then
  :  # success/no-op: stay quiet even with incidental Node warnings on stderr
else
  precompact_log "snap rc=$rc ${OUT:-<no-output>}"
fi

exit 0
