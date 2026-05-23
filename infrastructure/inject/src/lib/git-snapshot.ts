import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const EXEC_TIMEOUT_MS = 2000;

function gitSafe(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
  } catch {
    return "";
  }
}

export function getGitSnapshot(repoPath: string): string {
  if (!repoPath || !fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return "";
  }

  const branch = gitSafe(["branch", "--show-current"], repoPath) || "detached";
  const head = gitSafe(["rev-parse", "--short", "HEAD"], repoPath);
  const upstream = gitSafe(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoPath);
  const status = gitSafe(["status", "--short", "--branch"], repoPath);
  if (!head) return "";

  let output = "### Git Snapshot\n";
  output += `- Repo: ${repoPath}\n`;
  output += `- Branch: ${branch}\n`;
  output += `- HEAD: ${head}\n`;
  if (upstream) {
    output += `- Upstream: ${upstream}\n`;
  }
  output += `\n\`\`\`\n${status || "clean"}\n\`\`\``;
  return output;
}
