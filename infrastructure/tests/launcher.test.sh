#!/usr/bin/env bash
# Regression tests for the zeos MCP launchers. Plain bash + diff — no test
# framework needed. Each test is a function ending in _ok or _fail; the runner
# at the bottom calls them all and tallies.
#
# What's covered:
#   - happy path: each launcher --check exits 0 and prints OK
#   - missing entry file: launcher exits 66 with actionable message
#   - vendored runtime missing: launcher falls through to homebrew, still works
#   - all candidate runtimes broken: launcher exits 64
#   - shared lib functions: log directory creation, runtime resolution
#
# Run: bash infrastructure/tests/launcher.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZEOS_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INJECT_LAUNCH="$ZEOS_REPO_ROOT/infrastructure/inject/bin/launch"
OVERSEER_LAUNCH="$ZEOS_REPO_ROOT/infrastructure/overseer/bin/launch"
LIB="$ZEOS_REPO_ROOT/infrastructure/zeos-mcp-launcher-lib.sh"

PASS=0; FAIL=0; FAILED_TESTS=()

# shellcheck source=../zeos-mcp-launcher-lib.sh
source "$LIB"

assert() {
  local name="$1"; local expected="$2"; local actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS+1))
    printf '  ✓ %s\n' "$name"
  else
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name")
    printf '  ✗ %s\n      expected: %q\n      actual:   %q\n' "$name" "$expected" "$actual"
  fi
}

assert_contains() {
  local name="$1"; local needle="$2"; local haystack="$3"
  if echo "$haystack" | grep -q -- "$needle"; then
    PASS=$((PASS+1))
    printf '  ✓ %s\n' "$name"
  else
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name")
    printf '  ✗ %s\n      needle: %q\n      haystack: %q\n' "$name" "$needle" "$haystack"
  fi
}

# ─────────────────────────────────────────────────────────────────────
# T1: happy path — both --check return 0 with OK status
# ─────────────────────────────────────────────────────────────────────
test_inject_check_ok() {
  local out rc
  out="$("$INJECT_LAUNCH" --check 2>&1)"; rc=$?
  assert "inject --check exits 0" "0" "$rc"
  assert_contains "inject --check prints OK" "OK component=inject" "$out"
  assert_contains "inject --check shows runtime path" "runtime=" "$out"
}

test_overseer_check_ok() {
  local out rc
  out="$("$OVERSEER_LAUNCH" --check 2>&1)"; rc=$?
  assert "overseer --check exits 0" "0" "$rc"
  assert_contains "overseer --check prints OK" "OK component=overseer" "$out"
  assert_contains "overseer --check shows runtime path" "runtime=" "$out"
}

# ─────────────────────────────────────────────────────────────────────
# T2: runtime resolution — vendored beats homebrew
# ─────────────────────────────────────────────────────────────────────
test_resolve_runtime_picks_first_working() {
  local fake_dir; fake_dir="$(mktemp -d)"
  local good="$fake_dir/good"
  cat > "$good" <<'SH'
#!/bin/sh
echo "v1.0.0"
SH
  chmod +x "$good"
  local out
  out="$(zeos_mcp_resolve_runtime "test" "/nonexistent/path" "$good" 2>/dev/null)"
  assert "resolve_runtime picks first working candidate" "$good" "$out"
  rm -rf "$fake_dir"
}

test_resolve_runtime_fails_when_all_broken() {
  local fake_dir; fake_dir="$(mktemp -d)"
  local broken="$fake_dir/broken"
  cat > "$broken" <<'SH'
#!/bin/sh
exit 1
SH
  chmod +x "$broken"
  local rc
  zeos_mcp_resolve_runtime "test" "/no/path1" "/no/path2" "$broken" >/dev/null 2>&1
  rc=$?
  assert "resolve_runtime exits 64 when all candidates fail" "64" "$rc"
  rm -rf "$fake_dir"
}

# ─────────────────────────────────────────────────────────────────────
# T3: missing entry file — exit 66 with actionable hint
# ─────────────────────────────────────────────────────────────────────
test_inject_missing_entry() {
  local stash; stash="$(mktemp -d)"
  local entry="$ZEOS_REPO_ROOT/infrastructure/inject/dist/index.js"
  mv "$entry" "$stash/index.js"
  local out rc
  out="$("$INJECT_LAUNCH" --check 2>&1)"; rc=$?
  mv "$stash/index.js" "$entry"  # restore before assertions in case they fail
  rmdir "$stash"
  assert "inject --check exits 66 when dist/index.js missing" "66" "$rc"
  assert_contains "inject error mentions the missing path" "missing $entry" "$out"
  assert_contains "inject error gives rebuild hint" "npm run build" "$out"
}

# ─────────────────────────────────────────────────────────────────────
# T4: log directory creation
# ─────────────────────────────────────────────────────────────────────
test_log_dir_created() {
  local backup; backup="${ZEOS_MCP_LOG_DIR}.bak.$$"
  if [ -d "$ZEOS_MCP_LOG_DIR" ]; then
    mv "$ZEOS_MCP_LOG_DIR" "$backup"
  fi
  zeos_mcp_log "test-component" "test-event" "k=v" >/dev/null 2>&1 || true
  if [ -d "$ZEOS_MCP_LOG_DIR" ]; then
    PASS=$((PASS+1)); printf '  ✓ zeos_mcp_log creates log directory\n'
  else
    FAIL=$((FAIL+1)); FAILED_TESTS+=("log dir creation")
    printf '  ✗ zeos_mcp_log did not create %s\n' "$ZEOS_MCP_LOG_DIR"
  fi
  rm -f "$ZEOS_MCP_LOG_DIR/test-component.log" 2>/dev/null
  if [ -d "$backup" ]; then
    rmdir "$ZEOS_MCP_LOG_DIR" 2>/dev/null || true
    mv "$backup" "$ZEOS_MCP_LOG_DIR"
  fi
}

# ─────────────────────────────────────────────────────────────────────
# T5: vendored fallback — kill the vendored Node, launcher should still work
# ─────────────────────────────────────────────────────────────────────
test_inject_falls_back_when_vendored_missing() {
  local vendored="$HOME/.local/zeos/node"
  if [ ! -L "$vendored" ]; then
    printf '  · skip: vendored Node symlink not present at %s\n' "$vendored"
    return 0
  fi
  local target; target="$(readlink "$vendored")"
  rm "$vendored"
  local out rc
  out="$("$INJECT_LAUNCH" --check 2>&1)"; rc=$?
  ln -snf "$target" "$vendored"  # restore
  assert "inject --check still exits 0 when vendored Node missing (homebrew fallback)" "0" "$rc"
  assert_contains "fallback used homebrew" "/opt/homebrew/opt/node@22/bin/node" "$out"
}

# ─────────────────────────────────────────────────────────────────────
# Run
# ─────────────────────────────────────────────────────────────────────
printf '\nzeos MCP launcher tests\n\n'
printf 'T1 happy path:\n';                    test_inject_check_ok; test_overseer_check_ok
printf '\nT2 runtime resolution:\n';          test_resolve_runtime_picks_first_working; test_resolve_runtime_fails_when_all_broken
printf '\nT3 missing entry preflight:\n';     test_inject_missing_entry
printf '\nT4 log dir creation:\n';            test_log_dir_created
printf '\nT5 vendored runtime fallback:\n';   test_inject_falls_back_when_vendored_missing

printf '\n%d passed, %d failed' "$PASS" "$FAIL"
if [ $FAIL -gt 0 ]; then
  printf '\nfailed tests:\n'
  for t in "${FAILED_TESTS[@]}"; do printf '  - %s\n' "$t"; done
  printf '\n'
  exit 1
fi
printf '\n\n'
exit 0
