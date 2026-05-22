import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  Tool,
  Resource
} from '@modelcontextprotocol/sdk/types.js';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, access } from 'node:fs/promises';
import Database from 'better-sqlite3';

// Sub-servers
import { 
  FILESYSTEM_TOOLS, 
  handleFilesystemToolCall, 
  listFilesystemResources, 
  readFilesystemResource 
} from '@zeos/filesystem-mcp';

import { 
  GIT_TOOLS, 
  handleGitToolCall 
} from '@zeos/git-mcp';

import { 
  SHELL_TOOLS, 
  handleShellToolCall 
} from '@zeos/shell-mcp';

import {
  SQLITE_TOOLS,
  handleSqliteToolCall,
  listSqliteResources,
  readSqliteResource,
  getPreparedStatements,
  runMigrations
} from '@zeos/sqlite-mcp';

import { ZEOS_PROMPTS } from './prompts.js';
import type { ZeOSConfig } from '@zeos/mcp-shared';

// Helper to check path existence
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function createUnifiedServer(config: ZeOSConfig) {
  // 1. Initialize State Persistence (SQLite)
  const dbPath = process.env.ZEOS_DB || join(config.root, '.zeos', 'state.db');
  const dbDir = dirname(dbPath);
  
  if (!await pathExists(dbDir)) {
    await mkdir(dbDir, { recursive: true });
  }

  // Run migrations
  try {
    // We need to resolve the path to the migrations folder inside the sqlite-mcp package
    // Since we import runMigrations, it handles finding the files relative to itself
    // BUT runMigrations takes dbPath
    runMigrations(dbPath);
  } catch (error) {
    console.error('Migration warning:', error);
    // Proceeding, hoping DB is usable or already set up
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  const stmts = getPreparedStatements(db);

  // 2. Create Server Instance
  const server = new Server(
    { name: 'zeos-mcp-server', version: '1.0.0' },
    {
      capabilities: {
        resources: { listChanged: true },
        tools: {},
        prompts: { listChanged: true }
      }
    }
  );

  // 3. Register Resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const fsResources = await listFilesystemResources(config);
    const sqliteResources = await listSqliteResources();
    
    return {
      resources: [...fsResources, ...sqliteResources]
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    
    if (uri.startsWith('zeos://state/')) {
      return readSqliteResource(uri, stmts);
    } else {
      // Default to filesystem for other zeos:// URIs
      return readFilesystemResource(uri, config);
    }
  });

  // 4. Register Tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        ...FILESYSTEM_TOOLS,
        ...GIT_TOOLS,
        ...SHELL_TOOLS,
        ...SQLITE_TOOLS
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Route to appropriate handler based on tool name prefixes or known lists
    // Optimization: Check sets/maps could be faster, but array search is fine for <100 tools

    // Filesystem Tools
    if (FILESYSTEM_TOOLS.some(t => t.name === name)) {
      return handleFilesystemToolCall(name, args, config);
    }

    // Git Tools
    if (GIT_TOOLS.some(t => t.name === name)) {
      return handleGitToolCall(name, args, { root: config.root });
    }

    // Shell Tools
    if (SHELL_TOOLS.some(t => t.name === name)) {
      return handleShellToolCall(name, args, config);
    }

    // SQLite Tools
    if (SQLITE_TOOLS.some(t => t.name === name)) {
      return handleSqliteToolCall(name, args, stmts);
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  // 5. Register Prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: ZEOS_PROMPTS };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    if (name === 'zeos_boot') {
        const profile = args?.profile || config.profile;
        return {
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `/zeos ${profile}`
                    }
                }
            ]
        };
    }

    if (name === 'zeos_handoff') {
        return {
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `/end`
                    }
                }
            ]
        };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  return { server, db };
}
