# zeos-mcp-launcher-lib.sh — shared preflight functions for inject + overseer launchers.
#
# Sourced by infrastructure/{inject,overseer}/bin/launch and infrastructure/zeos-mcp-doctor.
# Self-contained: no external deps, no globals leaked beyond ZEOS_MCP_* names.
#
# Exit code conventions (used by all launchers):
#   0   OK
#   64  preflight: no usable runtime found in any candidate
#   65  preflight: runtime exists but cannot execute (dyld / linker / permission)
#   66  preflight: entry file missing (build artifact not present)
#   67  preflight: required compiled artifact missing (e.g., dist/path-resolver.js)
#   68  preflight: dependency import test failed (Python module not importable)
#
# Codes 64-78 are reserved for sysexits.h-style preflight failures so a watchdog
# can distinguish "infra broken" from "process crashed at runtime" (which would
# produce SIGSEGV-class exit codes).

ZEOS_MCP_LOG_DIR="${HOME}/Library/Logs/zeos-mcp"

# zeos_mcp_log <component> <event> [k=v ...]
# Append a structured launch line. Never blocks startup if logging fails.
zeos_mcp_log() {
  local component="$1"; shift
  local event="$1"; shift
  local ts
  ts="$(date -u +%FT%TZ)"
  mkdir -p "$ZEOS_MCP_LOG_DIR" 2>/dev/null || return 0
  printf '%s component=%s event=%s' "$ts" "$component" "$event" >> "$ZEOS_MCP_LOG_DIR/${component}.log" 2>/dev/null || return 0
  for kv in "$@"; do
    printf ' %s' "$kv" >> "$ZEOS_MCP_LOG_DIR/${component}.log" 2>/dev/null || true
  done
  printf '\n' >> "$ZEOS_MCP_LOG_DIR/${component}.log" 2>/dev/null || true
}

# zeos_mcp_resolve_runtime <component> <candidate1> [candidate2 ...]
# Walk the candidate list in order; first one that exists AND exits 0 on
# `<candidate> --version` wins. Echoes the winning path. Returns 64 if none work.
# Stderr warnings are written when a candidate is skipped so operators can see
# why the launcher fell through.
zeos_mcp_resolve_runtime() {
  local component="$1"; shift
  local candidate
  for candidate in "$@"; do
    if [ -z "$candidate" ]; then continue; fi
    if [ ! -x "$candidate" ]; then
      zeos_mcp_log "$component" "runtime_skip" "path=$candidate" "reason=not_executable"
      continue
    fi
    if ! "$candidate" --version >/dev/null 2>&1; then
      printf 'zeos-mcp[%s]: runtime at %s exists but cannot execute (likely dyld/linker issue) — skipping\n' "$component" "$candidate" >&2
      zeos_mcp_log "$component" "runtime_skip" "path=$candidate" "reason=execution_failed"
      continue
    fi
    printf '%s' "$candidate"
    return 0
  done
  printf 'zeos-mcp[%s]: FATAL no usable runtime in any candidate — checked: %s\n' "$component" "$*" >&2
  zeos_mcp_log "$component" "runtime_resolve_failed" "candidates=$*"
  return 64
}

# zeos_mcp_require_file <component> <path> <hint>
# Fail with exit 66 if the file is missing. <hint> is shown to the operator.
zeos_mcp_require_file() {
  local component="$1"
  local path="$2"
  local hint="$3"
  if [ ! -f "$path" ]; then
    printf 'zeos-mcp[%s]: FATAL missing %s\n' "$component" "$path" >&2
    printf '  fix: %s\n' "$hint" >&2
    zeos_mcp_log "$component" "preflight_fail" "missing=$path"
    return 66
  fi
  return 0
}

# zeos_mcp_require_python_module <component> <python_bin> <module> <hint>
# Verify the module imports under the given Python. Exit 68 on failure.
zeos_mcp_require_python_module() {
  local component="$1"
  local python_bin="$2"
  local module="$3"
  local hint="$4"
  if ! "$python_bin" -c "import $module" >/dev/null 2>&1; then
    printf 'zeos-mcp[%s]: FATAL python module %s not importable under %s\n' "$component" "$module" "$python_bin" >&2
    printf '  fix: %s\n' "$hint" >&2
    zeos_mcp_log "$component" "preflight_fail" "module=$module"
    return 68
  fi
  return 0
}
