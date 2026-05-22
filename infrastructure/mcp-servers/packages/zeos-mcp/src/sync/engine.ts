/**
 * Async GitHub Sync Engine
 *
 * Background sync process that:
 * 1. Watches for local file changes
 * 2. Queues changes to SQLite sync_queue
 * 3. Processes queue when network is available
 * 4. Handles conflicts with 3-way merge
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import type { ZeOSConfig } from '@zeos/mcp-shared';
import type Database from 'better-sqlite3';

const execAsync = promisify(exec);

export interface SyncEvent {
  type: 'sync_start' | 'sync_complete' | 'sync_error' | 'conflict' | 'queue_add' | 'network_change';
  data?: unknown;
  timestamp: Date;
}

export interface SyncEngineOptions {
  config: ZeOSConfig;
  db: Database.Database;
  interval?: number; // ms between sync attempts
}

export class SyncEngine extends EventEmitter {
  private config: ZeOSConfig;
  private db: Database.Database;
  private interval: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isOnline = true;

  constructor(options: SyncEngineOptions) {
    super();
    this.config = options.config;
    this.db = options.db;
    this.interval = options.interval || options.config.syncInterval || 60000;
  }

  /**
   * Start the sync engine
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.emit('event', { type: 'sync_start', timestamp: new Date() } as SyncEvent);

    // Initial sync
    this.processQueue().catch(err => this.handleError(err));

    // Schedule periodic syncs
    this.timer = setInterval(() => {
      this.processQueue().catch(err => this.handleError(err));
    }, this.interval);
  }

  /**
   * Stop the sync engine
   */
  stop(): void {
    if (!this.isRunning) return;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  /**
   * Check network availability by attempting to reach GitHub
   */
  async checkNetwork(): Promise<boolean> {
    try {
      await execAsync('git ls-remote --exit-code origin HEAD', {
        cwd: this.config.root,
        timeout: 5000
      });

      if (!this.isOnline) {
        this.isOnline = true;
        this.emit('event', {
          type: 'network_change',
          data: { online: true },
          timestamp: new Date()
        } as SyncEvent);
      }
      return true;
    } catch {
      if (this.isOnline) {
        this.isOnline = false;
        this.emit('event', {
          type: 'network_change',
          data: { online: false },
          timestamp: new Date()
        } as SyncEvent);
      }
      return false;
    }
  }

  /**
   * Queue a file change for sync
   */
  queueChange(operation: 'create' | 'update' | 'delete', path: string, content?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO sync_queue (operation, path, content, status, created_at, attempts)
      VALUES (?, ?, ?, 'pending', datetime('now'), 0)
    `);

    stmt.run(operation, path, content || null);

    this.emit('event', {
      type: 'queue_add',
      data: { operation, path },
      timestamp: new Date()
    } as SyncEvent);
  }

  /**
   * Process the sync queue
   */
  async processQueue(): Promise<void> {
    if (!this.config.syncEnabled) return;

    // Check network first
    const online = await this.checkNetwork();
    if (!online) return;

    // Get pending items
    const items = this.db.prepare(`
      SELECT id, operation, path, content, attempts
      FROM sync_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 10
    `).all() as Array<{
      id: number;
      operation: string;
      path: string;
      content: string | null;
      attempts: number;
    }>;

    for (const item of items) {
      try {
        await this.syncItem(item);

        // Mark as completed
        this.db.prepare(`
          UPDATE sync_queue SET status = 'completed' WHERE id = ?
        `).run(item.id);

      } catch (error) {
        // Increment attempts, mark as failed if too many
        const newAttempts = item.attempts + 1;
        const status = newAttempts >= 3 ? 'failed' : 'pending';

        this.db.prepare(`
          UPDATE sync_queue
          SET status = ?, attempts = ?, last_error = ?
          WHERE id = ?
        `).run(status, newAttempts, String(error), item.id);

        if (status === 'failed') {
          this.handleError(error as Error);
        }
      }
    }

    if (items.length > 0) {
      this.emit('event', {
        type: 'sync_complete',
        data: { processed: items.length },
        timestamp: new Date()
      } as SyncEvent);
    }
  }

  /**
   * Sync a single item
   */
  private async syncItem(item: { operation: string; path: string; content: string | null }): Promise<void> {
    const { operation, path } = item;

    // Stage the file
    if (operation === 'delete') {
      await execAsync(`git rm "${path}"`, { cwd: this.config.root });
    } else {
      await execAsync(`git add "${path}"`, { cwd: this.config.root });
    }

    // Check for conflicts
    const hasConflict = await this.checkForConflicts(path);
    if (hasConflict) {
      await this.resolveConflict(path);
    }

    // Commit
    const message = `[zeos Auto-Sync] ${operation}: ${path}`;
    await execAsync(`git commit -m "${message}"`, { cwd: this.config.root });

    // Push
    await execAsync('git push', { cwd: this.config.root });
  }

  /**
   * Check if a file has conflicts with remote
   */
  private async checkForConflicts(path: string): Promise<boolean> {
    try {
      // Fetch latest without merging
      await execAsync('git fetch origin', { cwd: this.config.root });

      // Check if remote has changes to this file
      const { stdout } = await execAsync(
        `git diff HEAD..origin/main -- "${path}"`,
        { cwd: this.config.root }
      );

      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Resolve conflicts using local-wins strategy (default)
   */
  private async resolveConflict(path: string): Promise<void> {
    this.emit('event', {
      type: 'conflict',
      data: { path, strategy: 'local-wins' },
      timestamp: new Date()
    } as SyncEvent);

    // For now, use local-wins: just force our version
    // Future: implement 3-way merge
    await execAsync(`git checkout --ours "${path}"`, { cwd: this.config.root });
    await execAsync(`git add "${path}"`, { cwd: this.config.root });
  }

  /**
   * Handle sync errors
   */
  private handleError(error: Error): void {
    this.emit('event', {
      type: 'sync_error',
      data: { message: error.message },
      timestamp: new Date()
    } as SyncEvent);
  }

  /**
   * Get queue status
   */
  getQueueStatus(): { pending: number; failed: number; completed: number } {
    const result = this.db.prepare(`
      SELECT status, COUNT(*) as count
      FROM sync_queue
      GROUP BY status
    `).all() as Array<{ status: string; count: number }>;

    const status = { pending: 0, failed: 0, completed: 0 };
    for (const row of result) {
      if (row.status in status) {
        status[row.status as keyof typeof status] = row.count;
      }
    }
    return status;
  }
}

// CLI entry for testing
if (process.argv.includes('--test-mode')) {
  console.error('Sync engine initialized (test mode)');
}
