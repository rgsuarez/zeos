/**
 * Conflict Resolver
 *
 * Implements 3-way merge strategy for sync conflicts.
 * Strategies:
 * - local-wins: Always use local version (default)
 * - remote-wins: Always use remote version
 * - manual: Create conflict markers for human resolution
 * - auto-merge: Attempt automatic 3-way merge
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const execAsync = promisify(exec);

export type ConflictStrategy = 'local-wins' | 'remote-wins' | 'manual' | 'auto-merge';

export interface ConflictInfo {
  path: string;
  localContent: string;
  remoteContent: string;
  baseContent?: string;
  strategy: ConflictStrategy;
}

export interface ConflictResult {
  resolved: boolean;
  content: string;
  strategy: ConflictStrategy;
  needsManualReview: boolean;
}

/**
 * Resolve a file conflict
 */
export async function resolveConflict(
  info: ConflictInfo,
  repoRoot: string
): Promise<ConflictResult> {
  const { path, localContent, remoteContent, baseContent, strategy } = info;

  switch (strategy) {
    case 'local-wins':
      return {
        resolved: true,
        content: localContent,
        strategy,
        needsManualReview: false
      };

    case 'remote-wins':
      return {
        resolved: true,
        content: remoteContent,
        strategy,
        needsManualReview: false
      };

    case 'manual':
      return createManualConflict(path, localContent, remoteContent, baseContent);

    case 'auto-merge':
      return attemptAutoMerge(path, localContent, remoteContent, baseContent, repoRoot);

    default:
      // Default to local-wins
      return {
        resolved: true,
        content: localContent,
        strategy: 'local-wins',
        needsManualReview: false
      };
  }
}

/**
 * Create manual conflict markers
 */
function createManualConflict(
  path: string,
  localContent: string,
  remoteContent: string,
  _baseContent?: string
): ConflictResult {
  const conflictContent = `<<<<<<< LOCAL (your changes)
${localContent}
=======
${remoteContent}
>>>>>>> REMOTE (incoming changes)

<!-- CONFLICT in ${path} -->
<!-- Resolve by keeping the version you want and deleting this block -->
`;

  return {
    resolved: false,
    content: conflictContent,
    strategy: 'manual',
    needsManualReview: true
  };
}

/**
 * Attempt automatic 3-way merge using git merge-file
 */
async function attemptAutoMerge(
  path: string,
  localContent: string,
  remoteContent: string,
  baseContent: string | undefined,
  repoRoot: string
): Promise<ConflictResult> {
  if (!baseContent) {
    // Without base, fall back to local-wins
    return {
      resolved: true,
      content: localContent,
      strategy: 'local-wins',
      needsManualReview: false
    };
  }

  try {
    // Write temp files for git merge-file
    const tempDir = join(repoRoot, '.zeos', 'temp');
    const localFile = join(tempDir, 'local');
    const baseFile = join(tempDir, 'base');
    const remoteFile = join(tempDir, 'remote');

    await writeFile(localFile, localContent);
    await writeFile(baseFile, baseContent);
    await writeFile(remoteFile, remoteContent);

    // Run git merge-file (modifies local file in place)
    try {
      await execAsync(`git merge-file "${localFile}" "${baseFile}" "${remoteFile}"`, {
        cwd: repoRoot
      });

      // Success - no conflicts
      const mergedContent = await readFile(localFile, 'utf-8');
      return {
        resolved: true,
        content: mergedContent,
        strategy: 'auto-merge',
        needsManualReview: false
      };
    } catch (mergeError) {
      // git merge-file returns non-zero on conflicts
      const mergedContent = await readFile(localFile, 'utf-8');

      // Check if it contains conflict markers
      if (mergedContent.includes('<<<<<<<')) {
        return {
          resolved: false,
          content: mergedContent,
          strategy: 'auto-merge',
          needsManualReview: true
        };
      }

      return {
        resolved: true,
        content: mergedContent,
        strategy: 'auto-merge',
        needsManualReview: false
      };
    }
  } catch {
    // Fall back to local-wins on any error
    return {
      resolved: true,
      content: localContent,
      strategy: 'local-wins',
      needsManualReview: false
    };
  }
}

/**
 * Get base content for 3-way merge (common ancestor)
 */
export async function getBaseContent(
  path: string,
  repoRoot: string
): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(
      `git show :1:"${path}" 2>/dev/null || git show HEAD~1:"${path}" 2>/dev/null`,
      { cwd: repoRoot }
    );
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * Detect if file has conflicts
 */
export async function hasConflicts(
  path: string,
  repoRoot: string
): Promise<boolean> {
  try {
    // Check git status for unmerged paths
    const { stdout } = await execAsync(`git status --porcelain "${path}"`, {
      cwd: repoRoot
    });

    // U = unmerged
    return stdout.startsWith('U') || stdout.includes('UU');
  } catch {
    return false;
  }
}
