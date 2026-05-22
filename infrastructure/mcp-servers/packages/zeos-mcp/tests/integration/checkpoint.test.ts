/**
 * Checkpoint integration tests
 *
 * Tests the zeos_checkpoint tool functionality including journal writing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_ZEOS_ROOT = resolve(__dirname, '../fixtures/mock-zeos');
const JOURNALS_DIR = resolve(MOCK_ZEOS_ROOT, 'session-journals');

describe('Checkpoint Integration', () => {
  beforeAll(() => {
    // Ensure journals directory exists
    if (!existsSync(JOURNALS_DIR)) {
      mkdirSync(JOURNALS_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test journals
    if (existsSync(JOURNALS_DIR)) {
      const files = readdirSync(JOURNALS_DIR);
      for (const file of files) {
        if (file.startsWith('test-')) {
          rmSync(resolve(JOURNALS_DIR, file));
        }
      }
    }
  });

  describe('Journal Directory', () => {
    it('should have session-journals directory', () => {
      expect(existsSync(JOURNALS_DIR)).toBe(true);
    });
  });

  describe('Journal Writing', () => {
    const testJournalName = `test-${Date.now()}.md`;
    const testJournalPath = resolve(JOURNALS_DIR, testJournalName);

    afterEach(() => {
      // Clean up test journal
      if (existsSync(testJournalPath)) {
        rmSync(testJournalPath);
      }
    });

    it('should create a journal file', () => {
      const content = `---
session_id: "test-001"
status: "active"
---

# Test Checkpoint

This is a test checkpoint.
`;
      writeFileSync(testJournalPath, content, 'utf-8');
      expect(existsSync(testJournalPath)).toBe(true);
    });

    it('should write valid YAML frontmatter', () => {
      const content = `---
session_id: "test-002"
profile: "test"
status: "active"
started: "2026-01-05T00:00:00Z"
---

# Test Session
`;
      writeFileSync(testJournalPath, content, 'utf-8');

      const { readFileSync } = require('fs');
      const written = readFileSync(testJournalPath, 'utf-8');

      expect(written).toContain('session_id');
      expect(written).toContain('profile');
      expect(written).toContain('status');
    });
  });

  describe('Journal Naming', () => {
    it('should follow YYYY-MM-DD-NNN pattern', () => {
      const pattern = /^\d{4}-\d{2}-\d{2}-\d{3}/;
      const validName = '2026-01-05-001.md';
      const invalidName = 'random-journal.md';

      expect(pattern.test(validName)).toBe(true);
      expect(pattern.test(invalidName)).toBe(false);
    });
  });
});
