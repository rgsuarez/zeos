#!/usr/bin/env node
/**
 * @zeos/sqlite-mcp
 *
 * MCP server for zeos local state and sync queue.
 * Provides persistent state management for offline continuity.
 *
 * Resources: zeos://state/sync-queue, zeos://state/session
 * Tools: queue_sync, process_queue, get_state, set_state, clear_queue,
 *        get_session, create_session, add_checkpoint
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
import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, access } from 'node:fs/promises';
import { runMigrations } from './migrator.js';

import { getPreparedStatements } from './statements.js';
import { SQLITE_TOOLS, handleSqliteToolCall } from './tools.js';
import { listSqliteResources, readSqliteResource } from './resources.js';

export * from './tools.js';
export * from './resources.js';
export * from './statements.js';
export * from './migrator.js';

// Default configuration
const DEFAULT_CONFIG = {
  root: process.env.ZEOS_ROOT || join(homedir(), 'zeos'),
  dbPath: process.env.ZEOS_DB || join(homedir(), '.zeos', 'state.db'),
};

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
 * Create zeos SQLite MCP Server
 */
function createServer(config: typeof DEFAULT_CONFIG, db: Database.Database) {
  const server = new Server(
    { name: 'zeos-sqlite-mcp', version: '1.0.0' },
    {
      capabilities: {
        resources: {},
        tools: {}
      }
    }
  );

  const stmts = getPreparedStatements(db);

  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: await listSqliteResources() };
  });

  // Read resource content
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    return readSqliteResource(uri, stmts);
  });

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: SQLITE_TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleSqliteToolCall(name, args, stmts);
  });

  return server;
}

async function main() {
  if (import.meta.url === `file://${process.argv[1]}`) {
    const config = DEFAULT_CONFIG;

    // Ensure database directory exists
    const dbDir = dirname(config.dbPath);
    if (!await pathExists(dbDir)) {
      await mkdir(dbDir, { recursive: true });
    }

    // Run migrations
    console.error(`Initializing database: ${config.dbPath}`);
    runMigrations(config.dbPath);

    // Open database
    const db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const server = createServer(config, db);
    const transport = new StdioServerTransport();

    // Cleanup on exit
    process.on('SIGINT', () => {
      db.close();
      process.exit(0);
    });

    await server.connect(transport);
    console.error(`zeos SQLite MCP server started (db: ${config.dbPath})`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

export { createServer };