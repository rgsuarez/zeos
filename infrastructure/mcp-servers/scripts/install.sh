#!/bin/bash
#
# zeos MCP Server Installation Script
#
# Usage:
#   ./install.sh [--zeos-root <path>] [--profile <name>]
#
# Installs the zeos MCP server and configures Claude Desktop.
#

set -e

# Defaults
ZEOS_ROOT="${HOME}/zeos"
PROFILE="template"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_ROOT="$(dirname "$SCRIPT_DIR")"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --zeos-root)
      ZEOS_ROOT="$2"
      shift 2
      ;;
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: ./install.sh [--zeos-root <path>] [--profile <name>]"
      echo ""
      echo "Options:"
      echo "  --zeos-root <path>   Path to zeos installation (default: ~/zeos)"
      echo "  --profile <name>     Profile to use (default: template)"
      echo "  --help, -h           Show this help"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "╔════════════════════════════════════════════════════════════╗"
echo "║           zeos MCP Server Installation                     ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Configuration:"
echo "  zeos Root: $ZEOS_ROOT"
echo "  Profile:   $PROFILE"
echo "  MCP Root:  $MCP_ROOT"
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Please install Node.js 18+."
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [[ "$NODE_VERSION" -lt 18 ]]; then
  echo "❌ Node.js 18+ required. Found: $(node -v)"
  exit 1
fi

if ! command -v pnpm &> /dev/null; then
  echo "⚠️  pnpm not found. Installing..."
  npm install -g pnpm
fi

echo "✅ Prerequisites OK"
echo ""

# Validate zeos installation
if [[ ! -f "$ZEOS_ROOT/kernel/SOUL.md" ]]; then
  echo "❌ zeos installation not found at $ZEOS_ROOT"
  echo "   Please clone zeos first: git clone https://github.com/rgsuarez/zeos.git"
  exit 1
fi

echo "✅ zeos installation found"
echo ""

# Install dependencies
echo "Installing MCP server dependencies..."
cd "$MCP_ROOT"
pnpm install

echo ""
echo "Building MCP servers..."
pnpm build

echo ""
echo "✅ Build complete"
echo ""

# Configure Claude Desktop
echo "Configuring Claude Desktop..."
pnpm tsx packages/zeos-mcp/src/cli/configure.ts \
  --zeos-root "$ZEOS_ROOT" \
  --profile "$PROFILE" \
  --force

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║           Installation Complete!                           ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Desktop"
echo "  2. Open a new conversation"
echo "  3. Type: !zeos"
echo ""
echo "The zeos MCP server will provide local-first operation with"
echo "automatic GitHub sync in the background."
echo ""
