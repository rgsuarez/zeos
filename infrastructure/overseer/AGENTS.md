# Repository Guidelines

## Project Structure & Module Organization
- `src/overseer/` holds the Python package. Core modules include `server.py` (FastMCP tools), `detector.py` (state heuristics), `hive.py` (protocol types), and `agents/` (worker implementations).
- `tests/` contains the pytest suite (`test_*.py`).
- `docs/` contains architecture, install, governance, and troubleshooting references.
- `config.example.yaml` is a reference config; do not edit for local state.

## Build, Test, and Development Commands
- Create venv + install dev deps:
  - `python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"`
- Run the MCP server locally:
  - `.venv/bin/python -m overseer.server`
- Run full test suite:
  - `.venv/bin/python -m pytest -q` or `pytest tests/`
- Run faster subset (skip long polling tests):
  - `pytest tests/ -k "not subscribe_timeout and not subscribe_waits"`

## Coding Style & Naming Conventions
- Python 3.10+; 4-space indentation; follow existing PEP 8 style.
- Naming: `snake_case` for functions/vars, `CapWords` for classes, `UPPER_CASE` for constants.
- Prefer type hints and short docstrings for new public-facing tools and protocol types.
- No formatter configured; match local style and keep diffs minimal.

## Testing Guidelines
- Frameworks: `pytest` + `pytest-asyncio` (asyncio mode auto).
- Naming: files `test_*.py`, functions `test_*`.
- Keep tests deterministic; avoid tmux or live MCP dependencies in unit tests.

## Commit & Pull Request Guidelines
- Observed commit style: `type: short summary` (e.g., `docs: add installation guide`, `checkpoint: ...`).
- PRs should include: purpose, test command(s) run, doc updates (if any), and linked issues/EDB references.

## Security & Configuration Tips
- MCP config must use the full venv Python path, e.g. `"~/projects/overseer/.venv/bin/python" -m overseer.server`.
- Local relay data lives at `~/.overseer/relay.db`; never commit local state.

## Codex Compatibility (2026-05-04)

Overseer's MCP surface is dual-client (Claude Code TS client + Codex Rust
`rmcp` client). Codex is stricter about response envelopes; specific shape
contracts apply:

- `get_messages` / `subscribe` / `debug_get_messages` return a single
  `dict` envelope: `{"status":"ok","messages":[...],"count":N,"timed_out":<bool>}`.
  Never return a top-level `list[dict]` from a relay-fetch tool.
- All relay tools require a `requesting_agent` with a numeric team suffix
  (`codex-1`, `claude-3`, `bridge-0`). Set `OVERSEER_DEFAULT_TEAM_ID=N` in the
  environment to opt a bare codex shell into team `N` (requester-side only).
- `list_agents`, `send_to_agent`, `get_agent_output`, and `detect_state`
  enumerate `OVERSEER_TMUX_SOCKETS` (default `default,zeos-lanes`).
  Resolved entries store the socket they were found on, and subsequent
  send-keys / capture-pane calls inject `-L <socket>` automatically.

Active LOE: `LOE-zeos-overseer-codex-relay-compat`.

## N-Pair Intercom (2026-05-05)

For N simultaneous tmux pair intercoms with strict per-pair isolation, use
the `pair_registry` surface (LOE-zeos-overseer-npair-tmux-intercom):

- **Register before any pair-scoped relay traffic.** Call
  `register_pair(requesting_agent, pair_id, ...)` once per pair. Recommended
  `pair_id` = the tmux session name (`pair_eleet_brand`, etc.).
- **All pair tools require authentication.** Empty `requesting_agent` →
  denied. Bare `codex` / `claude` → denied unless `OVERSEER_DEFAULT_TEAM_ID`
  is set in the MCP-server env.
- **Numeric partition.** Auto-allocated team_ids are ≥ `OVERSEER_PAIR_TEAM_ID_BASE`
  (default `1000`). Explicit `team_id < BASE` is **always denied — including
  for `bridge-0`**. Legacy low-ID interop is a separate LOE.
- **team_id is immutable** on an existing `pair_id`. Idempotent re-registration
  updates participants and `last_activity` only.
- **Pair team_ids are durable, non-recycled reservations.** `unregister_pair`
  tombstones the row (`active=0`, `unregistered_at=NOW`) instead of deleting.
  The allocator skips every team_id with surviving state across `pair_registry`
  (active + tombstone), `messages`, `heartbeats`, `worker_cursors`,
  `pane_registry`, `audit_log`, and `agent_aliases`. Reactivation of a
  tombstoned `pair_id` is denied — out of scope for this LOE.
- **Bridge admin** is `requesting_agent="bridge-0"` with `OVERSEER_DEFAULT_TEAM_ID="0"`.
  Cross-pair `resolve_pair` / `list_pairs(include_others=True)` /
  `unregister_pair` require bridge.
- **Denial dicts never leak** `claude_session` / `codex_session` / `socket`.
- **Capability-complete ≠ fleet-complete.** This surface enables N-pair
  routing; it does NOT auto-retrofit currently running paired lanes. Live
  retrofit requires a separate lane launcher / operator-registration LOE.

LOE: `LOE-zeos-overseer-npair-tmux-intercom`.
