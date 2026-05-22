import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { gitExec, isNetworkAvailable, parseGitStatus, pathExists } from './utils.js';
import { ZeOSError } from '@zeos/shared';

export const GIT_TOOLS: Tool[] = [
  {
    name: 'git_status',
    description: 'Get current git status including modified, staged, and untracked files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository path (default: ZEOS_ROOT)',
        },
      },
    },
  },
  {
    name: 'git_commit',
    description: 'Create a git commit with the specified message. Optionally stage specific files first.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to stage before commit (optional, defaults to all changed)',
        },
        path: {
          type: 'string',
          description: 'Repository path (default: ZEOS_ROOT)',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_push',
    description: 'Push commits to remote. Returns error if offline.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository path (default: ZEOS_ROOT)',
        },
        force: {
          type: 'boolean',
          description: 'Force push (dangerous, use with caution)',
        },
      },
    },
  },
  {
    name: 'git_pull',
    description: 'Pull changes from remote. Returns error if offline.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository path (default: ZEOS_ROOT)',
        },
        rebase: {
          type: 'boolean',
          description: 'Use rebase instead of merge',
        },
      },
    },
  },
  {
    name: 'git_diff',
    description: 'Show diff of changes. Can show staged, unstaged, or specific file diff.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Specific file to diff (optional)',
        },
        staged: {
          type: 'boolean',
          description: 'Show staged changes only',
        },
        path: {
          type: 'string',
          description: 'Repository path (default: ZEOS_ROOT)',
        },
      },
    },
  },
  {
    name: 'git_log',
    description: 'Show recent commit history.',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of commits to show (default: 10)',
        },
        oneline: {
          type: 'boolean',
          description: 'Use oneline format (default: true)',
        },
        path: {
          type: 'string',
          description: 'Repository path (default: ZEOS_ROOT)',
        },
      },
    },
  },
  {
    name: 'git_add',
    description: 'Stage files for commit.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to stage (use [" . "] for all)',
        },
        path: {
          type: 'string',
          description: 'Repository path (default: ZEOS_ROOT)',
        },
      },
      required: ['files'],
    },
  },
];

export async function handleGitToolCall(name: string, args: any, config: { root: string }) {
  const repoPath = (args?.path as string) || config.root;

  // Validate repo exists
  if (!await pathExists(join(repoPath, '.git'))) {
    return {
      content: [{ type: 'text', text: `Error: Not a git repository: ${repoPath}` }],
      isError: true,
    };
  }

  switch (name) {
    case 'git_status': {
      try {
        const { stdout } = await gitExec('status --porcelain=v1 --branch', repoPath);
        const status = parseGitStatus(stdout);
        return {
          content: [{ 
            type: 'text',
            text: JSON.stringify(status, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error}` }], isError: true };
      }
    }

    case 'git_commit': {
      const message = args?.message as string;
      const files = args?.files as string[] | undefined;

      if (!message) {
        return { content: [{ type: 'text', text: 'Error: message is required' }], isError: true };
      }

      try {
        // Stage files if specified, otherwise stage all
        if (files && files.length > 0) {
          await gitExec(`add ${files.map(f => `"${f}"`).join(' ')}`, repoPath);
        } else {
          await gitExec('add -A', repoPath);
        }

        // Check if there's anything to commit
        const { stdout: statusOut } = await gitExec('status --porcelain', repoPath);
        if (!statusOut.trim()) {
          return { content: [{ type: 'text', text: 'Nothing to commit, working tree clean' }] };
        }

        // Create commit
        const { stdout } = await gitExec(`commit -m "${message.replace(/