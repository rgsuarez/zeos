#!/usr/bin/env node
/**
 * @zeos/shell-mcp
 *
 * MCP server for zeos command execution.
 * Provides /zeos, /snap, /end, /status commands as MCP tools.
 *
 * Tools: zeos_boot, zeos_checkpoint, zeos_end, zeos_status, zeos_project
 *
 * @packageDocumentation
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { type ZeOSConfig } from '@zeos/shared';

import { SHELL_TOOLS, handleShellToolCall } from './tools.js';
import { pathExists } from './utils.js';

export * from './tools.js';
export * from './utils.js';

// Default configuration
const DEFAULT_CONFIG: ZeOSConfig = {
  root: process.env.ZEOS_ROOT || join(homedir(), 'zeos'),
  profile: process.env.ZEOS_PROFILE || 'template',
  syncEnabled: process.env.ZEOS_SYNC !== 'false',
  syncInterval: parseInt(process.env.ZEOS_SYNC_INTERVAL || '60000', 10),
};

/**
 * Create zeos Shell MCP Server
 */
function createServer(config: ZeOSConfig) {
  const server = new Server(
    { name: 'zeos-shell-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: SHELL_TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleShellToolCall(name, args, config);
  });

  return server;
}

async function main() {
  if (import.meta.url === `file://${process.argv[1]}`) {
    const config = DEFAULT_CONFIG;

    // Validate zeos root exists
    if (!await pathExists(config.root)) {
      console.error(`zeos root not found: ${config.root}`);
      console.error('Set ZEOS_ROOT environment variable or create ~/zeos directory');
      process.exit(1);
    }

    const server = createServer(config);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`zeos Shell MCP server started (root: ${config.root}, profile: ${config.profile})`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

export { createServer };