# Changelog

All notable changes to zeos are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-06-03

### Added: preferred single-narrative `handoff` field for `/end` and `/snap`

`zeos_end_session` and `zeos_snap` now accept a preferred `handoff` field: the
whole session handoff as one plain-text block. This replaces the need to split a
handoff across many structured parameters, which was prone to tool-grammar
corruption during emission. The field is listed first and is the recommended way
to call both tools.

Behavior:

- `handoff` wins when present (non-empty after trim). For `zeos_end_session` the
  blob is stored once as the Final Bridge, the Summary is a concise first line,
  and Next Actions is the blob's next-actions section or a short pointer (never a
  second copy of the blob). For `zeos_snap` the blob is the bridge content.
- All legacy structured fields remain accepted (now marked deprecated in their
  descriptions); when `handoff` is absent, behavior is byte-identical to before.
- `zeos_end_session`'s `required` is relaxed to `["project"]`; the runtime still
  rejects a call with no content.
- `handoff` is covered by the tool-grammar recovery sanitizer, so a leaked
  `<handoff>` envelope is stripped and recovered rather than persisted literally.

The inject MCP package version is bumped to 1.1.0 (tracked independently of this
1.3.0 repo release).

## [1.2.1] - 2026-05-31

### Fixed: leaked tool-grammar no longer loses a handoff

When an agent emitted its handoff with tool-grammar leaked into a string
parameter (for example, wrapping the whole payload as pseudo-XML inside
`summary`, or closing a parameter with a name-matching tag), `zeos_snap` and
`zeos_end_session` rejected the call and the handoff was lost. They now recover:
leaked tags are stripped losslessly (all other content preserved), any
still-missing required field is filled with an explicit `[ZEOS_RECONSTRUCTED]`
placeholder, the journal and MEMORY entry are marked as a recovered handoff and
tagged `recovered` at low importance, and a `ZEOS_TOOL_GRAMMAR_SANITIZED`
diagnostic line is logged. Empty inputs and unknown projects still reject.
Redaction still runs before any write. The rejection detector sensitivity is
unchanged; recovery is a separate, additive path. The inject MCP package
version is bumped to 1.0.1 (independent of this 1.2.1 repo release).

## [1.2.0] - 2026-05-29

### Storage contract: operator state relocated to `~/.zeos`

All operator-mutated state moves out of the repo tree into a machine-global
state root, `~/.zeos`, mirroring the `~/.claude` and `~/.codex` convention. The
repo becomes pure product, so the public mirror is byte-identical to any
operator's mirror and operator data can never be committed to a tracked file.

Two roots, both environment-overridable:

- `ZEOS_REPO_ROOT` (default `~/projects/zeos`): kernel, modules, infrastructure, tools, docs, `profiles/template/`, `apps/REGISTRY.example.json`.
- `ZEOS_STATE_ROOT` (default `~/.zeos`): `apps/REGISTRY.json`, `profiles/<operator>/`, `souls/`, `memory/`, `journals/`, `roadmaps/`.

The registry is no longer committed to the repo. The repo ships
`apps/REGISTRY.example.json` as the starter template; `/newproject` and the
installer write the live registry to `~/.zeos/apps/REGISTRY.json`.

### Master roadmap scaffold

`/newproject` now scaffolds a fifth artifact, `MASTER_ROADMAP.md`, at
`~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md`: the project's stable development
direction (desired end state, North Star, phases, current milestone, decision
log). `/project` surfaces it at boot between SOUL and memory when present. This
closes a protocol-vs-tool drift where `NEW_PROJECT_PROTOCOL.md` advertised a
master roadmap the tool never created.

### Migration

- New `tools/migrate-state.py` (Python stdlib only): copy-then-verify (SHA-256), idempotent, with `--dry-run`, `--apply`, `--backup`, `--cleanup-repo-state`, `--registry-source`, and `--repo-root` / `--state-root` overrides. Refuses to run if the state root is inside the repo root.
- `tools/install.sh` snapshots and relocates state on update (pre-pull backup when the tool is present, post-pull migration that ingests the registry from the backup).
- `tools/uninstall.sh` no longer removes operator state by default; pass `--purge-state` to delete `~/.zeos`.
- Safe-update instructions, including the one-time manual path for the v1.1.0 jump, are in [docs/UPGRADING_TO_V1_2_0.md](docs/UPGRADING_TO_V1_2_0.md).

### Fixed

- Full boot read a non-existent `modules/constraints/SHELL_PROTOCOL.md`; it now reads the real `modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md`, and that file's state-path references are reconciled to `~/.zeos`.

### Compatibility

The inject MCP server reads state-first with a one-release fallback to the old
in-repo locations and a deprecation notice; writes always go to `~/.zeos`. The
slash-command surface and the boot/journaling API are unchanged. Existing
installs are migrated automatically by `install.sh --update`. The legacy
fallback is removed in v1.3.0.

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
