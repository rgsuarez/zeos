#!/bin/bash
# Backward-compat shim — delegates to bin/launch (the canonical resilient launcher).
# All new MCP host configs should point at bin/launch directly.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/bin/launch" "$@"
