import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { parseResourceURI, type ZeOSConfig } from '@zeos/shared';
import { uriToPath, pathExists } from './utils.js';

export const FILESYSTEM_TOOLS: Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file from the zeos filesystem. Use zeos URIs (zeos://kernel/SOUL.md) or absolute paths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (zeos URI or absolute path)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the zeos filesystem. Creates parent directories if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (zeos URI or absolute path)',
        },
        content: {
          type: 'string',
          description: 'Content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a zeos path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path (zeos URI or absolute path)',
        },
        recursive: {
          type: 'boolean',
          description: 'List recursively (default: false)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_exists',
    description: 'Check if a file or directory exists.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (zeos URI or absolute path)',
        },
      },
      required: ['path'],
    },
  },
];

async function listFilesRecursive(dir: string, base: string = ''): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const subFiles = await listFilesRecursive(join(dir, entry.name), relativePath);
          files.push(...subFiles);
        }
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  } catch (error) {
    // Ignore errors
  }
  return files;
}



export async function handleFilesystemToolCall(name: string, args: any, config: ZeOSConfig): Promise<CallToolResult> {
  switch (name) {
    case 'read_file': {
      const pathArg = args?.path as string;
      if (!pathArg) {
        return { content: [{ type: 'text', text: 'Error: path is required' }], isError: true };
      }

      let filePath: string;
      if (pathArg.startsWith('zeos://')) {
        const parsed = parseResourceURI(pathArg);
        if (!parsed) {
          return { content: [{ type: 'text', text: `Error: Invalid URI ${pathArg}` }], isError: true };
        }
        filePath = uriToPath(parsed, config);
      } else {
        filePath = pathArg;
      }

      try {
        const content = await readFile(filePath, 'utf-8');
        return { content: [{ type: 'text', text: content }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: File not found ${filePath}` }], isError: true };
      }
    }

    case 'write_file': {
      const pathArg = args?.path as string;
      const contentArg = args?.content as string;

      if (!pathArg || contentArg === undefined) {
        return { content: [{ type: 'text', text: 'Error: path and content are required' }], isError: true };
      }

      let filePath: string;
      if (pathArg.startsWith('zeos://')) {
        const parsed = parseResourceURI(pathArg);
        if (!parsed) {
          return { content: [{ type: 'text', text: `Error: Invalid URI ${pathArg}` }], isError: true };
        }
        filePath = uriToPath(parsed, config);
      } else {
        filePath = pathArg;
      }

      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, contentArg, 'utf-8');
        return { content: [{ type: 'text', text: `Written ${contentArg.length} bytes to ${pathArg}` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error writing file: ${error}` }], isError: true };
      }
    }

    case 'list_directory': {
      const pathArg = args?.path as string;
      const recursive = args?.recursive as boolean || false;

      if (!pathArg) {
        return { content: [{ type: 'text', text: 'Error: path is required' }], isError: true };
      }

      let dirPath: string;
      if (pathArg.startsWith('zeos://')) {
        const parsed = parseResourceURI(pathArg);
        if (!parsed) {
          return { content: [{ type: 'text', text: `Error: Invalid URI ${pathArg}` }], isError: true };
        }
        dirPath = uriToPath(parsed, config);
      } else {
        dirPath = pathArg;
      }

      try {
        let files: string[];
        if (recursive) {
          files = await listFilesRecursive(dirPath);
        } else {
          const entries = await readdir(dirPath, { withFileTypes: true });
          files = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name);
        }
        return { content: [{ type: 'text', text: files.join('\n') || '(empty directory)' }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: Directory not found ${dirPath}` }], isError: true };
      }
    }

    case 'file_exists': {
      const pathArg = args?.path as string;
      if (!pathArg) {
        return { content: [{ type: 'text', text: 'Error: path is required' }], isError: true };
      }

      let filePath: string;
      if (pathArg.startsWith('zeos://')) {
        const parsed = parseResourceURI(pathArg);
        if (!parsed) {
          return { content: [{ type: 'text', text: `Error: Invalid URI ${pathArg}` }], isError: true };
        }
        filePath = uriToPath(parsed, config);
      } else {
        filePath = pathArg;
      }

      const exists = await pathExists(filePath);
      return { content: [{ type: 'text', text: exists ? 'true' : 'false' }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
