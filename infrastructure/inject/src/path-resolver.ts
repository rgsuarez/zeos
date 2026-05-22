import * as path from "path";
import * as os from "os";
import * as fs from "fs";

/**
 * Zeos root paths.
 *
 * Per-project operator state lives INSIDE the zeos repo, gitignored:
 *   ~/projects/zeos/souls/<app_id>/SOUL.md            ← project identity (WHO)
 *   ~/projects/zeos/journals/<app_id>/                ← session journals
 *   ~/projects/zeos/memory/<app_id>/MEMORY.md         ← curated mid-term memory
 *
 * All three are gitignored in the zeos repo, so they never leave the operator's
 * machine unless explicitly synced. This keeps project repos themselves 100%
 * clean — no .git/info/exclude config required, no risk of leaking personal
 * session context or operator-curated identity into a teammate's PR.
 *
 * The project's own CLAUDE.md (operations doctrine — HOW it builds, deploys,
 * conventions) lives in the project repo at <local_path>/CLAUDE.md. It's
 * optional: operators decide per-project whether the team has agreed on a
 * shared CLAUDE.md. When absent, the boot payload just notes that.
 *
 * The split: SOUL = WHO the project is (identity, mission, constraints) —
 * rarely changes. CLAUDE.md = HOW the project operates (build commands,
 * file paths, conventions) — changes weekly. Two files, two semantic loads,
 * two change cadences.
 */
export const ZEOS_ROOT = "~/projects/zeos";
export const ZEOS_SOULS_ROOT = `${ZEOS_ROOT}/souls`;
export const ZEOS_JOURNALS_ROOT = `${ZEOS_ROOT}/journals`;
export const ZEOS_MEMORY_ROOT = `${ZEOS_ROOT}/memory`;

/**
 * Legacy fallback root for apps registered before v1.2.0 that explicitly
 * point their `local_path` somewhere other than ~/projects/<app_id>/.
 * Kept for back-compat; new apps don't use it.
 */
export const ZEOS_APPS_ROOT = "~/projects/zeos-apps";

export interface PathResolverApp {
  app_id: string;
  local_path: string;
  /** @deprecated as of v1.2.0; journals always live in ZEOS_JOURNALS_ROOT/<app_id>/ */
  journal_location?: string;
  /** @deprecated as of v1.3.0; SOUL.md is at ZEOS_SOULS_ROOT/<app_id>/SOUL.md (zeos-side) */
  soul_file?: string;
  repo?: {
    url?: string;
    /**
     * Optional override for the on-disk clone directory.
     * Used when the local checkout dir name differs from `app_id`.
     */
    clone_path?: string;
  };
}

export function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Where the project's SOUL.md lives.
 * Always: ~/projects/zeos/souls/<app_id>/SOUL.md
 *
 * This is the project's IDENTITY file — mission, constraints, values.
 * Lives in the zeos repo (gitignored), NOT in the project repo. Created
 * by `/newproject` automatically.
 */
export function resolveSoulPath(app: PathResolverApp): string {
  return `${ZEOS_SOULS_ROOT}/${app.app_id}/SOUL.md`;
}

/**
 * Where session journals for this project live.
 * Always: ~/projects/zeos/journals/<app_id>/
 */
export function resolveJournalPath(app: PathResolverApp): string {
  return `${ZEOS_JOURNALS_ROOT}/${app.app_id}/`;
}

/**
 * Where the project's MEMORY.md lives.
 * Always: ~/projects/zeos/memory/<app_id>/MEMORY.md
 */
export function resolveMemoryPath(app: PathResolverApp): string {
  return `${ZEOS_MEMORY_ROOT}/${app.app_id}/MEMORY.md`;
}

/**
 * Where the project's local working tree lives.
 * Prefers explicit clone_path override, then ~/projects/<app_id>/ (convention),
 * then the legacy ZEOS_APPS_ROOT/<local_path> for back-compat.
 */
export function resolveProjectRoot(app: PathResolverApp): string {
  if (app.repo?.clone_path) {
    return app.repo.clone_path.endsWith("/")
      ? app.repo.clone_path
      : `${app.repo.clone_path}/`;
  }
  if (app.repo?.url) {
    return `~/projects/${app.app_id}/`;
  }
  if (app.local_path) {
    if (app.local_path.startsWith("~/") || app.local_path.startsWith("/")) {
      return app.local_path.endsWith("/") ? app.local_path : `${app.local_path}/`;
    }
    return `${ZEOS_APPS_ROOT}/${app.local_path}`;
  }
  return `~/projects/${app.app_id}/`;
}

/**
 * Where the project's CLAUDE.md (operations doctrine) lives.
 * Always at <project_root>/CLAUDE.md. May or may not exist on disk —
 * scaffold is opt-in (newproject.py --claude-md). Callers must handle missing files.
 */
export function resolveProjectClaudeMdPath(app: PathResolverApp): string {
  return `${resolveProjectRoot(app)}CLAUDE.md`;
}

export function verifyJournalWritten(absolutePath: string): void {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Journal write verification failed: file does not exist at ${absolutePath}`);
  }
}
