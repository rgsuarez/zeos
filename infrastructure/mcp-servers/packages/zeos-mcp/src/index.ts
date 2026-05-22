#!/usr/bin/env node
/**
 * @zeos/mcp-server
 * 
 * Unified MCP server for zeos.
 * Combines filesystem, git, shell, and sqlite capabilities
 * for local-first operation with async GitHub sync.
 * 
 * @packageDocumentation
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createUnifiedServer } from './orchestrator.js';
import { type ZeOSConfig } from '@zeos/mcp-shared';

// Default configuration
const DEFAULT_CONFIG: ZeOSConfig = {
  root: process.env.ZEOS_ROOT || join(homedir(), 'zeos'),
  profile: process.env.ZEOS_PROFILE || 'template',
  syncEnabled: process.env.ZEOS_SYNC !== 'false',
  syncInterval: parseInt(process.env.ZEOS_SYNC_INTERVAL || '60000', 10),
};

async function main() {
  const config = DEFAULT_CONFIG;

  try {
    const { server, db } = await createUnifiedServer(config);
    const transport = new StdioServerTransport();
    
    // Cleanup on exit
    process.on('SIGINT', () => {
      db.close();
      process.exit(0);
    });

    await server.connect(transport);
    console.error(`zeos Unified MCP server started (root: ${config.root}, profile: ${config.profile})`);
  } catch (error) {
    console.error('Fatal error starting zeos MCP server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled exception:', error);
  process.exit(1);
});