import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Check if path exists
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read file safely
 */
export async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Get latest session journal
 */
export async function getLatestJournal(journalDir: string): Promise<{ path: string; content: string } | null> {
  try {
    const files = await readdir(journalDir);
    const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'README.md').sort().reverse();
    if (mdFiles.length === 0) return null;

    const latestPath = join(journalDir, mdFiles[0]);
    const content = await readFile(latestPath, 'utf-8');
    return { path: latestPath, content };
  } catch {
    return null;
  }
}
