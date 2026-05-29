# CLAUDE.md

This file is the zeos repo's own operations doctrine — what an agent working inside this repo (extending zeos itself) needs to know.

For zeos *as a system you deploy*, see [README.md](./README.md).
For the protocol spec, see [ZEOS_PROTOCOL_SPEC_v1.md](./ZEOS_PROTOCOL_SPEC_v1.md).

## What is zeos?

zeos is an **operating system for AI collaboration** that runs IN context, not ON hardware. It implements persistence through file-system context externalization, making AI memory compound instead of reset.

**Core concept:** When an AI agent boots with zeos, it doesn't execute code — it **becomes** a zeos-governed agent. The kernel (SOUL.md, protocols) is injected into the agent's reasoning.

## Build and test commands

### Inject MCP server (the runtime)

```bash
cd infrastructure/inject
npm install
npm run build              # tsc compilation
```

Entry point: `src/index.ts` (monolithic). Powers `/zeos`, `/project`, `/newproject`, `/snap`, `/end`. Configured by `tools/install.sh` in `~/.claude.json` (and `~/.mcp.json` for compatibility).

### Overseer MCP server (multi-agent)

```bash
cd infrastructure/overseer
uv venv --python 3.12 .venv      # or: python3 -m venv .venv
uv pip install -e .              # or: ./.venv/bin/pip install -e .
./bin/launch --check             # preflight smoke test
```

Powers `/team` skill for tmux paired-lane patterns. Configured by `tools/install.sh`.

### MCP servers workspace (offline-first suite)

```bash
cd infrastructure/mcp-servers
pnpm install
pnpm build          # build all 6 packages
pnpm test           # vitest
```

Self-contained 6-package pnpm workspace. Optional; not wired into the default boot.

## Architecture

### Supremacy hierarchy

```
KERNEL (SOUL.md, BOOT_PROTOCOL.md)  — immutable law
    ↓ supersedes
MODULES (modules/constraints/*)      — binding constraints
    ↓ supersedes
PROFILE (profiles/<your-name>/)      — operator context
    ↓ supersedes
SESSION                              — ephemeral work
```

### Three-tier memory

| Tier | Source | Purpose |
|------|--------|---------|
| **Long-term** | Kernel SOUL + project SOUL + project CLAUDE.md | Identity. Rarely changes. |
| **Mid-term** | `~/.zeos/memory/<id>/MEMORY.md` | Curated, decay-tagged. Default 10K tokens. |
| **Short-term** | Latest 1–2 session journals | Recent decisions, in-flight work. |

### Boot modes

- **Lean** (default): load `kernel/lean/` (~6K tokens).
- **Full**: load full `kernel/` protocols (~35K tokens). Enable via `boot_mode: full` in PROFILE.md.

### Per-project state layout

| Artifact | Path |
|---|---|
| Project SOUL | `~/.zeos/souls/<app_id>/SOUL.md` (zeos, gitignored) |
| Session journals | `~/.zeos/journals/<app_id>/YYYY-MM-DD-NNN-<agent>.md` (zeos, gitignored) |
| MEMORY.md | `~/.zeos/memory/<app_id>/MEMORY.md` (zeos, gitignored) |
| Project CLAUDE.md | `<local_path>/CLAUDE.md` (project repo, scaffolded by `/newproject`) |
| Project registry | `~/.zeos/apps/REGISTRY.json` (zeos, committed) |

### Module structure

| Subdirectory | Purpose | Examples |
|--------------|---------|----------|
| `constraints/` | Binding governance rules | `ZEOS_MODULE_002_SHELL_PROTOCOL.md`, `ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md`, `ZEOS_MODULE_010_TEAM_PROTOCOL.md` |
| `protocols/` | Behavioral patterns | `MEMORY_ARCHITECTURE.md`, `NEW_PROJECT_PROTOCOL.md`, `TEAM_STRATEGY_PROTOCOL.md` |
| `behaviors/` | Onboarding and UX patterns | `ZEOS_MODULE_004_ONBOARDING.md` |

Modules use `ZEOS_MODULE_###_NAME.md` naming with required frontmatter (`module_id`, `module_type`, `version`, `status`, `load_priority`, `dependencies`). Constraints load automatically per `load_priority`.

### Multi-agent

zeos supports advisor/executor paired-lane patterns via the Overseer MCP server (`infrastructure/overseer/`). The `/team` skill manages session lifecycle. See `infrastructure/overseer/docs/` for the API and protocol.

## Conventions

### Session journals (when working on zeos itself)

Append-only logs at `~/.zeos/journals/zeos-dev/YYYY-MM-DD-NNN-<agent>.md`. Written by `/snap` and `/end` (when `/project zeos-dev` is active). Never rewrite past entries.

### Git workflow

- Branch naming: `feature/<description>` (e.g., `feature/inject-streaming`).
- Commit format: `type(scope): description` — types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`.
- Tags: semantic. Push to origin.

## Security

zeos never asks for or stores credentials. Boot payloads, journals, MEMORY.md, and the registry contain no secrets — credentials live in your OS keychain, environment variables, or a dedicated secret manager.

## Tech stack

| Component | Technology |
|-----------|------------|
| Inject MCP | Node.js 20+, TypeScript, `@modelcontextprotocol/sdk` |
| Overseer MCP | Python 3.12+, FastAPI, tmux backend |
| MCP servers suite | Node.js 20+, pnpm, TypeScript, vitest, tsup |
| `/newproject` | Python 3 (stdlib only) |
| Config | YAML frontmatter + Markdown |
