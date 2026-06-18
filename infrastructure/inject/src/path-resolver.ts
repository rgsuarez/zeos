import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { redactSensitiveText } from "./lib/redact.js";

/**
 * Zeos root paths.
 *
 * As of v1.2.0 there are two distinct roots:
 *
 *   ZEOS_REPO_ROOT  (default ~/projects/zeos) - the public product: kernel,
 *                   modules, infrastructure, tools, docs, profiles/template/.
 *   ZEOS_STATE_ROOT (default ~/.zeos)         - operator-mutated state, mirroring
 *                   the ~/.claude and ~/.codex convention.
 *
 * Per-project operator state lives under ZEOS_STATE_ROOT:
 *   ~/.zeos/apps/REGISTRY.json            ← project registry
 *   ~/.zeos/profiles/<operator>/PROFILE.md ← operator profile
 *   ~/.zeos/souls/<app_id>/SOUL.md         ← project identity (WHO)
 *   ~/.zeos/journals/<app_id>/             ← session journals
 *   ~/.zeos/memory/<app_id>/MEMORY.md      ← curated mid-term memory
 *   ~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md ← development direction
 *
 * Keeping state out of the repo means project repos stay 100% clean and the
 * public zeos mirror is byte-identical to any operator's mirror.
 *
 * Both roots honor an environment override (ZEOS_REPO_ROOT / ZEOS_STATE_ROOT)
 * and are kept in the established "~/"-prefixed form so expandPath() resolves
 * them at read time. An absolute override (no leading ~/) passes through
 * expandPath unchanged.
 *
 * The project's own CLAUDE.md (operations doctrine - HOW it builds, deploys,
 * conventions) still lives in the project repo at <local_path>/CLAUDE.md.
 *
 * The split: SOUL = WHO the project is (identity, mission, constraints) -
 * rarely changes. CLAUDE.md = HOW the project operates - changes weekly.
 */
export const ZEOS_REPO_ROOT = process.env.ZEOS_REPO_ROOT ?? "~/projects/zeos";
export const ZEOS_STATE_ROOT = process.env.ZEOS_STATE_ROOT ?? "~/.zeos";

/** @deprecated v1.2.0; alias of ZEOS_REPO_ROOT for product paths. Removed in v1.3.0. */
export const ZEOS_ROOT = ZEOS_REPO_ROOT;

export const ZEOS_SOULS_ROOT = `${ZEOS_STATE_ROOT}/souls`;
export const ZEOS_JOURNALS_ROOT = `${ZEOS_STATE_ROOT}/journals`;
export const ZEOS_MEMORY_ROOT = `${ZEOS_STATE_ROOT}/memory`;
export const ZEOS_ROADMAPS_ROOT = `${ZEOS_STATE_ROOT}/roadmaps`;

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
  /** @deprecated as of v1.3.0; SOUL.md is at ZEOS_SOULS_ROOT/<app_id>/SOUL.md (state-side) */
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

const _legacyNotified = new Set<string>();

/**
 * v1.2.0 read-time compatibility: prefer the state-root path; if it does not
 * exist but a legacy repo-root path does, return the legacy path and emit a
 * one-time deprecation notice. Defaults to the state path when neither exists.
 *
 * READ-ONLY. Write paths always use the canonical state-root resolvers below,
 * so migration never writes back into the repo tree. Legacy fallback is
 * removed in v1.3.0.
 */
export function stateFirst(statePath: string, legacyPath: string): string {
  if (fs.existsSync(expandPath(statePath))) return statePath;
  if (fs.existsSync(expandPath(legacyPath))) {
    if (!_legacyNotified.has(legacyPath)) {
      _legacyNotified.add(legacyPath);
      console.error(
        `[zeos] reading legacy state at ${legacyPath}; run ` +
          `'python3 tools/migrate-state.py --apply' to relocate it to ` +
          `${statePath} (legacy support removed in v1.3.0)`
      );
    }
    return legacyPath;
  }
  return statePath;
}

/**
 * Where the project's SOUL.md lives (canonical, state-side).
 * Always: ~/.zeos/souls/<app_id>/SOUL.md
 *
 * This is the project's IDENTITY file - mission, constraints, values.
 * Created by `/newproject` automatically.
 */
export function resolveSoulPath(app: PathResolverApp): string {
  return `${ZEOS_SOULS_ROOT}/${app.app_id}/SOUL.md`;
}

/**
 * Where session journals for this project live (canonical, state-side).
 * Always: ~/.zeos/journals/<app_id>/
 */
export function resolveJournalPath(app: PathResolverApp): string {
  return `${ZEOS_JOURNALS_ROOT}/${app.app_id}/`;
}

/**
 * Where the project's MEMORY.md lives (canonical, state-side).
 * Always: ~/.zeos/memory/<app_id>/MEMORY.md
 */
export function resolveMemoryPath(app: PathResolverApp): string {
  return `${ZEOS_MEMORY_ROOT}/${app.app_id}/MEMORY.md`;
}

/**
 * Where the project's MASTER_ROADMAP.md lives (canonical, state-side).
 * Always: ~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md
 *
 * The master roadmap is mostly-static development direction (desired end
 * state, North Star, phases). Scaffolded by `/newproject`; editable after.
 */
export function resolveRoadmapPath(app: PathResolverApp): string {
  return `${ZEOS_ROADMAPS_ROOT}/${app.app_id}/MASTER_ROADMAP.md`;
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
 * Always at <project_root>/CLAUDE.md. May or may not exist on disk -
 * scaffold is opt-in. Callers must handle missing files.
 */
export function resolveProjectClaudeMdPath(app: PathResolverApp): string {
  return `${resolveProjectRoot(app)}CLAUDE.md`;
}

/**
 * Post-append verification for an append-only journal write.
 *
 * Scoping matters: journals are append-only and long-lived, so a whole-file
 * re-scan is a footgun. A single pre-existing legacy false-positive (a
 * secret-shaped string written by an older build before the redaction gate
 * existed) would make EVERY future snap/end on that journal throw here,
 * bricking the journal permanently even though the new write is clean. The
 * newly-appended chunk is ALREADY gated pre-append by appendFileSyncDurable, so
 * the verification we need is narrow: confirm the file exists and that the new
 * chunk actually landed on disk intact and clean (defense-in-depth on the new
 * content only), NOT a re-scan of possibly-legacy bytes we did not just write.
 *
 * When `appendedChunk` is omitted (e.g. a stub create that writes via
 * `{flag:"wx"}` and has no appended delta), only existence is verified; the
 * whole-file secret re-scan is intentionally not performed.
 */
export function verifyJournalWritten(absolutePath: string, appendedChunk?: string): void {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Journal write verification failed: file does not exist at ${absolutePath}`);
  }

  if (appendedChunk === undefined) return;

  const onDisk = fs.readFileSync(absolutePath, "utf-8");

  // Confirm the appended bytes landed intact: an append-only durable write ends
  // with exactly the chunk we handed it, so a torn/partial append is caught by
  // the tail not matching.
  if (!onDisk.endsWith(appendedChunk)) {
    throw new Error(
      `Journal write verification failed: the appended chunk is not present at ` +
        `the tail of ${absolutePath} (torn or partial append).`
    );
  }

  // Defense-in-depth on the NEW content only: the chunk was already gated
  // pre-append, but re-assert the appended region. We re-scan the in-memory
  // `appendedChunk` (not a fresh disk read), which is sound because the
  // endsWith() check just above proved the on-disk tail equals this chunk
  // byte-for-byte, so scanning the chunk is scanning what landed on disk.
  // redactSensitiveText is idempotent against [REDACTED:...] markers, so a
  // count above zero means a real secret survived into the new chunk.
  const { count, labels } = redactSensitiveText(appendedChunk);
  if (count > 0) {
    const labelSuffix = labels.length > 0 ? ` (${labels.join(", ")})` : "";
    throw new Error(
      `Journal write verification failed: ${count} unredacted secret-shaped ` +
        `value(s)${labelSuffix} reached disk in the appended chunk at ${absolutePath}.`
    );
  }
}
