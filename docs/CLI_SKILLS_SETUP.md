# CLI Skills Setup - zeos Slash Commands

**Created:** 2026-02-01
**Author:** The General (via OpenClaw)

This document describes how to configure `/zeos` and `/project` slash commands across Claude Code, Gemini CLI, and Codex CLI.

---

## Overview

All three CLIs now support the [Agent Skills](https://agentskills.io) open standard for custom slash commands. Skills are SKILL.md files that provide instructions the agent loads when the skill is invoked.

| CLI | Skills Location | Invocation | Discovery |
|-----|-----------------|------------|-----------|
| Claude Code | `~/.claude/skills/<name>/SKILL.md` | `/name` or auto | Auto-discovered |
| Gemini CLI | `~/.gemini/skills/<name>/SKILL.md` | `/name` or auto | `gemini skills list` |
| Codex CLI | `~/.codex/skills/<name>/SKILL.md` | `/name` or auto | Auto-discovered |

---

## Installed Skills

### `/zeos` - Boot zeos

Boots zeos operating system into Project mode.

**Triggers:** `/zeos`, `/zeos`, "boot zeos"

**What it does:**
1. Reads profile from `~/.zeos/profiles/operator/PROFILE.md`
2. Loads kernel files (SOUL.md, BOOT_PROTOCOL.md) based on `boot_mode`
3. Loads core modules (SHELL_PROTOCOL.md, PROFESSIONAL_STANDARD.md)
4. Outputs zeos splash screen with boot confirmation
5. Lists available projects from fleet table

### `/project <name>` - Load Project

Loads a specific project context and enables journaling.

**Triggers:** `/project <name>`, `/project <name>`

**What it does:**
1. Verifies zeos is booted
2. Looks up project in PROFILE.md fleet table
3. Loads project SOUL.md, STATE.md, and latest session journal
4. Creates journal stub for parallel instance detection
5. Loads active blueprint if set
6. Outputs project resume card

---

## Skill File Locations

```
~/.claude/skills/
├── zeos/
│   └── SKILL.md
└── project/
    └── SKILL.md

~/.gemini/skills/
├── zeos/
│   └── SKILL.md
└── project/
    └── SKILL.md

~/.codex/skills/
├── zeos/
│   └── SKILL.md
└── project/
    └── SKILL.md
```

---

## CLI-Specific Notes

### Claude Code

- Skills auto-load when their description matches user intent
- Use `disable-model-invocation: true` in frontmatter to require manual `/name` trigger
- Supports `allowed-tools` frontmatter to restrict tool access during skill execution
- Uses `$ARGUMENTS` placeholder for arguments

**Docs:** https://code.claude.com/docs/en/slash-commands

### Gemini CLI

- Run `gemini skills list --all` to see discovered skills
- Skills in `~/.gemini/skills/` are user-scoped (global)
- Skills in `.gemini/skills/` are workspace-scoped (project-local)
- Use `gemini skills enable/disable <name>` to toggle

**Docs:** Run `gemini skills --help`

### Codex CLI

- Skills in `~/.codex/skills/` are automatically discovered
- System skills live in `~/.codex/skills/.system/`
- Uses same SKILL.md format as Claude Code and Gemini CLI

**Docs:** Run `codex help`

---

## Creating New Skills

All three CLIs follow the same format:

```yaml
---
name: my-skill
description: What this skill does and when to use it
---

# Skill Instructions

Your markdown instructions here...
```

The `description` field is critical — it's what the AI uses to decide when to auto-load the skill.

---

## Prefix History

zeos originally used `/` prefix for commands but changed to `!` because:
- `/` collided with Claude UI (triggered extended thinking)
- `!` has no known platform collisions

With native CLI skills, both prefixes now work:
- `/zeos` → native skill invocation
- `/zeos` → recognized by skill description, auto-triggered

---

## Verification

```bash
# Claude Code
ls ~/.claude/skills/

# Gemini CLI  
gemini skills list --all

# Codex CLI
ls ~/.codex/skills/
```

---

## Inject MCP Server (Recommended)

For optimal performance, use the **Inject MCP server** instead of file-reading skills:

```bash
# Configure in ~/.claude/settings.json, ~/.gemini/settings.json, ~/.codex/config.toml
"inject": {
  "command": "node",
  "args": ["~/projects/inject/dist/index.js"]
}
```

**Tools provided:**
- `zeos_boot(profile)` — Returns compiled boot payload (1 call vs 5-6 file reads)
- `zeos_load_project(project, agent)` — Returns project context + creates journal stub
- `zeos_status()` — List available projects

**Repo:** `~/projects/inject/`
