#!/usr/bin/env bash
# Tests for the zeos PreCompact auto-snap hook and its sourceable lib. Plain
# bash + asserts, no test framework, modeled on launcher.test.sh.
#
# Two parts:
#   C1  lib unit:   select_supported_node (Node-floor selection) and
#                   precompact_log (durable logging, ~/ expansion, rotation,
#                   degrade) exercised directly via hermetic stubs.
#   C2  hook-level: the REAL precompact-snap.sh run end-to-end with
#                   ZEOS_PRECOMPACT_NODE pointing at a hermetic Node stub, a temp
#                   HOME, and a temp ZEOS_STATE_ROOT. Each case proves the hook
#                   exits 0 (NEVER blocks compaction) AND logs/stays-quiet as
#                   designed. Hook copies run from temp bin dirs so entry/lib
#                   presence is controlled per case with no dependence on the
#                   host's real Node or built dist.
#
# Run: bash infrastructure/tests/precompact-snap.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZEOS_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOK="$ZEOS_REPO_ROOT/infrastructure/inject/bin/precompact-snap.sh"
LIB="$ZEOS_REPO_ROOT/infrastructure/inject/bin/precompact-snap-lib.sh"

PASS=0; FAIL=0; FAILED_TESTS=()
LAST_RC=0

# Source the lib so C1 can call its functions directly. (C2 runs the hook as a
# subprocess, which sources its own copy.)
# shellcheck source=../inject/bin/precompact-snap-lib.sh
source "$LIB"

# ── assert helpers ───────────────────────────────────────────────────────────
assert() { # name expected actual
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS+1)); printf '  ✓ %s\n' "$name"
  else
    FAIL=$((FAIL+1)); FAILED_TESTS+=("$name")
    printf '  ✗ %s\n      expected: %q\n      actual:   %q\n' "$name" "$expected" "$actual"
  fi
}
assert_contains() { # name needle haystack
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -q -- "$needle"; then
    PASS=$((PASS+1)); printf '  ✓ %s\n' "$name"
  else
    FAIL=$((FAIL+1)); FAILED_TESTS+=("$name")
    printf '  ✗ %s\n      needle:   %q\n      haystack: %q\n' "$name" "$needle" "$haystack"
  fi
}
assert_file() { # name path  (expect a regular file)
  local name="$1" p="$2"
  if [ -f "$p" ]; then
    PASS=$((PASS+1)); printf '  ✓ %s\n' "$name"
  else
    FAIL=$((FAIL+1)); FAILED_TESTS+=("$name")
    printf '  ✗ %s\n      missing file: %q\n' "$name" "$p"
  fi
}
assert_no_file() { # name path  (expect absent)
  local name="$1" p="$2"
  if [ ! -e "$p" ]; then
    PASS=$((PASS+1)); printf '  ✓ %s\n' "$name"
  else
    FAIL=$((FAIL+1)); FAILED_TESTS+=("$name")
    printf '  ✗ %s\n      unexpected file present: %q\n' "$name" "$p"
  fi
}

# ── hermetic stubs ───────────────────────────────────────────────────────────

# A minimal Node stub for C1's select_supported_node: prints a fixed version.
make_node_stub() { # path version
  local p="$1" ver="$2"
  cat > "$p" <<SH
#!/bin/sh
[ "\$1" = "--version" ] && echo "$ver"
exit 0
SH
  chmod +x "$p"
}

# A richer Node stub for C2: switches on argv and honors STUB_* env to drive the
# hook's three Node invocations (--version selection, -e session-id extraction,
# and the `snap` fire).
STUB_DIR="$(mktemp -d)"
STUB="$STUB_DIR/node-stub"
cat > "$STUB" <<'SH'
#!/bin/sh
case "$1" in
  --version) echo "${STUB_VERSION:-v22.0.0}"; exit 0 ;;
  -e) printf '%s' "${STUB_SESSION_ID:-11111111-1111-1111-1111-111111111111}"; exit 0 ;;
esac
# Otherwise the snap invocation: argv is "<entry> snap --session ... --handoff ...".
for a in "$@"; do
  if [ "$a" = "snap" ]; then
    [ -n "${STUB_SNAP_STDERR:-}" ] && printf '%s\n' "$STUB_SNAP_STDERR" >&2
    exit "${STUB_SNAP_RC:-0}"
  fi
done
exit 0
SH
chmod +x "$STUB"

# Lay out a temp copy of the hook so ENTRY (<copy>/../dist/index.js) and the
# sibling lib presence are controlled per-case. Echoes the hook copy path.
setup_hook_copy() { # tmp with_lib(1/0) with_entry(1/0)
  local tmp="$1" with_lib="$2" with_entry="$3"
  mkdir -p "$tmp/inject/bin" "$tmp/inject/dist"
  cp "$HOOK" "$tmp/inject/bin/precompact-snap.sh"
  chmod +x "$tmp/inject/bin/precompact-snap.sh"
  if [ "$with_lib" = "1" ]; then cp "$LIB" "$tmp/inject/bin/precompact-snap-lib.sh"; fi
  if [ "$with_entry" = "1" ]; then printf '// dummy entry (never executed; the stub Node ignores it)\n' > "$tmp/inject/dist/index.js"; fi
  printf '%s' "$tmp/inject/bin/precompact-snap.sh"
}

# Run a prepared hook copy with the C2 stub; sets LAST_RC. Extra KEY=VAL args are
# passed through to the hook's environment (e.g. STUB_VERSION=v18.20.4).
run_hook() { # hook state [KEY=VAL ...]
  local hook="$1" state="$2"; shift 2
  printf '{"session_id":"abc"}' | env ZEOS_PRECOMPACT_NODE="$STUB" ZEOS_STATE_ROOT="$state" "$@" "$hook" >/dev/null 2>&1
  LAST_RC=$?
}

# ═════════════════════════════════════════════════════════════════════════════
# C1: lib unit
# ═════════════════════════════════════════════════════════════════════════════

test_c1_select_picks_supported() {
  local tmp; tmp="$(mktemp -d)"
  make_node_stub "$tmp/n18" "v18.20.4"
  make_node_stub "$tmp/n22" "v22.3.0"
  local out; out="$(select_supported_node 20 "$tmp/n18" "$tmp/n22")"
  assert "C1.1 select picks first >=20 (v22) over sub-floor v18" "$tmp/n22" "$out"
  rm -rf "$tmp"
}

test_c1_select_rejects_all_subfloor() {
  local tmp; tmp="$(mktemp -d)"
  make_node_stub "$tmp/n18" "v18.20.4"
  local out rc; out="$(select_supported_node 20 "$tmp/n18")"; rc=$?
  assert "C1.2 select returns nonzero when all sub-floor" "1" "$rc"
  assert "C1.2 select echoes nothing when none qualify" "" "$out"
  rm -rf "$tmp"
}

test_c1_select_skips_missing_and_garbage() {
  local tmp; tmp="$(mktemp -d)"
  make_node_stub "$tmp/garbage" "not-a-version"
  make_node_stub "$tmp/n22" "v22.3.0"
  local out; out="$(select_supported_node 20 "/no/such/node" "$tmp/garbage" "$tmp/n22")"
  assert "C1.3 select skips missing + garbage, returns v22" "$tmp/n22" "$out"
  rm -rf "$tmp"
}

test_c1_log_creates() {
  local tmp; tmp="$(mktemp -d)"
  ( export ZEOS_STATE_ROOT="$tmp"; precompact_log "creates-me" )
  local log="$tmp/logs/precompact-snap.log"
  assert_file "C1.4 precompact_log creates the log file" "$log"
  [ -f "$log" ] && assert_contains "C1.4 precompact_log writes the line" "creates-me" "$(cat "$log")"
  rm -rf "$tmp"
}

test_c1_tilde_expansion() {
  local home; home="$(mktemp -d)"
  local sub="zeos-test-$$"
  # A LITERAL tilde in ZEOS_STATE_ROOT must expand under $HOME (parity with the
  # Node expandPath resolver), NOT create a literal "~" directory. cd into $home
  # so any literal-"~" litter from a regression lands under $home and is cleaned.
  ( cd "$home" && export HOME="$home" && export ZEOS_STATE_ROOT="~/$sub" && precompact_log "tilde-line" )
  local expected="$home/$sub/logs/precompact-snap.log"
  assert_file "C1.5 ~/ expands under \$HOME (not a literal ~ dir)" "$expected"
  [ -f "$expected" ] && assert_contains "C1.5 expanded log holds the line" "tilde-line" "$(cat "$expected")"
  rm -rf "$home"
}

test_c1_rotation() {
  local tmp; tmp="$(mktemp -d)"
  local log="$tmp/logs/precompact-snap.log"
  mkdir -p "$tmp/logs"
  head -c 300000 /dev/zero | tr '\0' 'A' > "$log"   # > 256 KiB -> next append rotates
  ( export ZEOS_STATE_ROOT="$tmp"; precompact_log "after-rotation" )
  assert_file "C1.6 rotated .log.1 exists" "$log.1"
  if [ -f "$log" ]; then
    local newsz; newsz="$(wc -c <"$log" 2>/dev/null | tr -d '[:space:]' || echo 0)"
    if [ "${newsz:-0}" -lt 1000 ]; then
      PASS=$((PASS+1)); printf '  ✓ C1.6 new .log is small after rotation\n'
    else
      FAIL=$((FAIL+1)); FAILED_TESTS+=("C1.6 new log small"); printf '  ✗ C1.6 new .log not small (%s bytes)\n' "$newsz"
    fi
    assert_contains "C1.6 new log holds the post-rotation line" "after-rotation" "$(cat "$log")"
  fi
  rm -rf "$tmp"
}

test_c1_degrade_never_blocks() {
  # (a) mkdir fails (root under a regular file) -> rc 0, no write.
  local tmp; tmp="$(mktemp -d)"; printf 'x' > "$tmp/blocker"
  local rc; rc="$( export ZEOS_STATE_ROOT="$tmp/blocker/sub"; precompact_log "nope"; echo $? )"
  assert "C1.7a precompact_log returns 0 when the log root is unwritable" "0" "$rc"
  assert_no_file "C1.7a no log written under an unwritable root" "$tmp/blocker/sub/logs/precompact-snap.log"
  # (b) bare root (HOME unset, no override) -> resolves to /.zeos -> rc 0, no write.
  local rc2; rc2="$( unset HOME; unset ZEOS_STATE_ROOT; precompact_log "nope"; echo $? )"
  assert "C1.7b precompact_log returns 0 with no HOME and no override (bare /.zeos)" "0" "$rc2"
  # (c) tilde root with HOME unset must DEGRADE, not resolve to the tilde-stripped
  # path. Aim the tilde at a WRITABLE location so a regression (writing the
  # tilde-stripped path) would actually create a file; the fix must write nothing.
  local wr; wr="$(mktemp -d)"
  local rc3; rc3="$( unset HOME; export ZEOS_STATE_ROOT="~$wr/sub"; precompact_log "nope"; echo $? )"
  assert "C1.7c precompact_log returns 0 for a tilde root with unset HOME" "0" "$rc3"
  assert_no_file "C1.7c tilde root + unset HOME degrades (no write to the tilde-stripped path)" "$wr/sub/logs/precompact-snap.log"
  rm -rf "$wr" "$tmp"
}

# ═════════════════════════════════════════════════════════════════════════════
# C2: hook-level never-block integration (the REAL precompact-snap.sh)
# ═════════════════════════════════════════════════════════════════════════════

test_c2_unsupported_node() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 1)"
  run_hook "$hook" "$state" STUB_VERSION=v18.20.4
  assert "C2.1 sub-floor Node: hook exits 0" "0" "$LAST_RC"
  local log="$state/logs/precompact-snap.log"
  assert_file "C2.1 sub-floor Node: skip is logged" "$log"
  [ -f "$log" ] && assert_contains "C2.1 logs no-usable-node-ge-20" "no-usable-node-ge-20" "$(cat "$log")"
  # snap must NOT have been invoked (no snap-outcome record).
  [ -f "$log" ] && { printf '%s' "$(cat "$log")" | grep -q 'snap rc=' && { FAIL=$((FAIL+1)); FAILED_TESTS+=("C2.1 snap not invoked"); printf '  ✗ C2.1 snap was invoked despite sub-floor Node\n'; } || { PASS=$((PASS+1)); printf '  ✓ C2.1 snap not invoked on sub-floor Node\n'; }; }
  rm -rf "$tmp"
}

test_c2_missing_entry() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 0)"   # lib present, entry absent
  run_hook "$hook" "$state"
  assert "C2.2 missing entry: hook exits 0" "0" "$LAST_RC"
  local log="$state/logs/precompact-snap.log"
  assert_file "C2.2 missing entry: skip is logged" "$log"
  [ -f "$log" ] && assert_contains "C2.2 logs entry-missing" "entry-missing" "$(cat "$log")"
  rm -rf "$tmp"
}

test_c2_snap_error_logged() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 1)"
  run_hook "$hook" "$state" STUB_VERSION=v22.0.0 STUB_SNAP_STDERR="zeos auto-snap: error (boom)" STUB_SNAP_RC=0
  assert "C2.3 snap error: hook exits 0" "0" "$LAST_RC"
  local log="$state/logs/precompact-snap.log"
  assert_file "C2.3 snap error: log written" "$log"
  [ -f "$log" ] && assert_contains "C2.3 log captures the structured error" "auto-snap: error (boom)" "$(cat "$log")"
  rm -rf "$tmp"
}

test_c2_noop_quiet() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 1)"
  run_hook "$hook" "$state" STUB_VERSION=v22.0.0 STUB_SNAP_STDERR="zeos auto-snap: no-op (no-active-pointer)" STUB_SNAP_RC=0
  assert "C2.4 no-op: hook exits 0" "0" "$LAST_RC"
  assert_no_file "C2.4 no-op is QUIET (no log written)" "$state/logs/precompact-snap.log"
  rm -rf "$tmp"
}

test_c2_success_quiet() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 1)"
  run_hook "$hook" "$state" STUB_VERSION=v22.0.0 STUB_SNAP_STDERR="zeos auto-snap: wrote checkpoint to /tmp/j.md" STUB_SNAP_RC=0
  assert "C2.5 wrote-checkpoint: hook exits 0" "0" "$LAST_RC"
  assert_no_file "C2.5 wrote-checkpoint is QUIET (no log written)" "$state/logs/precompact-snap.log"
  rm -rf "$tmp"
}

test_c2_unset_home() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 1)"
  # HOME unset must not trip `set -u`; ZEOS_STATE_ROOT is explicit so the log can
  # still resolve. A clean no-op stays quiet.
  printf '{"session_id":"abc"}' | env -u HOME ZEOS_PRECOMPACT_NODE="$STUB" ZEOS_STATE_ROOT="$state" STUB_VERSION=v22.0.0 STUB_SNAP_STDERR="zeos auto-snap: no-op (no-active-pointer)" STUB_SNAP_RC=0 "$hook" >/dev/null 2>&1
  LAST_RC=$?
  assert "C2.6 unset HOME: hook exits 0 (no nounset crash)" "0" "$LAST_RC"
  assert_no_file "C2.6 unset HOME: clean no-op stays quiet" "$state/logs/precompact-snap.log"
  rm -rf "$tmp"
}

test_c2_lib_missing() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 0 1)"   # NO sibling lib
  run_hook "$hook" "$state"
  assert "C2.7 lib-missing: hook exits 0" "0" "$LAST_RC"
  local log="$state/logs/precompact-snap.log"
  assert_file "C2.7 lib-missing: inline fallback logged it" "$log"
  [ -f "$log" ] && assert_contains "C2.7 logs lib-missing via the inline fallback" "lib-missing" "$(cat "$log")"
  rm -rf "$tmp"
}

test_c2_non_marker_failure() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 1)"
  # A broken dist: stderr has NO recognized auto-snap line AND a non-zero exit.
  # The grep-recognized-line filter would have silently dropped this; the absent
  # line and rc!=0 must still log it.
  run_hook "$hook" "$state" STUB_VERSION=v22.0.0 STUB_SNAP_STDERR="SyntaxError: unexpected end of input" STUB_SNAP_RC=1
  assert "C2.8 non-marker failure: hook exits 0" "0" "$LAST_RC"
  local log="$state/logs/precompact-snap.log"
  assert_file "C2.8 non-marker failure: log written" "$log"
  [ -f "$log" ] && assert_contains "C2.8 logs the non-zero rc" "snap rc=1" "$(cat "$log")"
  [ -f "$log" ] && assert_contains "C2.8 log captures the bounded failure output" "SyntaxError" "$(cat "$log")"
  rm -rf "$tmp"
}

test_c2_lib_source_failed() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 1)"
  printf '(\n' > "$tmp/inject/bin/precompact-snap-lib.sh"   # present but unsourceable
  run_hook "$hook" "$state"
  assert "C2.9 lib-source-failed: hook exits 0" "0" "$LAST_RC"
  local log="$state/logs/precompact-snap.log"
  assert_file "C2.9 lib-source-failed: inline fallback logged it" "$log"
  [ -f "$log" ] && assert_contains "C2.9 logs lib-source-failed (distinct from lib-missing)" "lib-source-failed" "$(cat "$log")"
  rm -rf "$tmp"
}

test_c2_refusal_noop_logged() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 1)"
  # A resolved-pointer refusal (the residual-2 O_NOFOLLOW case) surfaces as a
  # no-op line but is ACTIONABLE: it must be logged, not swallowed as benign.
  run_hook "$hook" "$state" STUB_VERSION=v22.0.0 STUB_SNAP_STDERR="zeos auto-snap: no-op (journal-symlink-refused)" STUB_SNAP_RC=0
  assert "C2.10 symlink-refused no-op: hook exits 0" "0" "$LAST_RC"
  local log="$state/logs/precompact-snap.log"
  assert_file "C2.10 symlink-refused no-op is LOGGED (not silently quiet)" "$log"
  [ -f "$log" ] && assert_contains "C2.10 log records the refusal reason" "journal-symlink-refused" "$(cat "$log")"
  rm -rf "$tmp"
}

test_c2_notadir_noop_logged() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 1)"
  run_hook "$hook" "$state" STUB_VERSION=v22.0.0 STUB_SNAP_STDERR="zeos auto-snap: no-op (journal-not-a-directory)" STUB_SNAP_RC=0
  assert "C2.11 not-a-directory no-op: hook exits 0" "0" "$LAST_RC"
  local log="$state/logs/precompact-snap.log"
  assert_file "C2.11 not-a-directory no-op is LOGGED" "$log"
  [ -f "$log" ] && assert_contains "C2.11 log records the not-a-directory reason" "journal-not-a-directory" "$(cat "$log")"
  rm -rf "$tmp"
}

test_c2_no_session_id_quiet() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 1)"
  # The OTHER benign reason (besides no-active-pointer) must also stay quiet.
  run_hook "$hook" "$state" STUB_VERSION=v22.0.0 STUB_SNAP_STDERR="zeos auto-snap: no-op (no-session-id)" STUB_SNAP_RC=0
  assert "C2.12 no-session-id no-op: hook exits 0" "0" "$LAST_RC"
  assert_no_file "C2.12 no-session-id no-op stays QUIET (benign non-zeos reason)" "$state/logs/precompact-snap.log"
  rm -rf "$tmp"
}

test_c2_large_benign_output_quiet() {
  local tmp; tmp="$(mktemp -d)"; local state="$tmp/state"
  local hook; hook="$(setup_hook_copy "$tmp" 1 1)"
  # A benign no-op line followed by a large stderr blob (> the 64 KiB pipe buffer).
  # The here-string match must NOT false-log it: the old printf|grep pipeline could
  # SIGPIPE the upstream printf under pipefail and mis-log a benign snap.
  local big; big="$(head -c 100000 /dev/zero | tr '\0' 'x')"
  run_hook "$hook" "$state" STUB_VERSION=v22.0.0 STUB_SNAP_STDERR="zeos auto-snap: no-op (no-active-pointer) $big" STUB_SNAP_RC=0
  assert "C2.13 large benign output: hook exits 0" "0" "$LAST_RC"
  assert_no_file "C2.13 large benign no-op stays QUIET (no SIGPIPE false-log)" "$state/logs/precompact-snap.log"
  rm -rf "$tmp"
}

# ── run ──────────────────────────────────────────────────────────────────────
printf '\nzeos PreCompact auto-snap hook tests\n'
printf '\nC1 lib unit (select_supported_node + precompact_log):\n'
test_c1_select_picks_supported
test_c1_select_rejects_all_subfloor
test_c1_select_skips_missing_and_garbage
test_c1_log_creates
test_c1_tilde_expansion
test_c1_rotation
test_c1_degrade_never_blocks
printf '\nC2 hook-level never-block integration:\n'
test_c2_unsupported_node
test_c2_missing_entry
test_c2_snap_error_logged
test_c2_noop_quiet
test_c2_success_quiet
test_c2_unset_home
test_c2_lib_missing
test_c2_non_marker_failure
test_c2_lib_source_failed
test_c2_refusal_noop_logged
test_c2_notadir_noop_logged
test_c2_no_session_id_quiet
test_c2_large_benign_output_quiet

rm -rf "$STUB_DIR"

printf '\n%d passed, %d failed' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '\nfailed tests:\n'
  for t in "${FAILED_TESTS[@]}"; do printf '  - %s\n' "$t"; done
  printf '\n'
  exit 1
fi
printf '\n\n'
exit 0
