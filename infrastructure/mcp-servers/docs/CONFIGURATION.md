# zeos MCP Configuration Reference

## Environment Variables

All environment variables are optional with sensible defaults.

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `ZEOS_ROOT` | `~/zeos` | Path to zeos installation directory |
| `ZEOS_PROFILE` | `default` | Active profile name (subdirectory of `profiles/`) |

### Sync Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `ZEOS_SYNC_ENABLED` | `true` | Enable background GitHub synchronization |
| `ZEOS_SYNC_INTERVAL` | `60000` | Sync interval in milliseconds (default: 1 minute) |

### Logging Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `ZEOS_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

### Database Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `ZEOS_DB_PATH` | `<ZEOS_ROOT>/.zeos/state.db` | SQLite database path |

## Claude Desktop Configuration

### Basic Configuration

```json
{
  "mcpServers": {
    "zeos": {
      "command": "node",
      "args": ["/path/to/zeos/infrastructure/mcp-servers/packages/zeos-mcp/dist/index.js"],
      "env": {
        "ZEOS_ROOT": "/path/to/zeos",
        "ZEOS_PROFILE": "operator"
      }
    }
  }
}
```

### Development Configuration

For development with debug logging:

```json
{
  "mcpServers": {
    "zeos": {
      "command": "node",
      "args": ["/path/to/zeos/infrastructure/mcp-servers/packages/zeos-mcp/dist/index.js"],
      "env": {
        "ZEOS_ROOT": "/path/to/zeos",
        "ZEOS_PROFILE": "operator",
        "ZEOS_LOG_LEVEL": "debug"
      }
    }
  }
}
```

### Offline-Only Configuration

Disable background sync for fully offline operation:

```json
{
  "mcpServers": {
    "zeos": {
      "command": "node",
      "args": ["/path/to/zeos/infrastructure/mcp-servers/packages/zeos-mcp/dist/index.js"],
      "env": {
        "ZEOS_ROOT": "/path/to/zeos",
        "ZEOS_PROFILE": "operator",
        "ZEOS_SYNC_ENABLED": "false"
      }
    }
  }
}
```

## Profile Configuration

Profiles are stored in `<ZEOS_ROOT>/profiles/<profile-name>/`.

Each profile requires a `PROFILE.md` file with YAML frontmatter:

```yaml
---
document: "PROFILE"
profile_id: "your-name"
version: "1.0.0"
status: "active"
---

# Your Name

Profile content...
```

## MCP Resources

zeos exposes these resource URI patterns:

| Pattern | Description | Example |
|---------|-------------|---------|
| `zeos://kernel/*` | Kernel files | `zeos://kernel/SOUL.md` |
| `zeos://profile/{id}/*` | Profile files | `zeos://profile/operator/PROFILE.md` |
| `zeos://module/*` | Protocol modules | `zeos://module/BOOT_PROTOCOL.md` |
| `zeos://app/{id}/*` | Application files | `zeos://app/example-project/SOUL.md` |
| `zeos://state/*` | State and sync queue | `zeos://state/session` |

## MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `zeos_boot` | Initialize zeos context | `profile` (optional) |
| `zeos_project` | Load project context | `project_id` |
| `zeos_checkpoint` | Save current progress | `message` (optional) |
| `zeos_end` | End session with handoff | — |
| `zeos_status` | Show current state | — |
| `git_status` | Git repository status | — |
| `git_commit` | Commit changes | `message`, `files` (optional) |
| `git_push` | Push to remote | — |
