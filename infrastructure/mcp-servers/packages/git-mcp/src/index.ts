#!/usr/bin/env node
/**
 * @zeos/git-mcp
 *
 * MCP server for zeos git operations with offline queue.
 * Provides version control operations without GitHub API round-trips.
 *
 * Tools: git_status, git_commit, git_push, git_pull, git_diff, git_log
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

import { GIT_TOOLS, handleGitToolCall } from './tools.js';
import { pathExists } from './utils.js';

export * from './tools.js';
export * from './utils.js';

// Default configuration
const DEFAULT_CONFIG = {
  root: process.env.ZEOS_ROOT || join(homedir(), 'zeos'),
  profile: process.env.ZEOS_PROFILE || 'template',
};

/**
 * Create zeos Git MCP Server
 */
function createServer(config: typeof DEFAULT_CONFIG) {
  const server = new Server(
    { name: 'zeos-git-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: GIT_TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleGitToolCall(name, args, config);
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
    console.error(`zeos Git MCP server started (root: ${config.root})`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

export { createServer };