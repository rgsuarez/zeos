# zeos

> *Memory infrastructure for AI.*
>
> An operating system for AI collaboration. Persistent, compounding memory in context — not on hardware.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](./CHANGELOG.md)

---

## What zeos is

AI agents reset on every session. Knowledge evaporates. Decisions get re-explained. Context never compounds.

zeos is the protocol layer that fixes this:

```
Before zeos:
  You: "Continue where we left off."
  Agent: "I don't have memory of previous sessions."

With zeos:
  You: /project my-app
  Agent: "Continuing from Phase 1. Last session: API endpoints
          deployed (commit 8f3a2b1). Next: frontend integration.
          Open issue: schema mismatch in /api/v2/users."
```

Each project gets four artifacts:

- **`SOUL.md`** — identity (WHO the project is). Mission, constraints, values. Rarely changes.
- **`CLAUDE.md`** — operations doctrine (HOW the project runs). Build commands, conventions, key files.
- **`MEMORY.md`** — curated mid-term memory. Decay-tagged. Token-budgeted.
- **Session journals** — append-only logs from every working session.

When an agent boots into a project, it reconstructs the complete mental model from those four artifacts and resumes exactly where the last agent stopped.

**zeos runs IN context, not ON hardware.** It's not a server, not a framework, not an SDK. The kernel and protocols inject into the agent's reasoning at boot — the agent doesn't *execute* zeos, it *becomes* a zeos-governed agent.

---

## Install

```bash
curl -sL https://raw.githubusercontent.com/rgsuarez/zeos/main/tools/install.sh | bash
```

This clones zeos to `~/projects/zeos/`, prompts for your profile name, builds the inject MCP server, installs the Overseer MCP server (multi-agent), and installs six slash-commands into Claude Code. Idempotent — safe to re-run.

**Prereqs:** git, Node 18+, npm, Python 3.12+, tmux (Overseer's terminal capture). `uv` is optional but preferred for Python venv management.

**Pin to a tagged release:**

```bash
git clone --branch v1.0.0 --depth 1 https://github.com/rgsuarez/zeos.git ~/projects/zeos
bash ~/projects/zeos/tools/install.sh
```

**Update later:**

```bash
bash ~/projects/zeos/tools/install.sh --update
```

---

## Boot

In Claude Code, after install:

```
/newproject my-app \
  --type=internal \
  --repo=https://github.com/my-org/my-app
/project my-app
```

`/newproject` registers a project and scaffolds the four artifacts. `/project` loads them — and auto-boots the kernel + profile if they aren't already in context. You don't need to call `/zeos` first; reserve `/zeos` for the rare case where you want kernel-only context (e.g., to edit a profile or inspect governance).

`/snap` captures progress mid-session. `/end` closes with a final journal entry. Future sessions resume with full context.

---

## Commands

| Command | Purpose |
|---|---|
| `/zeos` | Boot kernel + profile + governance (usually called implicitly by `/project`) |
| `/project <id>` | Load a project: SOUL, CLAUDE.md, latest journals, MEMORY |
| `/newproject <id> [opts]` | Register + scaffold a new project (local-first; never pushes) |
| `/snap [note]` | Append a checkpoint to the current session journal |
| `/end` | Close the session: final journal entry + optional commit |
| `/team <subcommand>` | Multi-agent orchestration (Overseer MCP, tmux paired lanes) |

All six are installed as Claude Code skills at `~/.claude/skills/`.

### `/newproject` flags

```
--name=<name>         Human-readable project name
--repo=<url>          Remote URL (informational only — never fetches or pushes)
--type=<type>         internal | venture | research | infrastructure | utility
--local-path=<path>   Where the project lives locally (default: ~/projects/<id>/)
--no-scaffold         Skip all scaffold writes (registry-only mode)
--no-commit           Edit REGISTRY.json but don't commit to local zeos
--yes / -y            Skip the confirmation prompt
```

---

## Where state lives

Per-project state splits between the **zeos repo** (operator-only) and the **project repo** (one team-visible file).

| Artifact | Location | Repo |
|---|---|---|
| Project registry | `~/projects/zeos/apps/REGISTRY.json` | zeos (committed) |
| `SOUL.md` (identity — WHO) | `~/projects/zeos/souls/<id>/SOUL.md` | zeos (gitignored) |
| Session journals | `~/projects/zeos/journals/<id>/YYYY-MM-DD-NNN-<agent>.md` | zeos (gitignored) |
| `MEMORY.md` (curated mid-term) | `~/projects/zeos/memory/<id>/MEMORY.md` | zeos (gitignored) |
| `CLAUDE.md` (operations — HOW) | `<project>/CLAUDE.md` | Project repo (untracked by default; operator decides commit policy) |

`/newproject` writes all four scaffolded files. The three zeos-side files stay on the operator's machine — gitignored, never pushed anywhere unless explicitly synced. `CLAUDE.md` is the only file in the project repo — it's what teammates see if you commit it. The default template documents the zeos layout so any agent (or human) entering the project understands where state lives.

Project repos stay clean: no per-machine `.git/info/exclude` config required for operator state, no risk of leaking personal AI-pair dialogue into a teammate's PR.

### The SOUL / CLAUDE.md split

- **`SOUL.md`** — WHO the project is. Mission, constraints, identity, values. Rarely changes (quarterly at most). Loaded first at every boot.
- **`CLAUDE.md`** — HOW the project operates. Build commands, conventions, file paths, key references. Changes weekly.

Two files, two semantic loads, two change cadences. The doctrinal split is load-bearing — don't collapse them.

---

## Three-tier memory

zeos implements compounding memory through three layers.

| Tier | Source | Behavior |
|---|---|---|
| **Long-term** | Kernel `SOUL.md` + project `SOUL.md` + project `CLAUDE.md` | Always loaded. Defines identity. |
| **Mid-term** | `~/projects/zeos/memory/<id>/MEMORY.md` | Per-project, curated, decay-tagged. Default 10K token budget. |
| **Short-term** | Latest 1–2 session journals | Per-project, append-only. Recent decisions, in-flight work. |

`/project <id>` loads all three tiers in a single boot.

---

## Architecture

### Supremacy hierarchy

```
KERNEL (immutable law)
├── kernel/SOUL.md
├── kernel/BOOT_PROTOCOL.md
└── kernel/lean/                  ← fast-boot variants (~6K tokens)

   ▼ supersedes

MODULES (binding constraints)
├── modules/constraints/          ← shell protocol, continuity, professional bar
├── modules/protocols/            ← memory architecture, team strategy
└── modules/behaviors/            ← onboarding

   ▼ supersedes

PROFILE (operator preferences)
└── profiles/<your-name>/PROFILE.md

   ▼ supersedes

SESSION (ephemeral)
└── current conversation
```

Conflicts resolve by supremacy: **K > M > P > S.** A profile can be more restrictive than the kernel — never less.

### Boot modes

| Mode | Tokens | Default | When to use |
|---|---|---|---|
| **Lean** | ~6K | ✓ | Day-to-day work. Lazy-loads full protocols on demand. |
| **Full** | ~35K |  | Deep system debugging, governance edits. Set `boot_mode: full` in `PROFILE.md`. |

---

## Multi-agent paired lanes

For high-stakes work (architecture decisions, security-sensitive code, gnarly refactors), zeos ships the **advisor/executor pattern** as a first-class feature:

- **Pane 0.0:** Claude Code (executor) — runs implementation
- **Pane 0.1:** Codex / Gemini / Kimi (advisor) — independent review, second opinion
- **Shared worktree** — both panes operate on the same files
- **Overseer MCP** mediates inter-pane messaging

The advisor's role is to challenge, not rubber-stamp. The executor's role is to listen and incorporate. Setup lives in `infrastructure/overseer/`; the `/team` skill manages activation, status, and disband.

No off-the-shelf product does multi-AI orchestration in a shared editor context. zeos ships it as a first-class pattern.

---

## Profiles

Each operator gets a profile at `profiles/<your-name>/PROFILE.md`. Defines:

- **Boot mode** (`lean` or `full`)
- **Communication style** — tone, vocabulary
- **Active projects** — current phase, in-flight work
- **Technical context** — favored stacks, conventions

The installer creates yours by copying `profiles/template/` and prompting for name + optional callsign.

---

## Repository layout

```
zeos/
├── kernel/                       Core protocols (SOUL, BOOT_PROTOCOL, lean variants)
├── modules/                      Governance (constraints, protocols, commands, behaviors)
├── profiles/                     Operator profiles (template + yours)
├── apps/REGISTRY.json            Project registry
├── infrastructure/
│   ├── inject/                   Active MCP server (TypeScript)
│   ├── overseer/                 Multi-agent relay + tmux paired-lane runtime
│   ├── mcp-servers/              Offline-first MCP suite (6-package pnpm workspace)
│   └── skills/                   Slash-command skills installed to ~/.claude/skills/
├── tools/
│   ├── install.sh                Installer
│   └── newproject.py             /newproject backend
├── docs/                         Architecture, getting-started, protocol specs
├── souls/                        Per-project SOUL.md (gitignored)
├── journals/                     Per-project session journals (gitignored)
└── memory/                       Per-project MEMORY.md (gitignored)
```

---

## Inject MCP server

The `inject` MCP server compiles boot payloads efficiently — `/zeos`, `/project`, `/snap`, `/end` all route through it. Configured by the installer in `~/.claude.json` and `~/.mcp.json`:

```json
{
  "mcpServers": {
    "zeos": {
      "type": "stdio",
      "command": "/Users/you/projects/zeos/infrastructure/inject/bin/launch",
      "args": []
    },
    "overseer": {
      "type": "stdio",
      "command": "/Users/you/projects/zeos/infrastructure/overseer/bin/launch",
      "args": []
    }
  }
}
```

Tools exposed by inject: `zeos_boot`, `zeos_load_project`, `zeos_fleet`, `zeos_snap`, `zeos_end_session`, `zeos_help`, `zeos_parallel`, `zeos_memory_curate`.

Tools exposed by overseer: messaging, agent registration, team coordination (see `infrastructure/overseer/docs/API_REFERENCE.md`).

---

## What zeos is NOT

- Not a chatbot framework
- Not a prompt library
- Not an agent orchestration tool
- Not a workflow automation system
- Not software that "runs" in the traditional sense

The distinction matters. Competitors can build agent frameworks. zeos is a **protocol-level memory architecture** that travels with the agent and compounds across sessions, projects, and AI vendors.

---

## Documentation

| Doc | What it covers |
|---|---|
| [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) | 5-minute quickstart |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full technical architecture |
| [kernel/SOUL.md](kernel/SOUL.md) | zeos kernel identity |
| [kernel/BOOT_PROTOCOL.md](kernel/BOOT_PROTOCOL.md) | Boot sequence specification |
| [ZEOS_PROTOCOL_SPEC_v1.md](ZEOS_PROTOCOL_SPEC_v1.md) | Protocol-level specification |

---

## Security

zeos never asks for or stores credentials. Boot payloads, journals, `MEMORY.md`, and the registry contain no secrets — credentials live in your OS keychain, environment variables, or a dedicated secret manager. Session journals are operator notes, not credential stores.

`/newproject` writes a default `CLAUDE.md` into your project repo (operations doctrine). Inspect it before committing — it documents the zeos integration. Adjust as needed for your team's conventions.

---

## License

Apache 2.0. See [LICENSE](./LICENSE).

---

## Contributing

zeos is published as a portable starter. Fork it, customize, run your own deployment — that's the intended use. Issues and PRs welcome for protocol-level improvements that benefit everyone.

For substantial changes, open an issue first to discuss direction.

---

*zeos — memory infrastructure for AI.*
