/**
 * Core types for zeos MCP infrastructure
 */

/**
 * zeos configuration for local-first operation
 */
export interface ZeOSConfig {
  /** Root directory for zeos installation (e.g., ~/zeos) */
  root: string;
  /** Active profile identifier */
  profile: string;
  /** Enable GitHub sync */
  syncEnabled: boolean;
  /** Sync interval in milliseconds */
  syncInterval: number;
  /** GitHub remote URL */
  remoteUrl?: string;
}

/**
 * Sync queue item for offline operations
 */
export interface SyncQueueItem {
  id: string;
  operation: 'create' | 'update' | 'delete';
  path: string;
  content?: string;
  sha?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  attempts: number;
  lastError?: string;
}

/**
 * Resource URI with zeos:// protocol
 */
export interface ResourceURI {
  protocol: 'zeos';
  type: 'kernel' | 'profile' | 'module' | 'app' | 'session' | 'state';
  path: string;
}

/**
 * Parse a zeos:// URI
 */
export function parseResourceURI(uri: string): ResourceURI | null {
  const match = uri.match(/^zeos:\/\/(\w+)\/(.+)$/);
  if (!match) return null;
  
  const [, type, path] = match;
  if (!['kernel', 'profile', 'module', 'app', 'session', 'state'].includes(type)) {
    return null;
  }
  
  return {
    protocol: 'zeos',
    type: type as ResourceURI['type'],
    path
  };
}
