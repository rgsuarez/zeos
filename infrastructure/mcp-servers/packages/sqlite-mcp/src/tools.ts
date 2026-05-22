import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { PreparedStatements } from './statements.js';

export const SQLITE_TOOLS: Tool[] = [
  {
    name: 'queue_sync',
    description: 'Add an operation to the sync queue for async GitHub push.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['create', 'update', 'delete'],
          description: 'Operation type',
        },
        path: {
          type: 'string',
          description: 'File path relative to repo root',
        },
        content: {
          type: 'string',
          description: 'File content (for create/update)',
        },
        priority: {
          type: 'number',
          description: 'Priority (higher = processed first, default: 0)',
        },
      },
      required: ['operation', 'path'],
    },
  },
  {
    name: 'get_queue',
    description: 'Get current sync queue status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'processing', 'failed', 'all'],
          description: 'Filter by status (default: all)',
        },
      },
    },
  },
  {
    name: 'clear_queue',
    description: 'Clear completed or failed items from sync queue.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['completed', 'failed'],
          description: 'Status to clear',
        },
      },
      required: ['status'],
    },
  },
  {
    name: 'get_state',
    description: 'Get a value from session state.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'State key',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'set_state',
    description: 'Set a value in session state.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'State key',
        },
        value: {
          description: 'Value to store (will be JSON serialized)',
        },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'create_session',
    description: 'Create a new session record.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: 'Profile ID',
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
      },
      required: ['profile'],
    },
  },
  {
    name: 'get_session',
    description: 'Get the current active session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'end_session',
    description: 'End the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to end',
        },
        status: {
          type: 'string',
          enum: ['ended', 'abandoned'],
          description: 'Final status (default: ended)',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'add_checkpoint',
    description: 'Record a checkpoint for the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID',
        },
        commit_sha: {
          type: 'string',
          description: 'Git commit SHA (optional)',
        },
        note: {
          type: 'string',
          description: 'Checkpoint note',
        },
        files_changed: {
          type: 'number',
          description: 'Number of files changed',
        },
      },
      required: ['session_id'],
    },
  },
];

export async function handleSqliteToolCall(name: string, args: any, stmts: PreparedStatements) {
  switch (name) {
    case 'queue_sync': {
      const operation = args?.operation as 'create' | 'update' | 'delete';
      const path = args?.path as string;
      const content = args?.content as string | undefined;
      const priority = (args?.priority as number) || 0;

      if (!operation || !path) {
        return { content: [{ type: 'text', text: 'Error: operation and path are required' }], isError: true };
      }

      const id = randomUUID();
      stmts.insertQueue.run({
        id,
        operation,
        path,
        content: content || null,
        sha: null,
        status: 'pending',
        priority,
      });

      const count = (stmts.countQueue.get({ status: 'pending' }) as { count: number }).count;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ queued: true, id, pending_count: count }),
        }],
      };
    }

    case 'get_queue': {
      const status = args?.status as string || 'all';

      let result: any;
      if (status === 'all') {
        result = {
          pending: stmts.getQueue.all({ status: 'pending' }),
          processing: stmts.getQueue.all({ status: 'processing' }),
          failed: stmts.getQueue.all({ status: 'failed' }),
        };
      } else {
        result = stmts.getQueue.all({ status });
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    }

    case 'clear_queue': {
      const status = args?.status as 'completed' | 'failed';

      if (!status) {
        return { content: [{ type: 'text', text: 'Error: status is required' }], isError: true };
      }

      const result = stmts.clearQueue.run({ status });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ cleared: result.changes }),
        }],
      };
    }

    case 'get_state': {
      const key = args?.key as string;

      if (!key) {
        return { content: [{ type: 'text', text: 'Error: key is required' }], isError: true };
      }

      const row = stmts.getState.get({ key }) as { value: string } | undefined;
      let value = null;
      if (row) {
        try {
          value = JSON.parse(row.value);
        } catch {
          value = row.value;
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ key, value }),
        }],
      };
    }

    case 'set_state': {
      const key = args?.key as string;
      const value = args?.value;

      if (!key || value === undefined) {
        return { content: [{ type: 'text', text: 'Error: key and value are required' }], isError: true };
      }

      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      stmts.setState.run({ key, value: serialized });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ key, stored: true }),
        }],
      };
    }

    case 'create_session': {
      const profile = args?.profile as string;
      const project = args?.project as string | undefined;

      if (!profile) {
        return { content: [{ type: 'text', text: 'Error: profile is required' }], isError: true };
      }

      // Check for existing active session
      const existing = stmts.getActiveSession.get();
      if (existing) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'ACTIVE_SESSION_EXISTS',
              existing_session: existing,
            }),
          }],
          isError: true,
        };
      }

      const session_id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
      stmts.createSession.run({
        session_id,
        profile,
        project: project || null,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ session_id, profile, project: project || null }),
        }],
      };
    }

    case 'get_session': {
      const session = stmts.getActiveSession.get();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(session || { active: false }),
        }],
      };
    }

    case 'end_session': {
      const session_id = args?.session_id as string;
      const status = (args?.status as 'ended' | 'abandoned') || 'ended';

      if (!session_id) {
        return { content: [{ type: 'text', text: 'Error: session_id is required' }], isError: true };
      }

      stmts.endSession.run({ session_id, status });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ session_id, status }),
        }],
      };
    }

    case 'add_checkpoint': {
      const session_id = args?.session_id as string;
      const commit_sha = args?.commit_sha as string | undefined;
      const note = args?.note as string | undefined;
      const files_changed = (args?.files_changed as number) || 0;

      if (!session_id) {
        return { content: [{ type: 'text', text: 'Error: session_id is required' }], isError: true };
      }

      const id = randomUUID();
      stmts.addCheckpoint.run({
        id,
        session_id,
        commit_sha: commit_sha || null,
        note: note || null,
        files_changed,
      });

      stmts.updateSessionCheckpoint.run({ session_id });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ id, session_id, commit_sha }),
        }],
      };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}
