/**
 * Interface contracts for MCP server communication
 */

import type { ZeOSConfig, SyncQueueItem } from './types.js';

/**
 * Filesystem MCP interface
 */
export interface IFilesystemMCP {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDirectory(path: string): Promise<string[]>;
  watchFile(path: string, callback: (event: 'change' | 'delete') => void): () => void;
}

/**
 * Git MCP interface
 */
export interface IGitMCP {
  gitStatus(): Promise<{ modified: string[]; staged: string[]; untracked: string[] }>;
  commit(message: string, files?: string[]): Promise<string>;
  push(): Promise<void>;
  pull(): Promise<void>;
  diff(file?: string): Promise<string>;
}

/**
 * Shell MCP interface (bang commands)
 */
export interface IShellMCP {
  boot(profile?: string): Promise<{ kernel: string; profile: string; session: string }>;
  checkpoint(note?: string): Promise<{ commit: string; delta: number }>;
  end(): Promise<{ journal: string; handoff: string }>;
  status(): Promise<{ profile: string; project?: string; sync: 'online' | 'offline' }>;
}

/**
 * SQLite MCP interface
 */
export interface ISQLiteMCP {
  queueSync(item: Omit<SyncQueueItem, 'id' | 'createdAt' | 'attempts'>): Promise<string>;
  processQueue(): Promise<{ processed: number; failed: number }>;
  getState<T>(key: string): Promise<T | null>;
  setState<T>(key: string, value: T): Promise<void>;
  clearQueue(status?: SyncQueueItem['status']): Promise<number>;
}

/**
 * Unified zeos MCP interface
 */
export interface IZeOSMCP extends IFilesystemMCP, IGitMCP, IShellMCP, ISQLiteMCP {
  config: ZeOSConfig;
  initialize(config: Partial<ZeOSConfig>): Promise<void>;
}
