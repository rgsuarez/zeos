#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# zeos Uninstaller
# ═══════════════════════════════════════════════════════════════
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/rgsuarez/zeos/main/tools/uninstall.sh | bash
#
# Or locally:
#   bash ~/projects/zeos/tools/uninstall.sh [options]
#
# Removes:
#   - 6 skills from ~/.claude/skills/{zeos,project,newproject,snap,end,team}
#   - zeos + overseer entries from ~/.claude.json and ~/.mcp.json
#   - The zeos section from ~/.claude/CLAUDE.md (marker-delimited)
#   - ~/projects/zeos/ directory (default; --keep-repo skips)
#
# Never touches (unless you opt in with --purge-state):
#   - ~/.zeos/ operator state (registry, profiles, souls, memory, journals,
#     roadmaps). As of v1.2.0 this lives outside the repo, so removing the repo
#     leaves it intact. Pass --purge-state to delete it too.
#   - Your project repos under ~/projects/<other-project>/
#   - Other MCP servers in ~/.claude.json / ~/.mcp.json
#   - Your ~/.claude/CLAUDE.md outside the zeos-managed section
#
# ═══════════════════════════════════════════════════════════════

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Flags
KEEP_REPO=false
PURGE_STATE=false
YES=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --keep-repo)   KEEP_REPO=true;   shift ;;
        --purge-state) PURGE_STATE=true; shift ;;
        --yes|-y)      YES=true;         shift ;;
        --help|-h)
            cat <<HELP
zeos uninstaller

Usage: bash uninstall.sh [options]

Options:
  --keep-repo     Don't remove ~/projects/zeos/ (skills + MCP entries still cleaned)
  --purge-state   ALSO delete ~/.zeos/ operator state (registry, profiles, souls,
                  memory, journals, roadmaps). Off by default; this is destructive.
  --yes / -y      Skip confirmation prompts

Always preserved (never touched):
  - ~/.zeos/ operator state, UNLESS you pass --purge-state
  - Your project repos under ~/projects/<other-project>/
  - The team's CLAUDE.md in any project repo
  - Other MCP servers in ~/.claude.json (only zeos + overseer entries removed)
  - Your global ~/.claude/CLAUDE.md (only the zeos-managed section is removed)
HELP
            exit 0 ;;
        *) echo "Unknown flag: $1 (try --help)"; exit 1 ;;
    esac
done

echo -e "${BLUE}"
cat <<'BANNER'
═══════════════════════════════════════════════════════════════

    ███████ ████████  ███████  ██████
       ███  ██       ██    ██ ██
      ███   ██████   ██    ██  █████
     ███    ██       ██    ██      ██
    ███████ ████████  ███████  ██████

    Uninstaller v1.0.0

═══════════════════════════════════════════════════════════════
BANNER
echo -e "${NC}"

ZEOS_DIR="$HOME/projects/zeos"
SKILLS_DIR="$HOME/.claude/skills"
CLAUDE_JSON="$HOME/.claude.json"
MCP_JSON="$HOME/.mcp.json"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

# ───────────────────────────────────────────────────────────────
# Plan: enumerate what will be removed
# ───────────────────────────────────────────────────────────────

echo "Will remove:"
SKILLS_FOUND=()
for skill in zeos project newproject snap end team; do
    if [ -d "$SKILLS_DIR/$skill" ]; then
        echo "  - $SKILLS_DIR/$skill/"
        SKILLS_FOUND+=("$skill")
    fi
done

MCP_TO_CLEAN=()
for f in "$CLAUDE_JSON" "$MCP_JSON"; do
    if [ -f "$f" ] && python3 -c "import json,sys; d=json.load(open(sys.argv[1])); s=d.get('mcpServers',{}); sys.exit(0 if ('zeos' in s or 'overseer' in s) else 1)" "$f" 2>/dev/null; then
        echo "  - zeos/overseer entries in $f"
        MCP_TO_CLEAN+=("$f")
    fi
done

CLAUDE_MD_HAS_MARKER=false
if [ -f "$CLAUDE_MD" ] && grep -q "<!-- zeos:installed -->" "$CLAUDE_MD"; then
    echo "  - zeos section in $CLAUDE_MD"
    CLAUDE_MD_HAS_MARKER=true
fi

REMOVE_REPO=false
if [ "$KEEP_REPO" = false ] && [ -d "$ZEOS_DIR" ]; then
    echo "  - $ZEOS_DIR/ (repo only; operator state lives in ~/.zeos)"
    REMOVE_REPO=true
fi

PURGE_STATE_DIR=false
if [ "$PURGE_STATE" = true ] && [ -d "$HOME/.zeos" ]; then
    echo "  - ~/.zeos/ (operator state: registry, profiles, souls, memory, journals, roadmaps)"
    PURGE_STATE_DIR=true
fi

if [ ${#SKILLS_FOUND[@]} -eq 0 ] && [ ${#MCP_TO_CLEAN[@]} -eq 0 ] && [ "$CLAUDE_MD_HAS_MARKER" = false ] && [ "$REMOVE_REPO" = false ] && [ "$PURGE_STATE_DIR" = false ]; then
    echo "  (nothing to do — zeos isn't installed)"
    echo ""
    exit 0
fi

echo ""
echo -e "${YELLOW}Will NOT touch:${NC}"
if [ "$PURGE_STATE_DIR" = false ]; then
    echo "  - ~/.zeos/ operator state (pass --purge-state to remove it too)"
fi
echo "  - Your project repos under ~/projects/<other-project>/"
echo "  - Other MCP servers in ~/.claude.json / ~/.mcp.json"
echo "  - Your ~/.claude/CLAUDE.md outside the zeos-managed section"
echo ""

if [ "$YES" = false ]; then
    read -p "Continue? [y/N] " REPLY
    if [[ ! "$REPLY" =~ ^[Yy] ]]; then
        echo "Aborted."
        exit 1
    fi
    echo ""
fi

# ───────────────────────────────────────────────────────────────
# Execute
# ───────────────────────────────────────────────────────────────

# 1. Skills
for skill in "${SKILLS_FOUND[@]}"; do
    rm -rf "$SKILLS_DIR/$skill"
    echo -e "${GREEN}  ✓${NC} Removed skill: /$skill"
done

# 2. MCP entries (use Python for safe JSON manipulation)
for f in "${MCP_TO_CLEAN[@]}"; do
    python3 - "$f" <<'PYEOF'
import json, sys
path = sys.argv[1]
try:
    data = json.load(open(path))
except Exception:
    sys.exit(0)
servers = data.get("mcpServers", {})
removed = []
for name in ["zeos", "overseer"]:
    if name in servers:
        del servers[name]
        removed.append(name)
if removed:
    # If mcpServers is now empty AND it was the only key in the file, leave as-is (don't delete the file)
    json.dump(data, open(path, "w"), indent=2)
    print(f"  \033[0;32m✓\033[0m Removed {','.join(removed)} from {path}")
PYEOF
done

# 3. CLAUDE.md section (delimited by <!-- zeos:installed --> marker through next ## heading)
if [ "$CLAUDE_MD_HAS_MARKER" = true ]; then
    python3 - "$CLAUDE_MD" <<'PYEOF'
import re, sys
path = sys.argv[1]
content = open(path).read()
# Remove from the marker through the next top-level section header,
# or to end-of-file if no next section.
# Pattern: optional leading newlines + marker + everything up to (but not including) next "\n## " or EOF
pattern = r'\n*<!-- zeos:installed -->.*?(?=\n## [^#]|\Z)'
new_content, n = re.subn(pattern, '\n', content, count=1, flags=re.DOTALL)
if n > 0:
    # Collapse multiple blank lines at the join point
    new_content = re.sub(r'\n{3,}', '\n\n', new_content)
    open(path, "w").write(new_content)
    print(f"  \033[0;32m✓\033[0m Removed zeos section from {path}")
PYEOF
fi

# 4. Repo directory
if [ "$REMOVE_REPO" = true ]; then
    # Defensive: if the operator's cwd is inside the zeos dir, move them out
    # before deletion so subsequent commands in the same shell don't break with
    # "getcwd: cannot access parent directories".
    case "$PWD" in
        "$ZEOS_DIR"|"$ZEOS_DIR"/*)
            echo -e "${YELLOW}  Note: cwd is inside zeos repo; moving to \$HOME first to avoid stale-cwd errors.${NC}"
            cd "$HOME"
            ;;
    esac

    rm -rf "$ZEOS_DIR"
    echo -e "${GREEN}  ✓${NC} Removed $ZEOS_DIR (operator state in ~/.zeos preserved)"
fi

# 5. Operator state (opt-in, destructive)
if [ "$PURGE_STATE_DIR" = true ]; then
    rm -rf "$HOME/.zeos"
    echo -e "${GREEN}  ✓${NC} Purged ~/.zeos operator state"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}zeos uninstall complete.${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "To reinstall later:"
echo "  curl -sL https://raw.githubusercontent.com/rgsuarez/zeos/main/tools/install.sh | bash"
