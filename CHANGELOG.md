# Changelog

All notable changes to zeos are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-21

### Initial public release

zeos goes public as a portable operating system for AI collaboration. Persistent, compounding memory in context — not on hardware.

### Core capabilities

- **Boot protocol** — `/zeos` loads kernel, profile, and governance protocols into the agent's context.
- **Project identity** — `/project <id>` auto-boots the kernel (if not loaded) and pulls the project's SOUL, CLAUDE.md, latest journals, and MEMORY.md so a fresh agent picks up exactly where the last one stopped.
- **`/newproject`** — local-first registrar and scaffolder. Registers a new project in `apps/REGISTRY.json` and writes four artifacts: `SOUL.md` (identity, zeos-side), `MEMORY.md` (mid-term memory, zeos-side), `journals/README.md` (zeos-side), and `CLAUDE.md` (operations doctrine, project repo). Never auto-pushes or creates remote repos.
- **Session journals** — `/snap` (mid-session) and `/end` (close) append to `~/projects/zeos/journals/<id>/YYYY-MM-DD-NNN-<agent>.md`.
- **Three-tier memory model** — long-term (SOUL + CLAUDE.md), mid-term (MEMORY.md), short-term (recent journals). Designed for compounding context.
- **Multi-agent orchestration** — Overseer MCP enables advisor/executor paired-lane patterns (tmux + cross-pane messaging) for high-stakes work. Wired by the installer; `/team` skill manages activation.
- **Skills** — `/zeos`, `/project`, `/newproject`, `/snap`, `/end`, `/team` — installed via `tools/install.sh`.
- **Generic profile template** — `profiles/template/` for operator customization.

### SOUL / CLAUDE.md doctrine

zeos enforces a deliberate split between project identity and project operations:

- **`SOUL.md`** = WHO the project is (mission, constraints, values). Lives at `~/projects/zeos/souls/<id>/SOUL.md`, gitignored in zeos. Rarely changes.
- **`CLAUDE.md`** = HOW the project operates (build commands, conventions). Lives at `<project>/CLAUDE.md`, in the project repo. Changes weekly.

Two files, two semantic loads, two change cadences.

### State layout

| Artifact | Location | Where |
|---|---|---|
| Registry | `~/projects/zeos/apps/REGISTRY.json` | zeos (committed) |
| Project SOUL | `~/projects/zeos/souls/<id>/SOUL.md` | zeos (gitignored) |
| Session journals | `~/projects/zeos/journals/<id>/` | zeos (gitignored) |
| Mid-term memory | `~/projects/zeos/memory/<id>/MEMORY.md` | zeos (gitignored) |
| Operations doctrine | `<project>/CLAUDE.md` | Project repo |

Project repos stay 100% clean — no per-machine `.git/info/exclude` config required for operator-side state.

### Components

- `kernel/` — immutable boot protocol and SOUL doctrine, with `lean/` variants for fast boot
- `modules/` — governance modules (constraints, protocols, commands, behaviors)
- `infrastructure/inject/` — active TypeScript MCP server powering boot and journaling
- `infrastructure/overseer/` — multi-agent relay and tmux paired-lane runtime (Python)
- `infrastructure/mcp-servers/` — offline-first MCP suite (6-package pnpm workspace)
- `infrastructure/skills/` — six slash-command skills
- `tools/install.sh` — installer
- `tools/newproject.py` — `/newproject` backend

### License

Apache 2.0. See [LICENSE](./LICENSE).
