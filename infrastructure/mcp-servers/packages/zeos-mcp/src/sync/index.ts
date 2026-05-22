/**
 * Sync Module Exports
 */

export { SyncEngine, type SyncEvent, type SyncEngineOptions } from './engine.js';
export { FileWatcher, type FileChangeEvent, type WatcherOptions } from './watcher.js';
export {
  resolveConflict,
  getBaseContent,
  hasConflicts,
  type ConflictStrategy,
  type ConflictInfo,
  type ConflictResult
} from './conflict-resolver.js';
