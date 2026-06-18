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
#
# Stdin payload (Claude Code PreCompact): a JSON object with at least
#   { "session_id": "...", "transcript_path": "...", "cwd": "...",
#     "hook_event_name": "PreCompact", "trigger": "manual"|"auto" }

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$INJECT_DIR/dist/index.js"

# If the server was never built, there is nothing to call - skip silently.
[ -f "$ENTRY" ] || exit 0

# Read the entire stdin payload (the hook contract delivers JSON on stdin).
PAYLOAD="$(cat 2>/dev/null || true)"

# Resolve a Node runtime the same resilient way bin/launch does: vendored, then
# homebrew node@22, then PATH. If none is found, skip (never error).
NODE_BIN=""
for cand in \
  "$HOME/.local/zeos/node/bin/node" \
  "/opt/homebrew/opt/node@22/bin/node" \
  "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$cand" ] && [ -x "$cand" ]; then
    NODE_BIN="$cand"
    break
  fi
done
[ -n "$NODE_BIN" ] || exit 0

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

# No session id -> nothing to key a pointer on. Skip (the common non-zeos case).
[ -n "$SESSION_ID" ] || exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HANDOFF="[AUTO] PreCompact checkpoint $TS"

# Fire the headless snap. It resolves the pointer and no-ops if absent/stale.
# Detach from this script's exit status so a snap error cannot block compaction.
"$NODE_BIN" "$ENTRY" snap --session "$SESSION_ID" --handoff "$HANDOFF" \
  >/dev/null 2>&1 || true

exit 0
