# zeos PreCompact auto-snap hook: sourceable helpers.
#
# This file is SOURCED by precompact-snap.sh so the risky logic (Node-floor
# selection and durable logging) is unit-testable in isolation. It defines ONLY
# the two functions below and deliberately sets NO shell options; in particular
# it never runs `set -e`, so a function-internal failure can never abort the
# sourcing hook (whose absolute invariant is "never block compaction"). It ends
# with `:` so a successful `source` returns 0.
#
# Not executable, has no shebang: it is an internal `source` unit, not a command.

# select_supported_node FLOOR CAND...
#
# Echo the FIRST candidate that is an executable Node whose major version is
# >= FLOOR, and return 0. Return 1 (echo nothing) when none qualify.
#
# The regex gate precedes the arithmetic so an empty or garbage `--version`
# (a non-Node executable, a broken binary) can never trip `set -u` or an
# arithmetic error in the sourcing hook; it simply fails the match and is
# skipped. bash-only constructs ([[ =~ ]], BASH_REMATCH, (( ))) are safe: the
# hook runs under `#!/usr/bin/env bash`.
select_supported_node() {
  local floor="$1"; shift
  local cand ver major
  for cand in "$@"; do
    [ -n "$cand" ] || continue
    [ -x "$cand" ] || continue
    ver="$("$cand" --version 2>/dev/null || true)"
    # Pinned-major parse first; a non-matching/empty version is skipped, not fatal.
    [[ "$ver" =~ ^v?([0-9]+)\. ]] || continue
    major="${BASH_REMATCH[1]}"
    (( major >= floor )) || continue
    printf '%s\n' "$cand"
    return 0
  done
  return 1
}

# precompact_log LINE
#
# Append one timestamped, single-line record to
# $ZEOS_STATE_ROOT/logs/precompact-snap.log (default ~/.zeos/logs/...), rotating
# the log once it exceeds 256 KiB. EVERY write is guarded; the function returns 0
# on any failure so logging can never block the hook. Used for actionable
# auto-capture failures and infra-skips only; recognized quiet outcomes
# (empty session, no-op, wrote checkpoint) are intentionally never logged.
precompact_log() {
  local line="$1"
  local state_root log msg sz
  state_root="${ZEOS_STATE_ROOT:-${HOME:-}/.zeos}"
  # Expand a leading "~/" the way the Node resolver does (path-resolver.ts
  # expandPath) WHEN HOME is set: an operator (or test) ZEOS_STATE_ROOT='~/foo'
  # must land under $HOME/foo, NOT a literal "~" directory. (With HOME unset the
  # two intentionally diverge: Node falls back to the passwd home, while this
  # degrades to a no-op below.) This expansion is deliberate; do NOT "simplify" it
  # to a literal "~".
  case "$state_root" in
    "~/"*)
      # A tilde root needs HOME to anchor; with HOME unset/empty there is no safe
      # target, so degrade to a no-op rather than resolve to a root-level "/foo".
      [ -n "${HOME:-}" ] || return 0
      state_root="${HOME}${state_root#\~}"
      ;;
  esac
  # Degrade quietly (never block) when no real, HOME-anchored root can be formed:
  # an empty root, or a bare "/.zeos" (HOME unset AND no override) must not write.
  [ -n "$state_root" ] || return 0
  [ "$state_root" = "/.zeos" ] && return 0
  log="$state_root/logs/precompact-snap.log"
  mkdir -p "$(dirname "$log")" 2>/dev/null || return 0
  # Rotate-before-append so the log cannot grow without bound. Guard on existence,
  # and order `2>/dev/null` BEFORE `<"$log"` so that even if the log is removed
  # between the guard and the open, the "cannot open" message is routed to
  # /dev/null: an input-redirect failure is reported to fd 2 as it already stands,
  # so the stderr redirect must precede the input redirect. `tr` strips any
  # platform `wc` padding so the integer test can never error.
  if [ -f "$log" ]; then
    sz="$(wc -c 2>/dev/null <"$log" | tr -d '[:space:]')"
    [ "${sz:-0}" -gt 262144 ] && mv "$log" "$log.1" 2>/dev/null
  fi
  # Normalize to a single physical line so one record == one event. Wrap the
  # append in a group with ONE stderr redirect so a late open failure (e.g. the
  # dir vanished mid-call) is suppressed regardless of redirect ordering; the
  # `|| true` keeps the function returning 0 (never block).
  msg="$(printf '%s' "$line" | tr '\n' ' ')"
  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" "$msg" >>"$log"; } 2>/dev/null || true
}

: # successful source returns 0
