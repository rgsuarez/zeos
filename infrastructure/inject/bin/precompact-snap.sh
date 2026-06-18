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
  # A tilde root with unset/empty HOME has no safe anchor: degrade, never write
  # a root-level path (parity with precompact_log).
  case "$root" in
    "~/"*) [ -n "${HOME:-}" ] || return 0; root="${HOME}${root#\~}" ;;
  esac
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
# homebrew node@22 -> PATH. "${HOME:+...}" yields ONE quoted element when HOME is
# set (intact even if HOME contains spaces) and an empty element (skipped by
# select_supported_node) when HOME is unset, so `set -u` never trips and the
# vendored candidate is never word-split. A sub-floor or absent Node is a logged
# skip, never an error.
if [ -n "${ZEOS_PRECOMPACT_NODE:-}" ]; then
  CANDS=( "$ZEOS_PRECOMPACT_NODE" )
else
  CANDS=( "${HOME:+$HOME/.local/zeos/node/bin/node}" "/opt/homebrew/opt/node@22/bin/node" "$(command -v node 2>/dev/null || true)" )
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
# Quiet ONLY on a benign outcome: rc 0 AND either a successful checkpoint or a
# no-op for the two non-zeos reasons (no session id / no resolved pointer). Those
# two fire on every non-zeos PreCompact and must stay silent so the log is not
# spammed. EVERY other outcome is logged: a structured error, a non-zero rc (a
# broken dist whose stack trace contains no marker), OR a no-op whose reason is a
# resolved-pointer refusal or anomaly (journal-symlink-refused,
# journal-not-a-directory, pointer-journal-outside-root,
# journal-vanished-before-append, pointer-journal-not-absolute). A refusal means a
# real session's capture was prevented and MUST be visible, so the residual-2
# O_NOFOLLOW refusal is never silently swallowed by the no-op path.
# A here-string (not a `printf | grep` pipeline) so `set -o pipefail` cannot turn
# a large $OUT into a false log: grep -q short-circuits on first match and would
# SIGPIPE the upstream printf, making the pipeline non-zero and mis-logging a
# benign snap. The here-string has no upstream stage, so pipefail is irrelevant.
if [ "$rc" -eq 0 ] && grep -Eq 'zeos auto-snap: (wrote checkpoint|no-op \((no-session-id|no-active-pointer)\))' <<<"$OUT"; then
  :  # benign: clean checkpoint, or a non-zeos session (no session id / no pointer)
else
  # Bound the captured stderr so a pathological blob cannot write one huge log line.
  out_log="${OUT:-<no-output>}"
  precompact_log "snap rc=$rc ${out_log:0:4000}"
fi

exit 0
