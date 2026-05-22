# MCP Resilience — runbook for zeos MCP servers

zeos ships two MCP servers — **inject** (Node) and **overseer** (Python) — that every Claude Code session depends on. This document describes how they're hardened against runtime / dependency churn and what to do when something goes wrong.

External MCP servers (like `a control plane` at `/usr/local/bin/a control plane-mcp`) are not in scope; they're owned by other projects.

## Architecture

Both servers run on **vendored runtimes** that have zero Homebrew dependencies:

| Server   | Runtime                                            | Source                                    |
|----------|----------------------------------------------------|-------------------------------------------|
| inject   | `~/.local/zeos/node/bin/node` (Node 22.22.2)       | Official tarball from nodejs.org          |
| overseer | `infrastructure/overseer/.venv/bin/python` (3.12)  | uv-managed (python-build-standalone)      |

Each server is launched via a thin bash wrapper:

| Server   | Launcher                                       |
|----------|------------------------------------------------|
| inject   | `infrastructure/inject/bin/launch`             |
| overseer | `infrastructure/overseer/bin/launch`           |

The launcher resolves the runtime via a precedence chain (vendored → homebrew → PATH), runs preflight checks, logs to `~/Library/Logs/zeos-mcp/{component}.log`, then `exec`s the real server so signals propagate.

`~/.claude.json` `mcpServers` points at the launchers, not at `node` / `python` directly.

## When `/mcp` shows a server missing

**Step 1 — run the doctor:**

```bash
infrastructure/zeos-mcp-doctor
```

Output is a green/red table. If everything is green, the server *is* up and the issue is with Claude Code's MCP client (try restarting the session). If anything is red, read on.

**Step 2 — read the exit code:**

| Code | Meaning                         | Action                                                                   |
|------|---------------------------------|--------------------------------------------------------------------------|
| 0    | OK                              | nothing                                                                  |
| 64   | no usable runtime found         | reinstall the vendored runtime (see below)                               |
| 65   | runtime exists but won't execute| dyld / linker issue — check stderr; usually `brew reinstall <pkg>`       |
| 66   | entry file missing              | rebuild artifact: `cd infrastructure/inject && npm run build`            |
| 67   | required compiled artifact missing | same as 66                                                            |
| 68   | Python module not importable    | recreate venv: `cd infrastructure/overseer && uv pip install -e .[dev]`  |

The launcher prints the failure path and a one-line `fix:` hint to stderr — that's the first thing to check.

**Step 3 — read the log:**

```bash
tail -20 ~/Library/Logs/zeos-mcp/inject.log
tail -20 ~/Library/Logs/zeos-mcp/overseer.log
```

Each launch appends a structured line: `<timestamp> component=<name> event=<launch|preflight_*> runtime=<path> version=<x.y.z> entry=<path>`. Search for `runtime_skip` or `preflight_fail` events to see why a launch took the fallback path or failed entirely.

## Reinstalling the vendored Node

```bash
# verify SHA256
NODE_VER=22.22.2
curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/SHASUMS256.txt" | grep "darwin-arm64.tar.gz"
curl -fsSL -o "/tmp/node-v${NODE_VER}-darwin-arm64.tar.gz" \
  "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-darwin-arm64.tar.gz"
shasum -a 256 "/tmp/node-v${NODE_VER}-darwin-arm64.tar.gz"

# extract + symlink
mkdir -p ~/.local/zeos
tar -xzf "/tmp/node-v${NODE_VER}-darwin-arm64.tar.gz" -C ~/.local/zeos/
mv ~/.local/zeos/"node-v${NODE_VER}-darwin-arm64" ~/.local/zeos/"node-${NODE_VER}"
ln -snf "node-${NODE_VER}" ~/.local/zeos/node

# verify
~/.local/zeos/node/bin/node --version
infrastructure/zeos-mcp-doctor
```

## Recreating the overseer venv

```bash
cd infrastructure/overseer
rm -rf .venv
uv venv --python 3.12 .venv
uv pip install -e ".[dev]"
.venv/bin/python -c "import overseer.server; print('ok')"
infrastructure/../zeos-mcp-doctor
```

## Worked example — the simdutf incident (2026-04-29)

Homebrew bumped `simdutf` 8.2.0 → 9.0.0 overnight. The `node@22` binary at `/opt/homebrew/Cellar/node@22/22.22.2_1/bin/node` was linked against `libsimdutf.33.dylib` — SOVERSION 33, shipped by simdutf 8.x. simdutf 9.0.0 ships a different SOVERSION; the .33 dylib is gone. dyld fails before any JS executes:

```
dyld: Library not loaded: /opt/homebrew/opt/simdutf/lib/libsimdutf.33.dylib
Referenced from: /opt/homebrew/Cellar/node@22/22.22.2_1/bin/node
```

**Pre-hardening symptoms:** Claude Code session reports `mcp__zeos__*` "deferred tools no longer available". No actionable error. Operator has to manually launch the binary to discover the dyld message.

**Post-hardening behavior:** the launcher calls `node --version` against each candidate before exec'ing. The vendored Node at `~/.local/zeos/node/bin/node` exits 0 (it has no homebrew dependency) and is selected. If for some reason the vendored Node were missing too, the launcher would log `runtime_skip path=/opt/homebrew/opt/node@22/bin/node reason=execution_failed` to `~/Library/Logs/zeos-mcp/inject.log` with a clear stderr message, and either fall through to the system PATH `node` or exit 64 with a fatal-but-actionable error.

**Permanent fix delivered in this PR:** vendor the runtime so brew's transitive dep churn cannot reach the inject MCP. The same approach applies to overseer, which previously ran on Homebrew Python 3.14 and is now on uv-managed Python 3.12.

## Tests

```bash
bash infrastructure/tests/launcher.test.sh
```

Covers: happy-path, runtime resolution precedence, exit codes for each preflight failure, vendored→homebrew fallback, log directory creation. 14 cases, all should pass.

## What's not in this layer

- **a control plane telemetry on every launch** — local logs only for now. Add when there's a use case for fleet-wide MCP launch metrics.
- **Auto-rebuild dist on launch** — launchers are deterministic and fast. Stale build is a build problem; the doctor flags it; CI/precommit should prevent it from ever hitting main.
- **Brew post-upgrade hooks** — explicitly not needed because the runtime is vendored. brew can do whatever; the MCP servers don't care.
