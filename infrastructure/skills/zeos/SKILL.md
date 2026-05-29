---
name: zeos
description: Boot zeos — load kernel, profile, and governance protocols into the session
argument-hint: [profile]
allowed-tools: Read, Glob, Bash, mcp__zeos__zeos_boot
---

# /zeos

Boot zeos into the current Claude Code session. Usually called implicitly by `/project <id>`; invoke explicitly only when you want kernel + profile context without entering a specific project (e.g., to edit a profile or inspect governance).

## Preferred: zeos MCP

If the `zeos` MCP server is available (installed by `tools/install.sh`), use it for efficient single-call boot:

```
mcp__zeos__zeos_boot({ profile: "<profile-name>" })
```

This returns the compiled boot payload in one call instead of reading multiple files.

## Fallback: manual file reading

If the MCP server is unavailable, read these files manually in order:

1. **Load profile.** Read `~/.zeos/profiles/${ARGUMENTS:-<your-profile>}/PROFILE.md` (falls back to `~/projects/zeos/profiles/template/PROFILE.md` if absent). Extract `boot_mode` from frontmatter (default: `lean`).
2. **Load kernel** (lean by default):
   - Lean: `~/projects/zeos/kernel/lean/SOUL_CORE.md`, `~/projects/zeos/kernel/lean/BOOT_PROTOCOL_LEAN.md`
   - Full (only if `boot_mode: full`): `~/projects/zeos/kernel/SOUL.md`, `~/projects/zeos/kernel/BOOT_PROTOCOL.md`
3. **Load core modules:**
   - Lean: `~/projects/zeos/kernel/lean/SHELL_PROTOCOL_LEAN.md`, `~/projects/zeos/kernel/lean/CONTINUITY_PROTOCOL_LEAN.md`
   - Full: `~/projects/zeos/modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md`, `~/projects/zeos/modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md`
4. **Output boot confirmation** with profile name and boot mode.

## Post-boot

After boot, zeos governance is active. Available commands:

| Command | Purpose |
|---|---|
| `/project <id>` | Load a project (SOUL + CLAUDE.md + journals + MEMORY) |
| `/newproject <id> ...` | Register and scaffold a new project |
| `/snap [note]` | Append a checkpoint to the current session journal |
| `/end` | Close the session and write the final journal entry |
| `/team <subcommand>` | Multi-agent orchestration via Overseer MCP (optional) |

## Arguments

- `$ARGUMENTS`: optional profile name. Default is the first directory under `~/.zeos/profiles/`.
- Example: `/zeos my-profile` loads the `my-profile` profile.
