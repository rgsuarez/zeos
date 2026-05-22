# zeos MCP Installation Guide

## Prerequisites

- **Node.js 18+** — Required for ES modules and modern JavaScript features
- **pnpm** — Recommended package manager (npm works but pnpm is faster)
- **Git** — Configured with GitHub access for sync features

## Step 1: Clone zeos

```bash
git clone https://github.com/rgsuarez/zeos.git
cd zeos
```

## Step 2: Install Dependencies

```bash
cd infrastructure/mcp-servers
pnpm install
```

Or with npm:

```bash
npm install
```

## Step 3: Build All Packages

```bash
pnpm build
```

This builds all packages in dependency order:
1. `@zeos/mcp-shared` — Shared types and utilities
2. `@zeos/filesystem-mcp` — File operations
3. `@zeos/git-mcp` — Git operations
4. `@zeos/shell-mcp` — Bang command execution
5. `@zeos/sqlite-mcp` — Local state management
6. `@zeos/zeos-mcp` — Unified server

## Step 4: Configure Claude Desktop

### Automatic Configuration

```bash
pnpm --filter @zeos/zeos-mcp configure
```

This adds the zeos MCP server to your Claude Desktop configuration.

### Manual Configuration

Edit your Claude Desktop config file:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Linux:** `~/.config/Claude/claude_desktop_config.json`

Add the zeos server:

```json
{
  "mcpServers": {
    "zeos": {
      "command": "node",
      "args": ["/path/to/zeos/infrastructure/mcp-servers/packages/zeos-mcp/dist/index.js"],
      "env": {
        "ZEOS_ROOT": "/path/to/zeos",
        "ZEOS_PROFILE": "your-profile-name"
      }
    }
  }
}
```

Replace `/path/to/zeos` with your actual zeos installation path.

## Step 5: Verify Installation

Restart Claude Desktop. You should see "zeos" in the MCP servers list.

Test with:
```
Use the zeos_status tool to show current state
```

## Updating

```bash
cd zeos
git pull
cd infrastructure/mcp-servers
pnpm install
pnpm build
```

Restart Claude Desktop after updating.

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues.

## Uninstalling

1. Remove the "zeos" entry from your Claude Desktop config
2. Delete the zeos directory (optional)
3. Restart Claude Desktop
