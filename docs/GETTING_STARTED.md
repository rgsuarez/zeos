---
document: "GETTING_STARTED"
version: "1.0.0"
updated: "2026-02-02"
---

# Getting Started with zeos

> **Memory infrastructure for AI.**

This guide will get you up and running with zeos in 5 minutes.

---

## What is zeos?

zeos is an operating system for AI collaboration. It gives AI agents:
- **Memory** — Context persists across sessions
- **Governance** — Consistent behavior and constraints
- **Continuity** — Pick up where you left off

When you boot zeos, your AI assistant remembers what you're working on.

---

## Prerequisites

- **Git** — For cloning repositories
- **Node.js 18+** — For the MCP server
- **Claude Code** — Or compatible AI assistant with MCP support

---

## Installation

### Option 1: One-Line Install

```bash
curl -sL https://raw.githubusercontent.com/rgsuarez/zeos/main/tools/install.sh | bash
```

This will:
1. Clone zeos to `~/projects/zeos/`
2. Prompt for your profile name
3. Build the Inject MCP server
4. Configure Claude Code

### Option 2: Manual Install

```bash
# 1. Clone zeos
git clone https://github.com/rgsuarez/zeos.git ~/projects/zeos

# 2. Create your profile (operator state lives under ~/.zeos)
mkdir -p ~/.zeos/profiles
cp -r ~/projects/zeos/profiles/template ~/.zeos/profiles/yourname
# Edit ~/.zeos/profiles/yourname/PROFILE.md

# 3. Build the MCP server
cd ~/projects/zeos/infrastructure/inject
npm install
npm run build

# 4. Configure Claude Code
# Add to ~/.claude/settings.json:
```

```json
{
  "mcpServers": {
    "inject": {
      "command": "node",
      "args": ["/Users/yourname/projects/zeos/infrastructure/inject/dist/index.js"]
    }
  }
}
```

---

## Your First Boot

1. Open Claude Code in any directory

2. Type:
   ```
   /zeos
   ```

3. You'll see:
   ```
   ═══════════════════════════════════════════════════════════════

       ███████ ████████  ███████  ██████
          ███  ██       ██    ██ ██
         ███   ██████   ██    ██  █████
        ███    ██       ██    ██      ██
       ███████ ████████  ███████  ██████

       Operating System for AI Collaboration
       Persistence Protocol Active

       Profile: yourname
       Boot Mode: LEAN (default)

   ═══════════════════════════════════════════════════════════════
   ```

4. zeos is now active. Use `/help` to see available commands.

---

## Loading a Project

After booting zeos, load a project to get full context:

```
/project your-project-name
```

This loads:
- Project SOUL (identity and purpose)
- MEMORY.md (long-term memory)
- Recent session summaries
- Latest session journal
- Active blueprint (if any)

---

## Saving Progress

### Checkpoint

Save your work at any point:

```
/snap
```

This appends to your session journal with:
- Files changed
- Decisions made
- Commands executed
- Artifacts produced

### End Session

When you're done:

```
/end
```

This:
1. Marks your journal as complete
2. Adds summary to MEMORY.md
3. Creates handoff for next session

---

## Core Commands

| Command | Purpose |
|---------|---------|
| `/zeos` | Boot zeos |
| `/project <name>` | Load project context |
| `/snap` | Save progress |
| `/end` | End session |
| `/fleet` | View all projects |
| `/help` | Show help |

---

## Customizing Your Profile

Edit `~/.zeos/profiles/yourname/PROFILE.md`:

```yaml
---
profile_id: "yourname"
operator: "Your Name"
callsign: "Your Callsign"
status: "ACTIVE"
boot_mode: lean  # or "full" for verbose boot
---

# Operator Profile: Your Name

## Identity
...

## Communication Style
...

## Technical Context
...

## Constraints
...

## Continuity Mode
continuity:
  mode: STANDARD  # OFF | LIGHT | STANDARD | HEAVY
```

---

## Adding a Project

Use `/newproject` (or `tools/newproject.py`). It registers the project in
`~/.zeos/apps/REGISTRY.json` and scaffolds all five artifacts; you never
hand-edit the registry.

```bash
python3 ~/projects/zeos/tools/newproject.py my-project \
  --type=venture \
  --repo=https://github.com/your-org/my-project
```

This writes:

- `~/.zeos/souls/my-project/SOUL.md` (identity)
- `~/.zeos/memory/my-project/MEMORY.md` (curated memory)
- `~/.zeos/journals/my-project/README.md` (journals dir)
- `~/.zeos/roadmaps/my-project/MASTER_ROADMAP.md` (development direction)
- `<local_path>/CLAUDE.md` (operations doctrine, in the project repo)

and appends the registry entry. Edit any scaffolded file afterward; re-running
`/newproject` never overwrites an existing file. Then boot it:

```bash
/project my-project
```

---

## How Memory Works

zeos implements three-tier memory:

### Tier 1: Long-Term (MEMORY.md)

Accumulated wisdom from all sessions. Updated on `/end`.

### Tier 2: Mid-Term (Recent Sessions)

Last 3 session summaries. Gives recent context.

### Tier 3: Short-Term (Current Journal)

Full detail of current session. Updated on `/snap`.

When you boot a project, all three tiers load automatically.

---

## Troubleshooting

### MCP not connecting

Check `~/.claude/settings.json` has the correct path:

```json
{
  "mcpServers": {
    "inject": {
      "command": "node",
      "args": ["/full/path/to/zeos/infrastructure/inject/dist/index.js"]
    }
  }
}
```

### Project not found

Verify the project is in `~/.zeos/apps/REGISTRY.json`.

### Journal not created

Ensure `~/.zeos/journals/<app_id>/` exists (it is scaffolded by `/newproject`).

---

## Next Steps

1. **Customize your profile** — Edit PROFILE.md with your preferences
2. **Add your projects**: register with `/newproject` (writes `~/.zeos/apps/REGISTRY.json`)
3. **Use checkpoints** — Save progress frequently with `/snap`
4. **End sessions properly** — Use `/end` to update long-term memory

---

## Resources

- **Architecture**: `docs/ARCHITECTURE.md`
- **Registry Schema**: `~/.zeos/apps/REGISTRY.json`
- **Profile Template**: `profiles/template/PROFILE.md`
- **Kernel Docs**: `kernel/SOUL.md`, `kernel/BOOT_PROTOCOL.md`

---

*Welcome to zeos. Memory infrastructure for AI.*
