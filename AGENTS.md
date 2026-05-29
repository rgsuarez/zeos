# Repository Guidelines

Contributor doctrine for working on **zeos itself** (not for projects that *use* zeos — those live elsewhere and follow their own `CLAUDE.md`).

## Project structure

- `kernel/` — immutable core: `SOUL.md`, `BOOT_PROTOCOL.md`, plus `lean/` fast-boot variants.
- `modules/` — governance docs by type: `constraints/` (binding), `protocols/` (patterns), `behaviors/` (onboarding/UX).
- `profiles/template/`: operator profile template. The installer copies it to `~/.zeos/profiles/<your-name>/` (operator profiles are state, not repo content).
- `~/.zeos/apps/REGISTRY.json`: project registry (operator state). Per-project SOUL / MEMORY / journals / roadmap live under `~/.zeos/{souls,memory,journals,roadmaps}/<app_id>/`, outside any repo.
- `infrastructure/inject/` — TypeScript MCP server (the runtime).
- `infrastructure/overseer/` — Python MCP server for multi-agent paired-lane patterns.
- `infrastructure/mcp-servers/` — offline-first MCP suite (pnpm workspace, optional).
- `infrastructure/skills/` — six slash-command skills installed to `~/.claude/skills/`.
- `tools/install.sh` — installer. `tools/newproject.py` — `/newproject` backend (Python stdlib only).
- `docs/` — architecture, getting-started, security checklist, MCP resilience.

## Build, test, dev

```bash
# Inject MCP (the runtime)
cd infrastructure/inject && npm install && npm run build

# Overseer MCP (multi-agent)
cd infrastructure/overseer && uv venv .venv && uv pip install -e .

# MCP servers suite (optional)
cd infrastructure/mcp-servers && pnpm install && pnpm build && pnpm test
```

## Coding style

- **TypeScript** (inject, MCP servers): tsc strict mode, no implicit any.
- **Python** (overseer, newproject.py): 4-space indent, type hints where load-bearing, stdlib-only for `tools/`.
- **Naming**: module docs follow `ZEOS_MODULE_###_NAME.md`. Skill dirs are lowercase (`zeos`, `project`, `newproject`, `snap`, `end`, `team`).
- **Journals** (for contributor work on zeos itself): `~/.zeos/journals/zeos-dev/YYYY-MM-DD-NNN-<agent>.md`, written automatically by `/snap` and `/end` when `/project zeos-dev` is active.

## Commits & PRs

- Commit format: `type(scope): summary` — `feat`, `fix`, `chore`, `refactor`, `docs`, `test`.
  Examples: `feat(newproject): add --soul flag`, `fix(installer): handle macOS sed quirk`.
- PRs: concise summary, protocol/doc references touched, rationale for non-obvious changes.
- UI/UX changes (rare — there's no UI in v1.0) require a visual artifact.

## Security & configuration

- No credentials in repo, journals, or MEMORY.md. See `docs/SECURITY_CHECKLIST.md`.
- Operator-specific settings go in `profiles/<your-name>/PROFILE.md` (in your local clone, never pushed publicly).

## Agent-specific

- Boot sequence and command vocabulary live in `kernel/BOOT_PROTOCOL.md` (full) and `kernel/lean/BOOT_PROTOCOL_LEAN.md` (default).
- Session journal format spec: `docs/SESSION_JOURNAL_FORMAT.md`.
- When in doubt about a doctrine question, the supremacy order is **kernel > modules > profile > session**.
