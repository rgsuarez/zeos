#!/usr/bin/env bash
# zeos compaction hooks: post-compaction re-orientation injector + event logger.
#
# One script, two modes, selected by argv[1]:
#
#   SessionStartCompact  - registered as a SessionStart hook with matcher
#                          "compact". Emits a fixed re-orientation instruction on
#                          stdout; SessionStart is one of the documented
#                          stdout-injecting hook events, so the text lands in
#                          front of the model immediately after any compaction
#                          (auto or manual), before its next request. Deliberately
#                          STATIC: no stdin parsing, no runtime dependency - the
#                          matcher already scopes the event, and a hook that
#                          cannot fail cannot degrade a resume.
#
#   PostCompact          - registered as a PostCompact hook. Observation only:
#                          PostCompact stdout is NOT model-visible by contract
#                          (docs: no decision control; stdout to debug log only).
#                          Best-effort appends one line per compaction to
#                          $ZEOS_STATE_ROOT/logs/compact-events.log so the
#                          operator and fleet tooling can see when a session
#                          proceeded on summary-derived context.
#
# Safety contract (mirrors precompact-snap.sh):
#   - NEVER blocks: every path exits 0, on any input, in any environment.
#     Registration MUST carry a short "timeout" (seconds; 10 is the deployed
#     value) so even a wedged runtime cannot hold the session to the hooks
#     default 600s budget.
#   - Reads no secrets; logs metadata only (session id, trigger, cwd, summary
#     UTF-8 byte-length - never summary content). Logged fields are stripped of
#     control characters so one event can never forge extra log lines.
#   - Logger degrades quietly when python3 is unavailable or the payload is
#     unparseable (a parse-skip line where the log is writable, else nothing);
#     the injector needs no runtime at all.
#   - Refuses symlink / non-regular log targets (a FIFO would hang the open),
#     parity with precompact-snap.sh.
#
# Provenance: built from the 2026-07-15 handoff-vs-auto-compact retention study
# (handoff skill SIMULATION.md study 2): real compact summaries measured ~53%
# overall / 0% tool-result-only-fact in-context retention, so a just-compacted
# session must re-verify before mutating. The injected text below is phrased as
# factual guidance (not out-of-band system commands) per the hooks docs'
# prompt-injection-defense caveat.

set -uo pipefail

MODE="${1:-}"

emit_reorient() {
  cat <<'REORIENT'
Context note: this session's earlier history was just replaced by a compaction summary. Measured on real sessions, such summaries retain roughly half of load-bearing facts and can lose tool-result-only values (exact ids, measured numbers, verbatim wording) entirely. Before the next mutating action (file edit, commit, push, external write, config or state change):
1. Re-read the mission's primary sources that apply: the campaign anchor or latest handoff bundle if one exists, the active plan file if any, and current lane state.
2. Treat values that exist only in the summary as unverified; re-check them against files, git, or live systems before acting on them.
3. If this session is fleet-tracked (an orchestrator or a packet-born executor), report that a compaction occurred in the next SITREP.
4. Prefer handing off at the next clean state boundary (/handoff) over running on through further compactions.
The full pre-compaction transcript remains on disk at the path named at the end of the summary; grep it for any specific lost detail.
REORIENT
}

log_target() {
  local root="${ZEOS_STATE_ROOT:-${HOME:-}/.zeos}"
  # shellcheck disable=SC2088  # literal "~/" prefix match on a configured value (parity with precompact-snap.sh), not tilde expansion
  case "$root" in
    "~/"*) [ -n "${HOME:-}" ] || return 1; root="${HOME}${root#\~}" ;;
  esac
  [ -n "$root" ] || return 1
  [ "$root" = "/.zeos" ] && return 1
  printf '%s' "$root/logs/compact-events.log"
}

append_log() {
  # $1 = line. Never blocks; degrades quietly on any refusal.
  local log
  log="$(log_target)" || return 0
  if [ -L "$log" ] || { [ -e "$log" ] && [ ! -f "$log" ]; }; then return 0; fi
  mkdir -p "$(dirname "$log")" 2>/dev/null || return 0
  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" "$1" >>"$log"; } 2>/dev/null || true
}

case "$MODE" in
  SessionStartCompact)
    # Static injection; consume stdin so the host never sees a broken pipe.
    cat >/dev/null 2>&1 || true
    emit_reorient
    ;;
  PostCompact)
    PAYLOAD="$(cat 2>/dev/null || true)"
    PY="$(command -v python3 2>/dev/null || true)"
    if [ -n "$PY" ] && [ -n "$PAYLOAD" ]; then
      LINE="$(printf '%s' "$PAYLOAD" | "$PY" -c '
import json, sys

def clean(v):
    # One log line per event: strip control characters (incl. newlines) so a
    # hostile or malformed field can never forge extra lines or shift columns.
    s = v if isinstance(v, str) else "?"
    s = "".join(ch for ch in s if ch.isprintable())
    return s if s else "?"

try:
    o = json.load(sys.stdin)
    if not isinstance(o, dict):
        raise ValueError
    sid = clean(o.get("session_id", "?"))
    trig = clean(o.get("trigger", "?"))
    cwd = clean(o.get("cwd", "?"))
    summ = o.get("compact_summary", "")
    n = len(summ.encode("utf-8", "ignore")) if isinstance(summ, str) else 0
    print(f"compact session={sid} trigger={trig} cwd={cwd} summary_bytes={n}")
except Exception:
    print("compact parse-skip")
' 2>/dev/null || true)"
      LINE="$(printf '%s' "$LINE" | head -n1)"
      append_log "${LINE:-compact parse-skip}"
    else
      append_log "compact parse-skip reason=no-python3-or-empty-payload"
    fi
    ;;
  *)
    # Unknown mode: consume stdin, do nothing. Never block.
    cat >/dev/null 2>&1 || true
    ;;
esac

exit 0
