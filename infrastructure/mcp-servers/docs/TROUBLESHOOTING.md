# zeos MCP Troubleshooting Guide

## Common Issues

### Server Not Appearing in Claude Desktop

**Symptom:** The "zeos" server doesn't appear in Claude Desktop's MCP list.

**Solutions:**

1. **Check configuration file location:**
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Linux: `~/.config/Claude/claude_desktop_config.json`

2. **Validate JSON syntax:**
   ```bash
   # Check for JSON errors
   node -e "require('./claude_desktop_config.json')"
   ```

3. **Verify paths are absolute:**
   ```json
   {
     "args": ["/full/path/to/zeos/infrastructure/mcp-servers/packages/zeos-mcp/dist/index.js"]
   }
   ```

4. **Restart Claude Desktop** after configuration changes.

### Build Failures

**Symptom:** `pnpm build` fails with TypeScript errors.

**Solutions:**

1. **Ensure Node.js 18+:**
   ```bash
   node --version  # Should be v18.0.0 or higher
   ```

2. **Clean and reinstall:**
   ```bash
   rm -rf node_modules
   pnpm install
   pnpm build
   ```

3. **Check for missing dependencies:**
   ```bash
   pnpm install --frozen-lockfile
   ```

### Boot Timeout

**Symptom:** `zeos_boot` times out or fails.

**Solutions:**

1. **Verify ZEOS_ROOT:**
   ```bash
   ls $ZEOS_ROOT/kernel/SOUL.md  # Should exist
   ```

2. **Check file permissions:**
   ```bash
   # Ensure read access to kernel files
   cat $ZEOS_ROOT/kernel/SOUL.md
   ```

3. **Enable debug logging:**
   Set `ZEOS_LOG_LEVEL=debug` in Claude Desktop config.

### Sync Failures

**Symptom:** Changes aren't syncing to GitHub.

**Solutions:**

1. **Check network connectivity:**
   ```bash
   git ls-remote origin
   ```

2. **Verify Git credentials:**
   ```bash
   git push --dry-run
   ```

3. **Check sync queue:**
   Use `zeos_status` to view pending sync operations.

4. **Manual sync:**
   ```bash
   cd $ZEOS_ROOT
   git push
   ```

### Profile Not Found

**Symptom:** Error "Profile 'x' not found".

**Solutions:**

1. **Check profile exists:**
   ```bash
   ls $ZEOS_ROOT/profiles/
   ```

2. **Verify PROFILE.md:**
   ```bash
   cat $ZEOS_ROOT/profiles/your-profile/PROFILE.md
   ```

3. **Use correct profile name:**
   Set `ZEOS_PROFILE` to the directory name (e.g., "operator" not "<operator>").

### Memory Issues

**Symptom:** Server crashes with out-of-memory errors.

**Solutions:**

1. **Increase Node.js memory:**
   ```json
   {
     "args": ["--max-old-space-size=512", "/path/to/index.js"]
   }
   ```

2. **Run benchmarks to check memory usage:**
   ```bash
   pnpm --filter @zeos/zeos-mcp benchmark
   ```

### Database Locked

**Symptom:** "Database is locked" errors.

**Solutions:**

1. **Only one server instance** should run at a time.

2. **Check for stale processes:**
   ```bash
   # Windows
   tasklist | findstr node

   # macOS/Linux
   ps aux | grep zeos-mcp
   ```

3. **Remove stale lock file:**
   ```bash
   rm $ZEOS_ROOT/.zeos/state.db-journal
   ```

## Debug Mode

Enable verbose logging by setting environment variables:

```json
{
  "env": {
    "ZEOS_LOG_LEVEL": "debug",
    "NODE_DEBUG": "zeos"
  }
}
```

Logs are written to stderr in JSON format.

## Getting Help

1. **Check existing issues:** https://github.com/rgsuarez/zeos/issues
2. **Create new issue:** Include:
   - zeos version (`git describe --tags`)
   - Node.js version (`node --version`)
   - Operating system
   - Full error message
   - Steps to reproduce

---

*Architect: <operator> G. <operator>*
