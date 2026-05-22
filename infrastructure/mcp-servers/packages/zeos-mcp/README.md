# @zeos/zeos-mcp

Unified MCP (Model Context Protocol) server for zeos, enabling local-first operation with async GitHub sync.

## Installation

```bash
npm install @zeos/zeos-mcp
```

Or via Claude Desktop configuration:

```json
{
  "mcpServers": {
    "zeos": {
      "command": "npx",
      "args": ["@zeos/zeos-mcp"],
      "env": {
        "ZEOS_ROOT": "/path/to/zeos",
        "ZEOS_PROFILE": "your-profile"
      }
    }
  }
}
```

## Features

- **Offline-First**: Full zeos operation without network dependency
- **Async Sync**: Background GitHub synchronization with conflict resolution
- **Fast Boot**: <100ms context loading from local SSD
- **Native Claude Integration**: MCP resources and tools for Claude Desktop

## MCP Tools

| Tool | Description |
|------|-------------|
| `zeos_boot` | Initialize zeos context |
| `zeos_project` | Load project context |
| `zeos_checkpoint` | Save current progress |
| `zeos_end` | End session with handoff |
| `zeos_status` | Show current state |
| `git_status` | Git repository status |
| `git_commit` | Commit changes |
| `git_push` | Push to remote |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ZEOS_ROOT` | `~/zeos` | Path to zeos installation |
| `ZEOS_PROFILE` | `default` | Active profile name |
| `ZEOS_SYNC_ENABLED` | `true` | Enable background sync |
| `ZEOS_LOG_LEVEL` | `info` | Log level |

## Documentation

- [Full Documentation](https://github.com/rgsuarez/zeos/tree/main/infrastructure/mcp-servers)
- [Installation Guide](https://github.com/rgsuarez/zeos/tree/main/infrastructure/mcp-servers/docs/INSTALLATION.md)
- [Configuration Reference](https://github.com/rgsuarez/zeos/tree/main/infrastructure/mcp-servers/docs/CONFIGURATION.md)

## License

MIT © my-org
