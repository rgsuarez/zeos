#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# zeos IS RETIRED (2026-07-26). This installer is permanently disabled.
# ══════════════════════════════════════════════════════════════════
echo "zeos was retired and unwired on 2026-07-26. This installer is disabled."
echo "See RETIRED.md at the repo root for what replaced each function:"
echo "  context continuity -> compact-net; session closure -> /closeout;"
echo "  coordination -> the lane binary (~/.cargo/bin/lane); orchestration -> FlagDeck."
echo "The ~/.zeos state tree remains readable in place until the consolidation"
echo "campaign migrates it. Do not re-run this installer."
exit 1

# ═══════════════════════════════════════════════════════════════
# zeos Installer
# ═══════════════════════════════════════════════════════════════
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/rgsuarez/zeos/main/tools/install.sh | bash
#
# Or locally:
#   bash ~/projects/zeos/tools/install.sh
#
# Update mode (refresh skills and MCP config):
#   bash ~/projects/zeos/tools/install.sh --update
#
# ═══════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ═══════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════

ZEOS_REPO="https://github.com/rgsuarez/zeos.git"
ZEOS_DIR="$HOME/projects/zeos"
CLAUDE_DIR="$HOME/.claude"
MCP_FILE="$HOME/.mcp.json"     # legacy; installer also writes to ~/.claude.json
CLAUDE_JSON_FILE="$HOME/.claude.json"  # Claude Code canonical user-scope MCP config
UPDATE_MODE=false

# Check for --update flag
if [ "$1" == "--update" ]; then
    UPDATE_MODE=true
fi

echo -e "${BLUE}"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "    ███████ ████████  ███████  ██████"
echo "       ███  ██       ██    ██ ██"
echo "      ███   ██████   ██    ██  █████"
echo "     ███    ██       ██    ██      ██"
echo "    ███████ ████████  ███████  ██████"
echo ""
echo "    Operating System for AI Collaboration"
if [ "$UPDATE_MODE" = true ]; then
    echo "    Update Mode v1.0.0"
else
    echo "    Installer v1.0.0"
fi
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo -e "${NC}"

# ═══════════════════════════════════════════════════════════════
# Prerequisites Check
# ═══════════════════════════════════════════════════════════════

echo -e "${YELLOW}Checking prerequisites...${NC}"

# Check for git
if ! command -v git &> /dev/null; then
    echo -e "${RED}Error: git is required. Install git first.${NC}"
    exit 1
fi

# Check for node
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is required. Install Node.js 18+ first.${NC}"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Error: Node.js 18+ required. Current version: $(node -v)${NC}"
    exit 1
fi

# Get full node path for MCP config
NODE_PATH=$(which node)

echo -e "${GREEN}✓ Prerequisites satisfied${NC}"

# ═══════════════════════════════════════════════════════════════
# Clone or Update zeos
# ═══════════════════════════════════════════════════════════════

echo ""
echo -e "${YELLOW}Setting up zeos repository...${NC}"

mkdir -p "$HOME/projects"

if [ -d "$ZEOS_DIR" ]; then
    echo "zeos directory exists. Updating..."
    cd "$ZEOS_DIR"
    # v1.2.0+: if the migration tool is already present (v1.2.0 or later),
    # snapshot and relocate in-repo operator state to ~/.zeos BEFORE pulling,
    # so the pull (which removes the tracked registry) cannot lose it. On a
    # first jump from v1.1.0 the tool does not exist yet; see
    # docs/UPGRADING_TO_V1_2_0.md for the one-time manual pre-pull backup.
    if [ -f "$ZEOS_DIR/tools/migrate-state.py" ]; then
        python3 "$ZEOS_DIR/tools/migrate-state.py" --apply --backup \
            || echo "Warning: pre-pull state backup reported issues"
    fi
    git pull origin main || echo "Warning: Could not pull updates"
else
    echo "Cloning zeos..."
    git clone "$ZEOS_REPO" "$ZEOS_DIR"
    cd "$ZEOS_DIR"
fi

# v1.2.0: relocate operator state to ~/.zeos (idempotent). On update, ingest the
# canonical registry from the most recent pre-pull backup so the now-empty
# post-pull repo registry never overwrites it. On a fresh clone this just
# bootstraps an empty ~/.zeos from apps/REGISTRY.example.json.
if [ -f "$ZEOS_DIR/tools/migrate-state.py" ]; then
    LATEST_REG_BACKUP=$(ls -dt "$HOME"/.zeos/backups/*/repo-local-state/apps/REGISTRY.json 2>/dev/null | head -1 || true)
    if [ -n "$LATEST_REG_BACKUP" ]; then
        python3 "$ZEOS_DIR/tools/migrate-state.py" --apply --cleanup-repo-state \
            --registry-source "$LATEST_REG_BACKUP" \
            || echo "Warning: state migration reported issues"
    else
        python3 "$ZEOS_DIR/tools/migrate-state.py" --apply \
            || echo "Warning: state migration reported issues"
    fi
fi

echo -e "${GREEN}✓ zeos repository ready${NC}"

# ═══════════════════════════════════════════════════════════════
# Profile Setup (skip in update mode)
# ═══════════════════════════════════════════════════════════════

if [ "$UPDATE_MODE" = false ]; then
    echo ""
    echo -e "${YELLOW}Setting up your profile...${NC}"

    # Get profile name
    read -p "Enter your profile name (lowercase, no spaces): " PROFILE_NAME

    if [ -z "$PROFILE_NAME" ]; then
        echo -e "${RED}Profile name cannot be empty${NC}"
        exit 1
    fi

    # Normalize profile name
    PROFILE_NAME=$(echo "$PROFILE_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')

    # v1.2.0: operator profiles live under the state root (~/.zeos), not in the
    # repo. Only profiles/template/ ships in the repo as a product default.
    PROFILE_DIR="$HOME/.zeos/profiles/$PROFILE_NAME"

    if [ -d "$PROFILE_DIR" ]; then
        echo "Profile '$PROFILE_NAME' already exists."
    else
        echo "Creating profile from template..."
        mkdir -p "$HOME/.zeos/profiles"
        cp -r "$ZEOS_DIR/profiles/template" "$PROFILE_DIR"

        # Update profile with user's name
        read -p "Enter your full name: " FULL_NAME
        read -p "Enter your callsign (optional): " CALLSIGN

        # Update PROFILE.md
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s/profile_id: \"template\"/profile_id: \"$PROFILE_NAME\"/" "$PROFILE_DIR/PROFILE.md"
            sed -i '' "s/operator: \"\[Your Name\]\"/operator: \"$FULL_NAME\"/" "$PROFILE_DIR/PROFILE.md"
            sed -i '' "s/callsign: \"\[Your Callsign\]\"/callsign: \"${CALLSIGN:-$PROFILE_NAME}\"/" "$PROFILE_DIR/PROFILE.md"
            sed -i '' "s/status: \"TEMPLATE\"/status: \"ACTIVE\"/" "$PROFILE_DIR/PROFILE.md"
        else
            sed -i "s/profile_id: \"template\"/profile_id: \"$PROFILE_NAME\"/" "$PROFILE_DIR/PROFILE.md"
            sed -i "s/operator: \"\[Your Name\]\"/operator: \"$FULL_NAME\"/" "$PROFILE_DIR/PROFILE.md"
            sed -i "s/callsign: \"\[Your Callsign\]\"/callsign: \"${CALLSIGN:-$PROFILE_NAME}\"/" "$PROFILE_DIR/PROFILE.md"
            sed -i "s/status: \"TEMPLATE\"/status: \"ACTIVE\"/" "$PROFILE_DIR/PROFILE.md"
        fi

        echo -e "${GREEN}✓ Profile created: $PROFILE_NAME${NC}"
    fi
else
    # In update mode, detect the existing operator profile: state-side first
    # (~/.zeos/profiles), then the legacy in-repo location for un-migrated installs.
    PROFILE_NAME=$(find "$HOME/.zeos/profiles" -mindepth 1 -maxdepth 1 -type d \
        ! -name template -exec basename {} \; 2>/dev/null | head -1)
    if [ -z "$PROFILE_NAME" ]; then
        PROFILE_NAME=$(find "$ZEOS_DIR/profiles" -mindepth 1 -maxdepth 1 -type d \
            ! -name template -exec basename {} \; 2>/dev/null | head -1)
    fi
    if [ -z "$PROFILE_NAME" ]; then
        PROFILE_NAME="template"
    fi
    FULL_NAME="$PROFILE_NAME"
fi

# ═══════════════════════════════════════════════════════════════
# Build Inject MCP Server
# ═══════════════════════════════════════════════════════════════

echo ""
echo -e "${YELLOW}Building zeos MCP server...${NC}"

cd "$ZEOS_DIR/infrastructure/inject"
npm install --silent 2>/dev/null || npm install
npm run build --silent 2>/dev/null || npm run build

echo -e "${GREEN}✓ zeos MCP server built${NC}"

# ═══════════════════════════════════════════════════════════════
# Install Claude Skills
# ═══════════════════════════════════════════════════════════════

echo ""
echo -e "${YELLOW}Installing Claude Code skills...${NC}"

SKILLS_SRC="$ZEOS_DIR/infrastructure/skills"
SKILLS_DST="$CLAUDE_DIR/skills"

mkdir -p "$SKILLS_DST"

# Copy each skill
for skill in zeos project newproject snap end team promote-soul; do
    if [ -d "$SKILLS_SRC/$skill" ]; then
        mkdir -p "$SKILLS_DST/$skill"
        cp "$SKILLS_SRC/$skill/SKILL.md" "$SKILLS_DST/$skill/SKILL.md"
        echo "  ✓ Installed /$(basename $skill) skill"
    fi
done

echo -e "${GREEN}✓ Claude skills installed${NC}"

# ═══════════════════════════════════════════════════════════════
# Install Overseer MCP (Python, multi-agent relay)
# ═══════════════════════════════════════════════════════════════

OVERSEER_INSTALLED=false

# Find a Python 3.12+ interpreter. Check explicit version commands first since
# the default `python3` on macOS/Linux may be 3.9 or 3.11 even when 3.12 is installed.
find_python312() {
    local candidates=(
        "python3.13"
        "python3.12"
        "/opt/homebrew/opt/python@3.13/bin/python3.13"
        "/opt/homebrew/opt/python@3.12/bin/python3.12"
        "/usr/local/opt/python@3.13/bin/python3.13"
        "/usr/local/opt/python@3.12/bin/python3.12"
        "python3"
    )
    for candidate in "${candidates[@]}"; do
        if command -v "$candidate" &> /dev/null || [ -x "$candidate" ]; then
            local version
            version=$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)
            if [ -n "$version" ]; then
                local major minor
                major=$(echo "$version" | cut -d. -f1)
                minor=$(echo "$version" | cut -d. -f2)
                if [ "$major" -ge 3 ] && [ "$minor" -ge 12 ]; then
                    echo "$candidate"
                    return 0
                fi
            fi
        fi
    done
    return 1
}

PYTHON312=$(find_python312 || true)

if [ -n "$PYTHON312" ] && command -v tmux &> /dev/null; then
    PY_VERSION=$("$PYTHON312" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
    echo ""
    echo -e "${YELLOW}Installing overseer MCP (multi-agent relay; using Python $PY_VERSION)...${NC}"
    OVERSEER_DIR="$ZEOS_DIR/infrastructure/overseer"
    cd "$OVERSEER_DIR"

    # Prefer uv if available, fall back to venv + pip
    if command -v uv &> /dev/null; then
        uv venv --python "$PYTHON312" .venv 2>/dev/null || true
        uv pip install -e . --quiet 2>&1 | tail -3 || true
    else
        if [ ! -d .venv ]; then
            "$PYTHON312" -m venv .venv
        fi
        ./.venv/bin/pip install --quiet --upgrade pip 2>/dev/null || true
        ./.venv/bin/pip install --quiet -e . 2>&1 | tail -3 || true
    fi

    chmod +x "$OVERSEER_DIR/bin/launch" 2>/dev/null || true

    # Preflight smoke test
    if "$OVERSEER_DIR/bin/launch" --check >/dev/null 2>&1; then
        echo -e "${GREEN}✓ Overseer MCP installed${NC}"
        OVERSEER_INSTALLED=true
    else
        echo -e "${YELLOW}⚠ Overseer preflight failed — /team skill will not work until fixed${NC}"
    fi
    cd "$ZEOS_DIR"
elif [ -z "$PYTHON312" ]; then
    echo -e "${YELLOW}Skipping overseer (no Python 3.12+ found on PATH or in homebrew)${NC}"
else
    echo -e "${YELLOW}Skipping overseer (requires tmux; install with: brew install tmux)${NC}"
fi

# ═══════════════════════════════════════════════════════════════
# Configure MCP servers in ~/.mcp.json (Cursor/etc.) AND ~/.claude.json (Claude Code)
# Both files are written for compatibility across MCP hosts.
# ═══════════════════════════════════════════════════════════════

echo ""
echo -e "${YELLOW}Configuring MCP servers...${NC}"

# Use Python to merge JSON (sed is fragile for nested JSON)
mcp_upsert() {
    local file="$1" name="$2" command="$3" args_json="$4"
    [ ! -f "$file" ] && echo '{}' > "$file"
    python3 - "$file" "$name" "$command" "$args_json" <<'PYEOF'
import json, sys
path, name, cmd, args_json = sys.argv[1:5]
try:
    data = json.load(open(path))
except Exception:
    data = {}
data.setdefault("mcpServers", {})[name] = {
    "type": "stdio",
    "command": cmd,
    "args": json.loads(args_json),
}
json.dump(data, open(path, "w"), indent=2)
PYEOF
}

INJECT_LAUNCH="$ZEOS_DIR/infrastructure/inject/bin/launch"
OVERSEER_LAUNCH="$ZEOS_DIR/infrastructure/overseer/bin/launch"
chmod +x "$INJECT_LAUNCH" 2>/dev/null || true

CLAUDE_JSON="$HOME/.claude.json"
MCP_JSON="$HOME/.mcp.json"

mcp_upsert "$CLAUDE_JSON" "zeos" "$INJECT_LAUNCH" '[]'
mcp_upsert "$MCP_JSON"    "zeos" "$INJECT_LAUNCH" '[]'

if [ "$OVERSEER_INSTALLED" = true ]; then
    mcp_upsert "$CLAUDE_JSON" "overseer" "$OVERSEER_LAUNCH" '[]'
    mcp_upsert "$MCP_JSON"    "overseer" "$OVERSEER_LAUNCH" '[]'
fi

echo -e "${GREEN}✓ MCP servers wired in ~/.claude.json and ~/.mcp.json${NC}"

# ═══════════════════════════════════════════════════════════════
# Configure the PreCompact auto-snap hook in ~/.claude/settings.json
# (Claude Code settings; NET-NEW file for this installer). Deep-merges a single
# hooks.PreCompact entry WITHOUT clobbering existing user hooks or other keys.
# Idempotent: re-running updates the zeos entry in place rather than duplicating.
# ═══════════════════════════════════════════════════════════════

echo ""
echo -e "${YELLOW}Configuring PreCompact auto-snap hook...${NC}"

# Deep-merge a single PreCompact hook command into settings.json. Delegates to
# tools/settings-hook-upsert.py (a standalone, unit-tested unit) which touches
# ONLY hooks.PreCompact, preserves existing user hooks and other keys, and is
# idempotent via the marker substring so re-running never duplicates our entry.
settings_hook_upsert() {
    local file="$1" command="$2" marker="$3"
    mkdir -p "$(dirname "$file")"
    python3 "$ZEOS_DIR/tools/settings-hook-upsert.py" "$file" "$command" "$marker"
}

CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"
PRECOMPACT_HOOK="$ZEOS_DIR/infrastructure/inject/bin/precompact-snap.sh"
chmod +x "$PRECOMPACT_HOOK" 2>/dev/null || true

# The script basename is the idempotency marker; it is stable across installs.
# Check the upsert exit status: a corrupt/unparseable settings.json (or an
# unexpected hooks shape) exits non-zero and leaves the file UNTOUCHED, so only
# claim success on exit 0; on failure warn clearly and continue without
# pretending the hook was wired.
if settings_hook_upsert "$CLAUDE_SETTINGS" "$PRECOMPACT_HOOK" "precompact-snap.sh"; then
  echo -e "${GREEN}✓ PreCompact auto-snap hook wired in ~/.claude/settings.json${NC}"
else
  echo -e "${YELLOW}⚠ Could not wire the PreCompact auto-snap hook: $CLAUDE_SETTINGS was left unchanged (unparseable or unexpected hooks shape). Auto-capture is OFF until this is resolved; see the message above.${NC}"
fi

# ═══════════════════════════════════════════════════════════════
# Create CLAUDE.md (skip if exists or update mode)
# ═══════════════════════════════════════════════════════════════

echo ""
echo -e "${YELLOW}Setting up CLAUDE.md...${NC}"

CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"

# zeos section block — appended idempotently (whether CLAUDE.md is new or pre-existing)
# Marker: <!-- zeos:installed --> — installer checks for this to avoid double-appending
ZEOS_MARKER="<!-- zeos:installed -->"

read -r -d '' ZEOS_SECTION <<EOF || true
$ZEOS_MARKER

## zeos — boot, project identity, session journals

zeos is installed at \`~/projects/zeos/\` (Apache 2.0, public release from \`github.com/rgsuarez/zeos\`). It provides:

- A boot protocol that loads kernel + profile + governance into the agent on demand.
- A project-identity loader (\`/project <name>\`) that pulls a project's \`SOUL.md\` (identity), \`CLAUDE.md\` (operations doctrine), latest journals, and \`MEMORY.md\` so a cold agent resumes with full context.
- Automated session-journal writing via \`/snap\` (mid-session) and \`/end\` (close), written to the state-side journal directory, NOT into the project repo.

**Active profile:** \`$PROFILE_NAME\` (\`~/.zeos/profiles/$PROFILE_NAME/PROFILE.md\`).

**Where per-project state lives (v1.2.0+):** under the state root \`~/.zeos\` (outside any repo, mirroring \`~/.claude\` and \`~/.codex\`).

- \`SOUL.md\` (identity, WHO):    \`~/.zeos/souls/<app_id>/SOUL.md\`
- Journals:                         \`~/.zeos/journals/<app_id>/\`
- \`MEMORY.md\` (curated memory):  \`~/.zeos/memory/<app_id>/MEMORY.md\`
- \`MASTER_ROADMAP.md\` (direction): \`~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md\`
- Registry:                         \`~/.zeos/apps/REGISTRY.json\`
- \`CLAUDE.md\` (operations — HOW): \`<project repo>/CLAUDE.md\` (always scaffolded; untracked by default, operator decides commit policy)

The SOUL / CLAUDE.md split: SOUL is identity (mission, constraints, values — rarely changes). CLAUDE.md is operations (build commands, conventions, file paths — changes weekly). Two files, two semantic loads, two change cadences.

Project repos themselves stay otherwise clean — only \`CLAUDE.md\` lives there. No per-machine \`.git/info/exclude\` config required for operator-side state.

**Inject MCP** wired in \`~/.mcp.json\` as the \`zeos\` server. Powers \`mcp__inject__zeos_*\` tools that the skills below call.

**Skills (installed at \`~/.claude/skills/\`):**

| Command | Purpose |
|---|---|
| \`/zeos\` | Boot zeos — load kernel + profile + governance protocols into the session. Pass a profile name as arg to override default. |
| \`/project <name>\` | Load a project: \`SOUL.md\`, project's \`CLAUDE.md\`, latest 1–2 zeos-side session journals, \`MEMORY.md\`. Switches the session into that project's identity. Auto-boots zeos if needed. |
| \`/newproject <id> ...\` | Register a new project in \`~/.zeos/apps/REGISTRY.json\` and scaffold five files: \`SOUL.md\`, \`MEMORY.md\`, \`journals/README.md\`, \`MASTER_ROADMAP.md\` (all state-side under \`~/.zeos\`), and \`CLAUDE.md\` (in the project repo, operator decides commit policy). Local-first, never pushes to a remote registry. |
| \`/snap [note]\` | Append-only session journal entry mid-session. Captures what happened, decisions, next steps. |
| \`/end\` | Close the session: final journal entry + git commit/push if the repo is in a clean state. |
| \`/team <subcommand>\` | Multi-agent team orchestration via Overseer MCP (advisor/executor paired-lane patterns, tmux cross-pane messaging). Optional — only when running paired agents alongside Claude. |

**Updating zeos:**

\`\`\`bash
bash ~/projects/zeos/tools/install.sh --update
\`\`\`

Refreshes skills and MCP config without touching profile or CLAUDE.md.

---
EOF

if [ ! -f "$CLAUDE_MD" ]; then
    # Fresh install — create a minimal CLAUDE.md headed with operator identity, then append zeos section
    cat > "$CLAUDE_MD" <<EOF
# Operator: $FULL_NAME

Tone: Direct, professional.

EOF
    echo "$ZEOS_SECTION" >> "$CLAUDE_MD"
    echo -e "${GREEN}✓ CLAUDE.md created with zeos section${NC}"
elif grep -q "$ZEOS_MARKER" "$CLAUDE_MD"; then
    echo -e "${GREEN}✓ CLAUDE.md already has zeos section (marker present) — skipping${NC}"
else
    # Existing CLAUDE.md without zeos section — append idempotently
    {
        echo ""
        echo "$ZEOS_SECTION"
    } >> "$CLAUDE_MD"
    echo -e "${GREEN}✓ Appended zeos section to existing CLAUDE.md${NC}"
fi

# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
if [ "$UPDATE_MODE" = true ]; then
    echo -e "${GREEN}zeos Update Complete!${NC}"
else
    echo -e "${GREEN}zeos Installation Complete!${NC}"
fi
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Installation Summary:"
echo "  - zeos: $ZEOS_DIR"
echo "  - Profile: $PROFILE_NAME"
echo "  - MCP Server: $ZEOS_DIR/infrastructure/inject/"
echo "  - MCP Config: ~/.claude.json + ~/.mcp.json"
echo "  - MCP Servers: zeos (inject)$([ "$OVERSEER_INSTALLED" = true ] && echo ', overseer (multi-agent)')"
echo "  - Skills: ~/.claude/skills/{zeos,project,newproject,snap,end,team,promote-soul}"
echo ""
echo "Available Commands:"
echo "  /zeos                  Boot zeos"
echo "  /project <id>          Load project"
echo "  /newproject <id> ...   Register + scaffold a new project (local-first)"
echo "  /snap [note]           Save progress"
echo "  /end                   End session"
echo "  /team <sub>            Multi-agent orchestration (optional)"
echo "  /promote-soul <date> <section>  Promote a MEMORY entry to SOUL.md (dry-run by default)"
echo ""
if [ "$UPDATE_MODE" = false ]; then
    echo "Next Steps:"
    echo "  1. Restart Claude Code"
    echo "  2. Type: /zeos"
    echo "  3. Then: /project <name> to load a project"
    echo ""
fi
echo "Update skills later: bash ~/projects/zeos/tools/install.sh --update"
echo ""
echo "Documentation: $ZEOS_DIR/docs/GETTING_STARTED.md"
echo ""
echo -e "${BLUE}Welcome to zeos. Memory infrastructure for AI.${NC}"
