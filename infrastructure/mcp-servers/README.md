# zeos MCP Infrastructure

Local-first MCP (Model Context Protocol) servers for zeos, enabling offline operation with async GitHub sync.

## Overview

This infrastructure transforms zeos from a GitHub API-dependent system to a fully offline-capable platform. All operations work locally, with changes synced to GitHub when connectivity is available.

### Features

- **Offline-First**: Full zeos operation without network dependency
- **Async Sync**: Background GitHub synchronization with conflict resolution
- **Fast Boot**: <100ms context loading from local SSD
- **Native Claude Integration**: MCP resources and tools for Claude Desktop

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| `@zeos/mcp-shared` | Shared types, errors, logging | ✅ Complete |
| `@zeos/filesystem-mcp` | Local file operations | ✅ Complete |
| `@zeos/git-mcp` | Git operations with offline queue | ✅ Complete |
| `@zeos/shell-mcp` | Bang command execution | ✅ Complete |
| `@zeos/sqlite-mcp` | Local state and sync queue | ✅ Complete |
| `@zeos/zeos-mcp` | Unified zeos MCP server | ✅ Complete |

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm (or npm)
- Git configured with GitHub access

### Installation

```bash
# Clone zeos
git clone https://github.com/rgsuarez/zeos.git
cd zeos/infrastructure/mcp-servers

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Configure Claude Desktop
pnpm --filter @zeos/zeos-mcp configure
```

## Claude Desktop Configuration

Add to your Claude Desktop config (`claude_desktop_config.json`):

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

## MCP Resources

| URI Pattern | Description |
|-------------|-------------|
| `zeos://kernel/*` | Kernel files (SOUL.md, BOOT_PROTOCOL.md) |
| `zeos://profile/{id}/*` | Profile files (PROFILE.md) |
| `zeos://module/*` | Protocol modules |
| `zeos://app/{id}/*` | Application SOULs and journals |
| `zeos://state/*` | Session state and sync queue |

## MCP Tools

| Tool | Description |
|------|-------------|
| `zeos_boot` | Initialize zeos context |
| `zeos_project` | Load project context |
| `zeos_checkpoint` | Save current progress |
| `zeos_end` | End session with handoff |
| `zeos_status` | Show current state |
| `git_status` | Git repository status |
| `git_commit` | Commit changes (queued if offline) |
| `git_push` | Push to remote (queued if offline) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ZEOS_ROOT` | `~/zeos` | Path to zeos installation |
| `ZEOS_PROFILE` | `default` | Active profile name |
| `ZEOS_SYNC_ENABLED` | `true` | Enable background sync |
| `ZEOS_SYNC_INTERVAL` | `60000` | Sync interval (ms) |
| `ZEOS_LOG_LEVEL` | `info` | Log level (debug/info/warn/error) |

## Development

```bash
# Run tests
pnpm test

# Run benchmarks
pnpm --filter @zeos/zeos-mcp benchmark

# Type checking
pnpm typecheck
```

## Documentation

- [Installation Guide](docs/INSTALLATION.md)
- [Configuration Reference](docs/CONFIGURATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [MCP Roadmap](../../docs/MCP_ROADMAP.md)

## License

MIT © my-org
