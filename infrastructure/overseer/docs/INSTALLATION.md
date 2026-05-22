# Overseer Installation Guide

Complete installation and configuration for Claude Code, Gemini CLI, and Codex CLI.

---

## Prerequisites

| Requirement | Version | Check Command |
|-------------|---------|---------------|
| Python | 3.12+ | `python3 --version` |
| tmux | 3.0+ | `tmux -V` |
| SQLite | 3.x | `sqlite3 --version` |
| Git | 2.x | `git --version` |

---

## Step 1: Clone and Install

```bash
# Clone repository
git clone https://github.com/my-org/my-repo
cd overseer

# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install in development mode
pip install -e ".[dev]"

# Verify installation
python -c "from overseer.server import mcp; print('Overseer OK')"
```

---

## Step 2: Configure MCP Servers (Global)

Overseer must be configured in each CLI's global configuration file. This enables the MCP tools across all projects on the machine.

### Claude Code (`~/.claude.json`)

Claude Code reads user-scope MCP servers from `~/.claude.json` under the top-level `mcpServers` key. **Do not overwrite this file** — it contains project state, settings, and history. Use the `claude` CLI to merge the entry safely:

```bash
claude mcp add -s user overseer \
  /path/to/overseer/.venv/bin/python -- -u -m overseer.server
```

If you must edit by hand, use `jq` to merge:

```bash
jq '.mcpServers.overseer = {
  "type": "stdio",
  "command": "/path/to/overseer/.venv/bin/python",
  "args": ["-u", "-m", "overseer.server"]
}' ~/.claude.json > /tmp/claude.json && mv /tmp/claude.json ~/.claude.json
```

> ⚠️ **Note:** `~/.mcp.json` (top-level home directory) is **not** a Claude Code config location and will be silently ignored. Only `~/.claude.json` (user scope) and `.mcp.json` in a project root (project scope) are read.

**Verification:** Restart Claude Code session, then run `/mcp` to see overseer listed.

---

### Gemini CLI (`~/.gemini/settings.json`)

If the file exists, add the `overseer` entry to the existing `mcpServers` object:

```bash
# Check if file exists
cat ~/.gemini/settings.json

# If mcpServers section exists, add overseer manually or use jq:
jq '.mcpServers.overseer = {
  "command": "~/projects/overseer/.venv/bin/python",
  "args": ["-m", "overseer.server"]
}' ~/.gemini/settings.json > /tmp/settings.json && mv /tmp/settings.json ~/.gemini/settings.json
```

If creating from scratch:

```bash
mkdir -p ~/.gemini
cat > ~/.gemini/settings.json << 'EOF'
{
  "mcpServers": {
    "overseer": {
      "command": "~/projects/overseer/.venv/bin/python",
      "args": ["-m", "overseer.server"]
    }
  }
}
EOF
```

**Verification:** Restart Gemini CLI session, then run `/mcp` to see overseer listed.

---

### Codex CLI (`~/.codex/config.toml`)

Codex uses TOML format. Add the following to `~/.codex/config.toml`:

```bash
cat >> ~/.codex/config.toml << 'EOF'

[mcp_servers.overseer]
command = "~/projects/overseer/.venv/bin/python"
args = ["-m", "overseer.server"]
EOF
```

**Full example config.toml:**

```toml
model = "gpt-5.2-codex"
approval_policy = "never"

[mcp_servers.overseer]
command = "~/projects/overseer/.venv/bin/python"
args = ["-m", "overseer.server"]
```

**Verification:** Restart Codex CLI session, then run `/mcp` to see overseer listed.

---

## Step 3: Create tmux Sessions

Overseer captures terminal output via tmux. Create named sessions for each agent:

```bash
# Claude agents
tmux new-session -d -s claude-1
tmux new-session -d -s claude-2
tmux new-session -d -s claude-3

# Gemini agents
tmux new-session -d -s gemini-1
tmux new-session -d -s gemini-2
tmux new-session -d -s gemini-3

# Codex agents
tmux new-session -d -s codex-1
tmux new-session -d -s codex-2
tmux new-session -d -s codex-3
```

**Naming Convention:**
- Session name format: `{agent_type}-{number}`
- Agent types: `claude`, `gemini`, `codex`
- State detection uses the prefix to apply correct heuristics

---

## Step 4: Verify Installation

### Test MCP Server Directly

```bash
# Should start without errors (Ctrl+C to stop)
~/projects/overseer/.venv/bin/python -m overseer.server
```

### Test from Agent Session

From any configured agent, run:

```
# List all tmux sessions
mcp__overseer__list_agents

# Should return: claude-1, claude-2, gemini-1, etc.
```

### Test Relay

```bash
# Check relay database exists
ls -la ~/.overseer/relay.db

# Check message count
sqlite3 ~/.overseer/relay.db "SELECT count(*) FROM messages;"
```

---

## Configuration Summary

| CLI | Config File | Format |
|-----|-------------|--------|
| Claude Code | `~/.claude.json` (`mcpServers` key) | JSON |
| Gemini CLI | `~/.gemini/settings.json` | JSON |
| Codex CLI | `~/.codex/config.toml` | TOML |

**Critical:** All configurations use the **full path** to the venv Python interpreter:
```
~/projects/overseer/.venv/bin/python
```

Do NOT use `python` or `python3` — these may not resolve correctly when spawned by the CLI.

---

## Project-Level Configuration (Optional)

For project-specific MCP configs, create `.mcp.json` in the project root:

```bash
# Claude Code reads .mcp.json from project directory
cat > /path/to/project/.mcp.json << 'EOF'
{
  "mcpServers": {
    "overseer": {
      "command": "~/projects/overseer/.venv/bin/python",
      "args": ["-m", "overseer.server"]
    }
  }
}
EOF
```

**Note:** Project-level config is additive to global config for Claude Code. Gemini and Codex only read global configs.

---

## Troubleshooting

### "overseer not showing in /mcp"

1. Verify config file syntax (JSON/TOML must be valid)
2. Restart CLI session — MCP config is read at startup
3. Check file permissions: `ls -la ~/.claude.json` (Claude), `ls -la ~/.gemini/settings.json` (Gemini)
4. Confirm the entry actually landed under the right key: `jq '.mcpServers | keys' ~/.claude.json`

### "python: command not found"

Use full path to venv Python:
```
~/projects/overseer/.venv/bin/python
```

### "ModuleNotFoundError: overseer"

Install in development mode:
```bash
cd ~/projects/overseer
.venv/bin/pip install -e ".[dev]"
```

### "Not connected to MCP server"

1. Test server manually:
   ```bash
   ~/projects/overseer/.venv/bin/python -m overseer.server
   ```
2. Check for zombie processes: `pkill -f overseer`
3. Restart CLI session

---

## Quick Reference

```bash
# Install
git clone https://github.com/my-org/my-repo && cd overseer
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"

# Configure Claude Code (merges into ~/.claude.json, safe)
claude mcp add -s user overseer \
  ~/projects/overseer/.venv/bin/python -- -u -m overseer.server

# Configure Gemini (add to existing)
# Edit ~/.gemini/settings.json, add overseer to mcpServers

# Configure Codex (append)
echo -e '\n[mcp_servers.overseer]\ncommand = "~/projects/overseer/.venv/bin/python"\nargs = ["-m", "overseer.server"]' >> ~/.codex/config.toml

# Verify
# Restart each CLI, run /mcp, confirm overseer is listed
```

---

*Installation Guide v1.0 — Overseer Multi-Agent Relay*
