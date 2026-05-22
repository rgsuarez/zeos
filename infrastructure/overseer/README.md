# Overseer: The Intelligent Shared Nervous System for AI Agents

> Multi-agent visibility — one pane of glass.

Overseer is a high-performance inter-agent relay infrastructure designed to break the isolation between AI agents (Claude Code, Gemini CLI, OpenAI Codex) running in separate terminal sessions. It transforms isolated processes into a **shared nervous system** capable of autonomous collaboration, progress signaling, and self-healing.

Built as a core component of **zeos** (Operating System for AI Collaboration), Overseer ensures that when one agent works, the entire fleet can observe, critique, and assist.

---

## ⚔️ Coordination Multiplier Evolution (v1.0)

Overseer has evolved beyond a simple message relay into an intelligent orchestration layer:

- **Shared Awareness**: Agents can observe each other's terminal output in real-time.
- **Progress Telemetry**: Workers post background heartbeats with progress percentages and terminal activity proof.
- **Frozen Detection**: The system autonomously detects when an agent is stuck in a loop or has crashed.
- **Resource Protection**: 30-second tool caching and reactive monitoring ensure 0% token waste.

---

## 🚀 Quick Start

### 1. Requirements
- Linux / macOS
- **tmux** (mandatory for terminal capture)
- Python 3.12+
- SQLite3

### 2. Installation
```bash
git clone https://github.com/my-org/my-repo
cd overseer
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### 3. Configure MCP for All CLIs

Overseer supports **Claude Code**, **Gemini CLI**, and **Codex CLI**. Each requires configuration in its global config file:

| CLI | Config File | Format |
|-----|-------------|--------|
| Claude Code | `~/.claude.json` (`mcpServers` key) | JSON |
| Gemini CLI | `~/.gemini/settings.json` | JSON |
| Codex CLI | `~/.codex/config.toml` | TOML |

**Quick setup (Claude Code):** use the `claude` CLI to merge the entry into `~/.claude.json` safely — do NOT overwrite the file directly (it contains other state):
```bash
claude mcp add -s user overseer \
  /path/to/overseer/.venv/bin/python -- -u -m overseer.server
```

**For complete configuration of all three CLIs, see [docs/INSTALLATION.md](docs/INSTALLATION.md).**

### 4. Verify
Restart your CLI session, then run `/mcp` to confirm overseer is listed.

---

## 🛠 Core Components

| Component | Path | Purpose |
|-----------|------|---------|
| **MCP Server** | `src/overseer/server.py` | Exposes 11 tools for agent collaboration. |
| **State Detector** | `src/overseer/detector.py` | Heuristics for IDLE/WORKING/STUCK states. |
| **Team Protocol** | `src/overseer/hive.py` | Director/Worker task orchestration logic. |
| **Relay DB** | `~/.overseer/relay.db` | Persistent SQLite message bus. |

---

## 📋 Documentation Library

- [**Installation Guide**](docs/INSTALLATION.md): Complete setup for Claude, Gemini, and Codex CLIs.
- [**Architecture Deep-Dive**](docs/ARCHITECTURE.md): How the transport and relay layers work.
- [**Team Protocol Specification**](docs/HIVE_PROTOCOL.md): Director/Worker lifecycle and Heartbeats.
- [**API Reference**](docs/API_REFERENCE.md): Detailed MCP tool definitions and examples.
- [**Communication Governance**](docs/GOVERNANCE.md): Mandatory rules for inter-agent behavior.
- [**Troubleshooting**](docs/TROUBLESHOOTING.md): Common fixes for MCP and tmux issues.
- [**Limitations & Future**](docs/LIMITATIONS_AND_FUTURE.md): What's next for the Overseer project.

---

## 🤝 Autonomous Collaboration
This project was co-engineered by **Gemini-2**, **Claude-2**, and **Codex-2**. All core features, documentation, and tests were produced through autonomous multi-agent coordination via the Overseer relay itself.

---

*Overseer v1.0.0 — "One operator. Infinite leverage."*