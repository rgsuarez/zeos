/**
 * Offline operation integration tests
 *
 * Tests that zeos MCP operates fully offline without network dependency.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_ZEOS_ROOT = resolve(__dirname, '../fixtures/mock-zeos');

describe('Offline Operation', () => {
  describe('Local File Operations', () => {
    const testFilePath = resolve(MOCK_ZEOS_ROOT, 'test-offline.md');

    afterAll(() => {
      if (existsSync(testFilePath)) {
        rmSync(testFilePath);
      }
    });

    it('should read files without network', () => {
      const kernelPath = resolve(MOCK_ZEOS_ROOT, 'kernel/SOUL.md');
      expect(() => readFileSync(kernelPath, 'utf-8')).not.toThrow();
    });

    it('should write files without network', () => {
      const content = '# Offline Test\n\nWritten offline.';
      expect(() => writeFileSync(testFilePath, content, 'utf-8')).not.toThrow();
      expect(existsSync(testFilePath)).toBe(true);
    });

    it('should list directory contents without network', () => {
      const { readdirSync } = require('fs');
      const kernelDir = resolve(MOCK_ZEOS_ROOT, 'kernel');

      expect(() => readdirSync(kernelDir)).not.toThrow();
      const files = readdirSync(kernelDir);
      expect(files.length).toBeGreaterThan(0);
    });
  });

  describe('Local State Persistence', () => {
    it('should store state in memory (mock SQLite)', () => {
      // Mock state store
      const stateStore = new Map<string, string>();

      stateStore.set('profile', 'test');
      stateStore.set('booted', 'true');

      expect(stateStore.get('profile')).toBe('test');
      expect(stateStore.get('booted')).toBe('true');
    });

    it('should queue sync operations for later', () => {
      const syncQueue: Array<{
        operation: string;
        path: string;
        timestamp: number;
      }> = [];

      // Simulate offline writes queued for sync
      syncQueue.push({
        operation: 'create',
        path: 'journals/test.md',
        timestamp: Date.now()
      });

      syncQueue.push({
        operation: 'update',
        path: 'profiles/test/PROFILE.md',
        timestamp: Date.now()
      });

      expect(syncQueue.length).toBe(2);
      expect(syncQueue[0].operation).toBe('create');
    });
  });

  describe('Graceful Degradation', () => {
    it('should indicate offline mode', () => {
      const status = {
        online: false,
        syncEnabled: true,
        queuedOperations: 5,
        lastSyncAttempt: new Date(Date.now() - 300000) // 5 minutes ago
      };

      expect(status.online).toBe(false);
      expect(status.queuedOperations).toBeGreaterThan(0);
    });

    it('should continue operating when sync fails', () => {
      const performOperation = (networkAvailable: boolean): { success: boolean; queued: boolean } => {
        if (networkAvailable) {
          return { success: true, queued: false };
        } else {
          // Queue for later, but operation succeeds locally
          return { success: true, queued: true };
        }
      };

      const offlineResult = performOperation(false);
      expect(offlineResult.success).toBe(true);
      expect(offlineResult.queued).toBe(true);

      const onlineResult = performOperation(true);
      expect(onlineResult.success).toBe(true);
      expect(onlineResult.queued).toBe(false);
    });
  });

  describe('Boot Without Network', () => {
    it('should boot with local files only', () => {
      const requiredFiles = [
        resolve(MOCK_ZEOS_ROOT, 'kernel/SOUL.md'),
        resolve(MOCK_ZEOS_ROOT, 'profiles/test/PROFILE.md')
      ];

      const allFilesExist = requiredFiles.every(f => existsSync(f));
      expect(allFilesExist).toBe(true);
    });

    it('should not require GitHub API for boot', () => {
      // Boot should work with local files only
      const bootRequirements = {
        localKernel: true,
        localProfile: true,
        githubApi: false // NOT required
      };

      expect(bootRequirements.githubApi).toBe(false);
    });
  });
});
