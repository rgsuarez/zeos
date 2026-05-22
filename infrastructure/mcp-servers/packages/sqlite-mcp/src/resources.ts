import { Resource } from '@modelcontextprotocol/sdk/types.js';
import { PreparedStatements } from './statements.js';
import type { SyncQueueItem } from '@zeos/shared';

export const SQLITE_RESOURCES: Resource[] = [
  {
    uri: 'zeos://state/sync-queue',
    name: 'Sync Queue',
    mimeType: 'application/json',
    description: 'Pending sync operations queue',
  },
  {
    uri: 'zeos://state/session',
    name: 'Active Session',
    mimeType: 'application/json',
    description: 'Current session state',
  },
  {
    uri: 'zeos://state/all',
    name: 'All State',
    mimeType: 'application/json',
    description: 'All session state key-value pairs',
  },
];

export async function listSqliteResources(): Promise<Resource[]> {
  return SQLITE_RESOURCES;
}

export async function readSqliteResource(uri: string, stmts: PreparedStatements) {
  switch (uri) {
    case 'zeos://state/sync-queue': {
      const pending = stmts.getQueue.all({ status: 'pending' }) as SyncQueueItem[];
      const processing = stmts.getQueue.all({ status: 'processing' }) as SyncQueueItem[];
      const failed = stmts.getQueue.all({ status: 'failed' }) as SyncQueueItem[];

      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ pending, processing, failed }, null, 2),
        }],
      };
    }

    case 'zeos://state/session': {
      const session = stmts.getActiveSession.get();
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(session || null, null, 2),
        }],
      };
    }

    case 'zeos://state/all': {
      const rows = stmts.getAllState.all() as { key: string; value: string }[];
      const state: Record<string, any> = {};
      for (const row of rows) {
        try {
          state[row.key] = JSON.parse(row.value);
        } catch {
          state[row.key] = row.value;
        }
      }
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(state, null, 2),
        }],
      };
    }

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}
