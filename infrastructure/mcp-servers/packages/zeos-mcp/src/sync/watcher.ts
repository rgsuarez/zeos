/**
 * File Watcher
 *
 * Watches for local file changes and queues them for sync.
 * Uses native fs.watch with debouncing to avoid excessive events.
 */

import { watch, type FSWatcher, type WatchEventType } from 'node:fs';
import { readFile, access, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ZeOSConfig } from '@zeos/mcp-shared';

export interface FileChangeEvent {
  type: 'create' | 'update' | 'delete';
  path: string;
  relativePath: string;
  timestamp: Date;
}

export interface WatcherOptions {
  config: ZeOSConfig;
  debounceMs?: number;
  ignorePatterns?: string[];
}

export class FileWatcher extends EventEmitter {
  private config: ZeOSConfig;
  private debounceMs: number;
  private ignorePatterns: RegExp[];
  private watchers: Map<string, FSWatcher> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;

  constructor(options: WatcherOptions) {
    super();
    this.config = options.config;
    this.debounceMs = options.debounceMs || 500;
    this.ignorePatterns = this.buildIgnorePatterns(options.ignorePatterns);
  }

  /**
   * Build regex patterns for ignored files
   */
  private buildIgnorePatterns(patterns?: string[]): RegExp[] {
    const defaultPatterns = [
      /node_modules/,
      /\.git\//,
      /\.zeos\/state\.db/,
      /\.zeos\/temp/,
      /dist\//,
      /\.DS_Store/,
      /\.log$/,
      /\.tmp$/
    ];

    const customPatterns = (patterns || []).map(p => new RegExp(p));
    return [...defaultPatterns, ...customPatterns];
  }

  /**
   * Check if path should be ignored
   */
  private shouldIgnore(path: string): boolean {
    return this.ignorePatterns.some(pattern => pattern.test(path));
  }

  /**
   * Start watching directories
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Watch key zeos directories
    const dirsToWatch = [
      'kernel',
      'profiles',
      'modules',
      'apps'
    ];

    for (const dir of dirsToWatch) {
      const fullPath = join(this.config.root, dir);
      this.watchDirectory(fullPath);
    }
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (!this.isRunning) return;

    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.isRunning = false;
  }

  /**
   * Watch a directory recursively
   */
  private watchDirectory(dirPath: string): void {
    try {
      const watcher = watch(dirPath, { recursive: true }, (eventType, filename) => {
        if (filename) {
          this.handleChange(eventType, join(dirPath, filename));
        }
      });

      watcher.on('error', (error) => {
        console.error(`Watch error for ${dirPath}:`, error);
      });

      this.watchers.set(dirPath, watcher);
    } catch (error) {
      // Directory might not exist yet
      console.error(`Could not watch ${dirPath}:`, error);
    }
  }

  /**
   * Handle a file change event with debouncing
   */
  private handleChange(eventType: WatchEventType, fullPath: string): void {
    if (this.shouldIgnore(fullPath)) return;

    // Clear existing debounce timer
    const existingTimer = this.debounceTimers.get(fullPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.processChange(fullPath);
      this.debounceTimers.delete(fullPath);
    }, this.debounceMs);

    this.debounceTimers.set(fullPath, timer);
  }

  /**
   * Process a file change after debounce
   */
  private async processChange(fullPath: string): Promise<void> {
    const relativePath = relative(this.config.root, fullPath);

    try {
      // Check if file exists
      await access(fullPath);

      // File exists - determine if create or update
      const stats = await stat(fullPath);

      // Simple heuristic: if file is very recent, might be create
      const ageMs = Date.now() - stats.mtimeMs;
      const type = ageMs < 1000 ? 'create' : 'update';

      const event: FileChangeEvent = {
        type,
        path: fullPath,
        relativePath,
        timestamp: new Date()
      };

      this.emit('change', event);
    } catch {
      // File doesn't exist - must be delete
      const event: FileChangeEvent = {
        type: 'delete',
        path: fullPath,
        relativePath,
        timestamp: new Date()
      };

      this.emit('change', event);
    }
  }

  /**
   * Get content of a watched file
   */
  async getFileContent(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      return null;
    }
  }
}
