#!/usr/bin/env node
/**
 * @zeos/filesystem-mcp
 *
 * MCP server for zeos filesystem operations.
 * Provides local file read/write for instant zeos boot and checkpoints.
 *
 * Resources: zeos://kernel/*, zeos://profile/*, zeos://module/*, zeos://app/*
 * Tools: read_file, write_file, list_directory, file_exists
 *
 * @packageDocumentation
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { type ZeOSConfig } from '@zeos/shared';

// Import refactored modules
import { FILESYSTEM_TOOLS, handleFilesystemToolCall } from './tools.js';
import { listFilesystemResources, readFilesystemResource } from './resources.js';
import { pathExists } from './utils.js';

export * from './tools.js';
export * from './resources.js';
export * from './utils.js';

// Default configuration
const DEFAULT_CONFIG: ZeOSConfig = {
  root: process.env.ZEOS_ROOT || join(homedir(), 'zeos'),
  profile: process.env.ZEOS_PROFILE || 'template',
  syncEnabled: process.env.ZEOS_SYNC !== 'false',
  syncInterval: parseInt(process.env.ZEOS_SYNC_INTERVAL || '60000', 10),
};

/**
 * Create zeos Filesystem MCP Server
 */
export function createServer(config: ZeOSConfig) {
  const server = new Server(
    { name: 'zeos-filesystem-mcp', version: '1.0.0' },
    {
      capabilities: {
        resources: { listChanged: true },
        tools: {}
      }
    }
  );

  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = await listFilesystemResources(config);
    return { resources };
  });

  // Read resource content
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const resource = await readFilesystemResource(uri, config);
    return {
      contents: [resource],
    };
  });

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: FILESYSTEM_TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleFilesystemToolCall(name, args, config);
  });

  return server;
}

async function main() {
  // Only run if called directly
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
    console.error(`zeos Filesystem MCP server started (root: ${config.root}, profile: ${config.profile})`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
