import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';

const execAsync = promisify(exec);

/**
 * Execute git command in zeos root
 */
export async function gitExec(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execAsync(`git ${command}`, {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return result;
  } catch (error: any) {
    // Git commands return non-zero for some valid operations
    if (error.stdout !== undefined) {
      return { stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
}

/**
 * Check if network is available by testing git remote
 */
export async function isNetworkAvailable(cwd: string): Promise<boolean> {
  try {
    await execAsync('git ls-remote --exit-code origin HEAD', {
      cwd,
      timeout: 5000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return true;
  } catch {
    return false;
  }
}

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
 * Parse git status output into structured format
 */
export function parseGitStatus(output: string): {
  modified: string[];
  staged: string[];
  untracked: string[];
  branch: string;
  ahead: number;
  behind: number;
} {
  const lines = output.split('\n').filter(Boolean);
  const modified: string[] = [];
  const staged: string[] = [];
  const untracked: string[] = [];
  let branch = 'unknown';
  let ahead = 0;
  let behind = 0;

  for (const line of lines) {
    // Branch info
    if (line.startsWith('## ')) {
      const branchMatch = line.match(/^## ([^\s.]+)/);
      if (branchMatch) branch = branchMatch[1];

      const aheadMatch = line.match(/ahead (\d+)/);
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);

      const behindMatch = line.match(/behind (\d+)/);
      if (behindMatch) behind = parseInt(behindMatch[1], 10);
      continue;
    }

    // File status (porcelain v1 format)
    if (line.length >= 3) {
      const index = line[0];
      const worktree = line[1];
      const file = line.slice(3);

      if (index !== ' ' && index !== '?') {
        staged.push(file);
      }
      if (worktree === 'M' || worktree === 'D') {
        modified.push(file);
      }
      if (index === '?' && worktree === '?') {
        untracked.push(file);
      }
    }
  }

  return { modified, staged, untracked, branch, ahead, behind };
}
