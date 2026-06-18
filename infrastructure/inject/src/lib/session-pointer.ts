/**
 * Per-session active-project pointers for headless auto-capture.
 *
 * The problem this solves: a PreCompact hook is a shell command with no
 * `/project` session state, while the inject MCP server holds the active
 * journal in-process (`_activeJournals`). The hook fires in a Claude Code
 * session; to snap THAT session's journal it must find a durable pointer the
 * MCP server wrote for the same session.
 *
 * Verified shared id (Claude Code 2.1.181): the MCP server inherits the
 * environment variable `CLAUDE_CODE_SESSION_ID` (UUID, names the live
 * transcript `~/.claude/projects/<proj>/<id>.jsonl`), and the PreCompact hook
 * receives the SAME id as `session_id` on its stdin payload. So a pointer keyed
 * by that id is written by the server on `/project` load and resolved by the
 * headless snap using the hook's stdin `session_id`.
 *
 * Hard safety rules (PreCompact fires in EVERY session, including non-zeos
 * ones):
 *   - No global "current project" pointer. Per-session only. A global pointer
 *     would snap the WRONG project under the concurrent multi-instance use zeos
 *     supports.
 *   - Resolve ONLY the given session id's pointer. Never guess, never scan the
 *     filesystem for "the newest journal".
 *   - Staleness/TTL: ignore (and GC) pointers older than the TTL. A stale
 *     pointer from a long-dead session must not capture into a journal the
 *     operator has moved on from.
 *   - Return null (the caller no-ops) when the pointer is absent, stale,
 *     malformed, or its journal no longer exists.
 *
 * Pointers contain NO secrets: app_id, agent, an absolute journal path, and
 * timestamps. They live under the state root so they never touch a project repo.
 */

import * as fs from "fs";
import * as path from "path";
import { expandPath } from "../path-resolver.js";

/** Default staleness window for a pointer, in minutes. */
export const SESSION_POINTER_TTL_MINUTES = 720; // 12h: spans a long working day

/**
 * Future-clock-skew tolerance for `updated_at`. A pointer stamped a little ahead
 * of `now` is plausible real clock skew between the writer and the hook process;
 * a pointer stamped FAR in the future is tampering (a forged timestamp that would
 * otherwise never expire). Beyond this window we treat the pointer as invalid.
 */
const FUTURE_SKEW_TOLERANCE_MS = 2 * 60_000; // 2 minutes

/**
 * On-disk pointer shape. `schema` guards against a future format change being
 * silently misread; an unknown schema is treated as unresolvable (no-op), never
 * coerced.
 */
export interface SessionPointer {
  schema: 1;
  session_id: string;
  app_id: string;
  agent: string;
  /** Absolute path to the session's journal file. */
  journal_path: string;
  /** ISO timestamp the pointer was written/refreshed. */
  updated_at: string;
}

/** Current pointer schema version. */
const POINTER_SCHEMA: SessionPointer["schema"] = 1;

/**
 * Resolve the absolute pointer directory, honoring ZEOS_STATE_ROOT overrides.
 *
 * The state root is read LIVE from the environment at call time (not captured
 * at module load) so the headless snap process - which sets its own env and
 * runs cold - and the MCP server both resolve the same directory the operator
 * configured, and so tests can point it at a temp dir. Mirrors the default in
 * path-resolver.ts (~/.zeos).
 */
export function resolvePointerDir(): string {
  const stateRoot = process.env.ZEOS_STATE_ROOT ?? "~/.zeos";
  return expandPath(`${stateRoot}/.active`);
}

/**
 * Session ids arrive from an environment variable and from hook stdin, both of
 * which become a path component. Reject anything that is not a plain
 * pointer-safe token so a crafted id can never traverse out of the pointer dir
 * or collide with another file. Claude Code session ids are UUIDs, which pass.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function isSafeSessionId(id: unknown): id is string {
  return typeof id === "string" && SAFE_SESSION_ID.test(id) && !id.includes("..");
}

function pointerPathFor(sessionId: string): string {
  return path.join(resolvePointerDir(), `${sessionId}.json`);
}

/**
 * Resolve the journals root from the environment, the SAME way resolvePointerDir
 * does (live `ZEOS_STATE_ROOT`, not the module-load-time constant). This must be
 * read live so the cold headless process, the MCP server, and tests that set the
 * env after import all agree on the root; mirrors path-resolver's
 * ZEOS_JOURNALS_ROOT = `${ZEOS_STATE_ROOT}/journals`.
 */
function journalsRootRaw(): string {
  const stateRoot = process.env.ZEOS_STATE_ROOT ?? "~/.zeos";
  return expandPath(`${stateRoot}/journals`);
}

/**
 * Resolve the journals root to its real (symlink-free) absolute path. Returns
 * null when the root cannot be resolved (e.g. it does not exist yet), which the
 * containment check treats as fail-closed: if we cannot prove the root, we
 * cannot prove containment, so the pointer is rejected.
 */
function realJournalsRoot(): string | null {
  try {
    return fs.realpathSync(journalsRootRaw());
  } catch {
    return null;
  }
}

/**
 * Containment gate for a journal path (the load-bearing "never write the wrong
 * journal" invariant). Returns the journal's REAL absolute path (symlinks fully
 * resolved) ONLY when it sits inside the real journals root; null otherwise.
 *
 * This defeats two distinct escapes that a plain `path.isAbsolute` check misses:
 *   - an absolute pointer whose `journal_path` is some OTHER existing file
 *     (MEMORY.md, a transcript .jsonl, a project file) outside the journals tree;
 *   - a journal entry that is a SYMLINK whose target escapes the journals tree.
 * Both resolve, via realpath, to a real path outside the root and are rejected.
 *
 * When the journal file does not yet exist on disk, its real path is computed
 * from realpath(dirname) + basename so a not-yet-created stub can still be
 * validated; if even the parent cannot be resolved, containment fails (no write).
 */
export function containedRealJournalPath(journalPath: string): string | null {
  if (!path.isAbsolute(journalPath)) return null;
  const root = realJournalsRoot();
  if (root === null) return null;

  let real: string;
  try {
    real = fs.realpathSync(journalPath);
  } catch {
    // The journal may not exist yet (a fresh stub validated before first write).
    // Resolve the real parent dir and re-attach the basename so a symlinked
    // ancestor still cannot escape; a missing/unresolvable parent fails closed.
    try {
      const parentReal = fs.realpathSync(path.dirname(journalPath));
      real = path.join(parentReal, path.basename(journalPath));
    } catch {
      return null;
    }
  }

  // Path-boundary safe: require `real` to equal the root joined with a non-empty
  // relative segment. `path.relative` yields "" for the root itself and a value
  // starting with ".." (or an absolute path on a different volume) for anything
  // outside, so both the root-itself and sibling-prefix (`/x/journals-evil`)
  // cases are rejected.
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return real;
}

/**
 * Read `CLAUDE_CODE_SESSION_ID` from the environment, validated. Returns null
 * when absent or unsafe so the write path degrades to a no-op rather than
 * writing an unkeyable/poisonous pointer. Kept here (not inlined) so the MCP
 * server and tests share one source of truth for the env var name.
 */
export function currentSessionIdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.CLAUDE_CODE_SESSION_ID;
  return isSafeSessionId(raw) ? raw : null;
}

/**
 * Write (or refresh) the pointer for `sessionId`. Idempotent: re-writing for the
 * same session overwrites with current values. Returns the absolute pointer path
 * on success, or null when it cannot/should-not write (unsafe id, unwritable
 * dir) - the caller treats null as a no-op, never an error, because pointer
 * write is best-effort convenience, not a correctness dependency.
 */
export function writeSessionPointer(params: {
  sessionId: string;
  appId: string;
  agent: string;
  journalPath: string;
  now?: Date;
}): string | null {
  const { sessionId, appId, agent, journalPath } = params;
  if (!isSafeSessionId(sessionId)) return null;
  if (!appId || !agent || !journalPath) return null;
  if (!path.isAbsolute(journalPath)) return null;
  // Containment gate: refuse to record a pointer whose journal (after symlink
  // resolution) escapes the journals root. A rejected write leaves NO pointer on
  // disk, so a tampered/symlinked target can never be persisted for the headless
  // snap to later trust.
  if (containedRealJournalPath(journalPath) === null) return null;

  const pointer: SessionPointer = {
    schema: POINTER_SCHEMA,
    session_id: sessionId,
    app_id: appId,
    agent,
    journal_path: journalPath,
    updated_at: (params.now ?? new Date()).toISOString(),
  };

  try {
    const dir = resolvePointerDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = pointerPathFor(sessionId);
    // Plain write is sufficient: the pointer is small, self-describing, and
    // disposable - a torn pointer simply fails to parse on read and no-ops,
    // and the next /project load rewrites it. A pointer carries no secret, so
    // it does not need the redacted/atomic durable-write path.
    fs.writeFileSync(target, JSON.stringify(pointer, null, 2) + "\n", "utf-8");
    return target;
  } catch {
    return null;
  }
}

function isStale(updatedAt: string, ttlMinutes: number, now: Date): boolean {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return true; // unparseable timestamp -> treat as stale
  const ageMs = now.getTime() - t;
  if (ageMs < 0) {
    // A future timestamp inside the small skew tolerance is plausible real clock
    // skew (not stale); a FAR-future timestamp is a forged value that would never
    // age out, so treat it as stale/invalid rather than perpetually fresh.
    return -ageMs > FUTURE_SKEW_TOLERANCE_MS;
  }
  return ageMs > ttlMinutes * 60_000;
}

/**
 * Resolve ONLY this session id's pointer. Returns the validated pointer when it
 * exists, parses, is the expected session, is within the TTL, and its journal
 * file still exists on disk. Returns null in every other case (absent, malformed,
 * wrong schema, stale, journal missing). Never falls back to another session,
 * never scans for "the newest journal". A stale-but-present pointer is GC'd as a
 * side effect so the directory self-cleans.
 */
export function resolveSessionPointer(
  sessionId: string,
  opts: { ttlMinutes?: number; now?: Date } = {},
): SessionPointer | null {
  if (!isSafeSessionId(sessionId)) return null;
  const ttlMinutes = opts.ttlMinutes ?? SESSION_POINTER_TTL_MINUTES;
  const now = opts.now ?? new Date();

  const target = pointerPathFor(sessionId);
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf-8");
  } catch {
    return null; // absent (or unreadable) -> no-op
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed -> no-op (do not delete; could be a concurrent write)
  }

  if (!isValidPointer(parsed)) return null;
  if (parsed.session_id !== sessionId) return null; // mismatched id -> no-op

  if (isStale(parsed.updated_at, ttlMinutes, now)) {
    // GC the stale pointer so the directory self-cleans; failure is harmless.
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* best-effort */
    }
    return null;
  }

  // Re-validate containment on RESOLVE; never trust the on-disk pointer. A
  // tampered `~/.zeos/.active/<id>.json` (or a journal swapped for a symlink that
  // now escapes the journals root) must NO-OP, not direct an append at an
  // arbitrary file. containedRealJournalPath resolves symlinks and requires the
  // real target to sit inside the real journals root; it also fails when the
  // journal no longer exists (realpath of the file throws and the parent-fallback
  // path still points at a missing file), which preserves the prior
  // vanished-journal -> no-op behavior (we never recreate a deleted journal).
  if (containedRealJournalPath(parsed.journal_path) === null) return null;
  // Belt-and-suspenders: the file itself must exist on disk for a snap to target
  // it (the parent-fallback above can produce a contained-but-absent path).
  if (!fs.existsSync(parsed.journal_path)) return null;

  return parsed;
}

function isValidPointer(value: unknown): value is SessionPointer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schema === POINTER_SCHEMA &&
    typeof v.session_id === "string" &&
    typeof v.app_id === "string" &&
    typeof v.agent === "string" &&
    typeof v.journal_path === "string" &&
    typeof v.updated_at === "string" &&
    v.app_id.length > 0 &&
    v.agent.length > 0 &&
    path.isAbsolute(v.journal_path as string)
  );
}

/**
 * Sweep the pointer directory, deleting pointers older than the TTL. Called
 * opportunistically (e.g. on each `/project` load and each headless snap) so
 * dead-session pointers never accumulate. Returns the number removed. Never
 * throws - a GC failure must not break a snap or a project load.
 */
export function gcStalePointers(
  opts: { ttlMinutes?: number; now?: Date } = {},
): number {
  const ttlMinutes = opts.ttlMinutes ?? SESSION_POINTER_TTL_MINUTES;
  const now = opts.now ?? new Date();
  const dir = resolvePointerDir();

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0; // dir absent -> nothing to GC
  }

  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const p = path.join(dir, name);
    let stale = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (!isValidPointer(parsed)) {
        stale = true; // malformed/legacy pointer -> remove
      } else {
        stale = isStale(parsed.updated_at, ttlMinutes, now);
      }
    } catch {
      stale = true; // unreadable/unparseable -> remove
    }
    if (stale) {
      try {
        fs.rmSync(p, { force: true });
        removed += 1;
      } catch {
        /* best-effort */
      }
    }
  }
  return removed;
}

/** Remove a single session's pointer (e.g. on `/end`). Best-effort, never throws. */
export function deleteSessionPointer(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) return;
  try {
    fs.rmSync(pointerPathFor(sessionId), { force: true });
  } catch {
    /* best-effort */
  }
}
