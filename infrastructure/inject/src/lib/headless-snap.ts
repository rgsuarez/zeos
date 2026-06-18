/**
 * Headless snap: the entry point a PreCompact hook (a shell command, not an MCP
 * client) calls to checkpoint the active session's journal before context
 * compaction.
 *
 * Why this exists separately from the `zeos_snap` MCP tool: the tool runs inside
 * the MCP server with `_activeJournals` in memory and an LLM choosing arguments.
 * A hook has neither. It runs cold, in any session (including non-zeos ones),
 * and must NEVER guess a project.
 *
 * No-fallback discipline (the load-bearing safety property): this verb resolves
 * ONLY the pointer for the session id it was handed (written by the inject
 * server on `/project` load). It does NOT:
 *   - default the agent to "claude",
 *   - scan the filesystem for "the newest journal today",
 *   - persist a tool-grammar recovery placeholder,
 *   - create a journal if none exists.
 * If the pointer does not resolve to an exact, existing journal, it NO-OPS.
 *
 * It REUSES the redacted durable-append path (`redactSensitiveText` +
 * `appendFileSyncDurable` + `verifyJournalWritten`), so the redaction gate and
 * the torn-append protection built for `/snap` apply identically here; it never
 * re-implements the append.
 */

import * as path from "path";
import { redactSensitiveText, formatRedactionNotice } from "./redact.js";
import { appendFileSyncDurable } from "./atomic-write.js";
import { verifyJournalWritten } from "../path-resolver.js";
import {
  resolveSessionPointer,
  gcStalePointers,
  type SessionPointer,
} from "./session-pointer.js";

export type HeadlessSnapStatus = "written" | "noop" | "error";

export interface HeadlessSnapResult {
  status: HeadlessSnapStatus;
  /** Machine-readable reason, primarily for noop/error. */
  reason?: string;
  /** Absolute journal path written, when status === "written". */
  journalPath?: string;
  /** Count of secret-shaped values redacted from the handoff text. */
  redactions?: number;
}

export interface ParsedSnapArgs {
  sessionId: string | null;
  handoff: string;
}

/**
 * Parse the headless-snap argv (everything AFTER the `snap` verb). Supports:
 *   --session <id>            (required to resolve a pointer; else no-op)
 *   --handoff <text>          (the auto checkpoint text)
 * Unknown flags are ignored rather than fatal, so a future hook that passes
 * extra context cannot crash a checkpoint.
 */
export function parseSnapArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedSnapArgs {
  let sessionId: string | null = null;
  let handoff = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session" && i + 1 < argv.length) {
      sessionId = argv[++i];
    } else if (a === "--handoff" && i + 1 < argv.length) {
      handoff = argv[++i];
    }
  }
  // Fallback: a hook may export the session id rather than pass it as a flag.
  // The flag wins; env only fills an unset value. Validation happens downstream
  // in resolveSessionPointer, so an unsafe value still no-ops.
  if (!sessionId && env.CLAUDE_CODE_SESSION_ID) {
    sessionId = env.CLAUDE_CODE_SESSION_ID;
  }
  return { sessionId, handoff };
}

/**
 * Build the `## Checkpoint` journal entry for an auto-snap. Mirrors the
 * `zeos_snap` entry shape (so journals read uniformly), with an explicit
 * auto-capture marker and the (already-redacted) handoff as the bridge body.
 */
export function buildAutoCheckpointEntry(params: {
  timestamp: string;
  redactedHandoff: { text: string };
  redactionNotice: string;
}): string {
  const { timestamp, redactedHandoff, redactionNotice } = params;
  return `
## Checkpoint: ${timestamp}

**Auto-capture:** PreCompact (pre-compaction checkpoint; no operator /snap)

### Bridge
${redactedHandoff.text}

${redactionNotice}

---
`;
}

/**
 * Run a headless snap. Pure of process control: returns a result instead of
 * exiting, so it is unit-testable. `gitSnapshot` is injected (best-effort, may
 * be empty) so this module stays decoupled from registry/git resolution and so
 * tests need no git repo.
 */
export function runHeadlessSnap(
  argv: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    now?: Date;
    ttlMinutes?: number;
    /** Best-effort git snapshot text (already provider-formatted); may be empty. */
    gitSnapshot?: string;
    /** Override pointer resolution (tests); defaults to resolveSessionPointer. */
    resolvePointer?: (sessionId: string) => SessionPointer | null;
  } = {},
): HeadlessSnapResult {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const { sessionId, handoff } = parseSnapArgs(argv, env);

  // Opportunistic GC so dead-session pointers never accumulate. Never fatal.
  try {
    gcStalePointers({ now, ttlMinutes: opts.ttlMinutes });
  } catch {
    /* best-effort */
  }

  if (!sessionId) {
    return { status: "noop", reason: "no-session-id" };
  }

  const resolvePointer =
    opts.resolvePointer ??
    ((sid: string) => resolveSessionPointer(sid, { now, ttlMinutes: opts.ttlMinutes }));

  const pointer = resolvePointer(sessionId);
  if (!pointer) {
    // PreCompact fires in EVERY session; an unresolved pointer is the normal,
    // expected case for a non-zeos session. No-op, never guess.
    return { status: "noop", reason: "no-active-pointer" };
  }

  const journalPath = pointer.journal_path;
  if (!path.isAbsolute(journalPath)) {
    return { status: "noop", reason: "pointer-journal-not-absolute" };
  }

  const timestamp = now.toISOString();
  const redactedHandoff = redactSensitiveText(handoff || "");
  const redactedGit = redactSensitiveText(opts.gitSnapshot ?? "");
  const redactionNotice = formatRedactionNotice(redactedHandoff);

  // Compose the entry. The git snapshot, when present, is appended after the
  // bridge exactly as zeos_snap does.
  let entry = buildAutoCheckpointEntry({ timestamp, redactedHandoff, redactionNotice });
  if (redactedGit.text) {
    // Insert the git block before the trailing separator to match snap layout.
    entry = entry.replace(/\n---\n$/, `\n${redactedGit.text}\n\n---\n`);
  }

  try {
    // appendFileSyncDurable applies the pre-append redaction gate internally and
    // fsyncs the tail; verifyJournalWritten confirms the chunk landed clean.
    appendFileSyncDurable(journalPath, entry);
    verifyJournalWritten(journalPath, entry);
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
      journalPath,
    };
  }

  return {
    status: "written",
    journalPath,
    redactions: redactedHandoff.count,
  };
}
