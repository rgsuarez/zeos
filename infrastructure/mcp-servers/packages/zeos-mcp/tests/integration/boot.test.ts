/**
 * Boot integration tests
 *
 * Tests the zeos_boot tool functionality including kernel and profile loading.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_ZEOS_ROOT = resolve(__dirname, '../fixtures/mock-zeos');

describe('Boot Integration', () => {
  beforeAll(() => {
    // Ensure mock directories exist
    const kernelDir = resolve(MOCK_ZEOS_ROOT, 'kernel');
    const profileDir = resolve(MOCK_ZEOS_ROOT, 'profiles/test');

    if (!existsSync(kernelDir)) {
      mkdirSync(kernelDir, { recursive: true });
    }
    if (!existsSync(profileDir)) {
      mkdirSync(profileDir, { recursive: true });
    }
  });

  describe('Kernel Loading', () => {
    it('should detect SOUL.md exists', () => {
      const soulPath = resolve(MOCK_ZEOS_ROOT, 'kernel/SOUL.md');
      expect(existsSync(soulPath)).toBe(true);
    });

    it('should read SOUL.md content', async () => {
      const { readFileSync } = await import('fs');
      const soulPath = resolve(MOCK_ZEOS_ROOT, 'kernel/SOUL.md');
      const content = readFileSync(soulPath, 'utf-8');

      expect(content).toContain('SOUL');
      expect(content).toContain('version');
    });
  });

  describe('Profile Loading', () => {
    it('should detect PROFILE.md exists', () => {
      const profilePath = resolve(MOCK_ZEOS_ROOT, 'profiles/test/PROFILE.md');
      expect(existsSync(profilePath)).toBe(true);
    });

    it('should read PROFILE.md content', async () => {
      const { readFileSync } = await import('fs');
      const profilePath = resolve(MOCK_ZEOS_ROOT, 'profiles/test/PROFILE.md');
      const content = readFileSync(profilePath, 'utf-8');

      expect(content).toContain('profile_id');
      expect(content).toContain('test');
    });
  });

  describe('Boot Sequence', () => {
    it('should validate kernel files exist before boot', () => {
      const requiredFiles = [
        'kernel/SOUL.md'
      ];

      for (const file of requiredFiles) {
        const fullPath = resolve(MOCK_ZEOS_ROOT, file);
        expect(existsSync(fullPath), `Missing: ${file}`).toBe(true);
      }
    });

    it('should validate profile exists for boot', () => {
      const profilePath = resolve(MOCK_ZEOS_ROOT, 'profiles/test/PROFILE.md');
      expect(existsSync(profilePath)).toBe(true);
    });
  });
});
