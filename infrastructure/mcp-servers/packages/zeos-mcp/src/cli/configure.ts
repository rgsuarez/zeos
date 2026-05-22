#!/usr/bin/env node
/**
 * Claude Desktop Configuration Generator
 *
 * Generates claude_desktop_config.json with zeos MCP server configuration.
 * Supports macOS, Windows, and Linux.
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ClaudeDesktopConfig {
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

interface ConfigureOptions {
  zeosRoot: string;
  profile: string;
  dryRun?: boolean;
  force?: boolean;
}

/**
 * Get Claude Desktop config path for current OS
 */
function getConfigPath(): string {
  const os = platform();

  switch (os) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

    case 'win32':
      return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');

    case 'linux':
      return join(homedir(), '.config', 'claude', 'claude_desktop_config.json');

    default:
      throw new Error(`Unsupported platform: ${os}`);
  }
}

/**
 * Check if path exists
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read existing Claude Desktop config
 */
async function readExistingConfig(configPath: string): Promise<ClaudeDesktopConfig> {
  try {
    const content = await readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Generate zeos MCP server configuration
 */
function generateZeosConfig(options: ConfigureOptions): McpServerConfig {
  // Use the built zeos-mcp package
  const zeosServerPath = join(options.zeosRoot, 'infrastructure', 'mcp-servers', 'packages', 'zeos-mcp', 'dist', 'index.js');

  return {
    command: 'node',
    args: [zeosServerPath],
    env: {
      ZEOS_ROOT: options.zeosRoot,
      ZEOS_PROFILE: options.profile,
      ZEOS_SYNC: 'true'
    }
  };
}

/**
 * Configure Claude Desktop with zeos MCP server
 */
export async function configure(options: ConfigureOptions): Promise<string> {
  const configPath = getConfigPath();
  const configDir = dirname(configPath);

  // Validate zeos installation
  const soulPath = join(options.zeosRoot, 'kernel', 'SOUL.md');
  if (!await pathExists(soulPath)) {
    throw new Error(`zeos installation not found at ${options.zeosRoot}. Missing kernel/SOUL.md`);
  }

  // Validate profile exists
  const profilePath = join(options.zeosRoot, 'profiles', options.profile, 'PROFILE.md');
  if (!await pathExists(profilePath)) {
    throw new Error(`Profile not found: ${options.profile}. Missing ${profilePath}`);
  }

  // Read existing config
  const existingConfig = await readExistingConfig(configPath);

  // Check if zeos already configured
  if (existingConfig.mcpServers?.zeos && !options.force) {
    throw new Error('zeos MCP server already configured. Use --force to overwrite.');
  }

  // Generate new config
  const zeosConfig = generateZeosConfig(options);

  const newConfig: ClaudeDesktopConfig = {
    ...existingConfig,
    mcpServers: {
      ...existingConfig.mcpServers,
      zeos: zeosConfig
    }
  };

  // Format output
  const configJson = JSON.stringify(newConfig, null, 2);

  if (options.dryRun) {
    console.log('Dry run - would write to:', configPath);
    console.log(configJson);
    return configJson;
  }

  // Ensure config directory exists
  if (!await pathExists(configDir)) {
    await mkdir(configDir, { recursive: true });
  }

  // Write config
  await writeFile(configPath, configJson);

  return configJson;
}

/**
 * Remove zeos from Claude Desktop config
 */
export async function unconfigure(): Promise<void> {
  const configPath = getConfigPath();

  const existingConfig = await readExistingConfig(configPath);

  if (!existingConfig.mcpServers?.zeos) {
    console.log('zeos MCP server not configured. Nothing to remove.');
    return;
  }

  // Remove zeos server
  delete existingConfig.mcpServers.zeos;

  // Clean up empty mcpServers object
  if (Object.keys(existingConfig.mcpServers).length === 0) {
    delete existingConfig.mcpServers;
  }

  await writeFile(configPath, JSON.stringify(existingConfig, null, 2));
  console.log('zeos MCP server removed from Claude Desktop config.');
}

/**
 * Show current configuration
 */
export async function showConfig(): Promise<void> {
  const configPath = getConfigPath();

  console.log('Claude Desktop config path:', configPath);
  console.log('Platform:', platform());

  if (!await pathExists(configPath)) {
    console.log('Config file does not exist.');
    return;
  }

  const config = await readExistingConfig(configPath);

  if (config.mcpServers?.zeos) {
    console.log('\nzeos MCP Server configured:');
    console.log(JSON.stringify(config.mcpServers.zeos, null, 2));
  } else {
    console.log('\nzeos MCP Server not configured.');
  }
}

// CLI entry point
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
zeos Claude Desktop Configuration

Usage:
  configure [options]      Add zeos to Claude Desktop config
  unconfigure              Remove zeos from Claude Desktop config
  show                     Show current configuration

Options:
  --zeos-root <path>       Path to zeos installation (default: ~/zeos)
  --profile <name>         Profile to use (default: template)
  --dry-run                Show config without writing
  --force                  Overwrite existing zeos config
  --help, -h               Show this help
`);
    return;
  }

  if (args.includes('unconfigure')) {
    await unconfigure();
    return;
  }

  if (args.includes('show')) {
    await showConfig();
    return;
  }

  // Parse options
  const zeosRootIdx = args.indexOf('--zeos-root');
  const profileIdx = args.indexOf('--profile');

  const options: ConfigureOptions = {
    zeosRoot: zeosRootIdx >= 0 ? args[zeosRootIdx + 1] : join(homedir(), 'zeos'),
    profile: profileIdx >= 0 ? args[profileIdx + 1] : 'template',
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force')
  };

  try {
    const config = await configure(options);

    if (!options.dryRun) {
      console.log('zeos MCP server configured successfully!');
      console.log('Restart Claude Desktop to apply changes.');
    }
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}

// Run if called directly
if (process.argv[1]?.endsWith('configure.ts') || process.argv[1]?.endsWith('configure.js')) {
  main().catch(console.error);
}
