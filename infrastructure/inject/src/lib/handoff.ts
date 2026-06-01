/**
 * Pure decision logic for the zeos_snap and zeos_end_session handlers.
 *
 * Extracted from index.ts so the reject / recover / derive DECISION is
 * unit-testable in isolation, with no filesystem, registry, redaction, journal,
 * MEMORY, or process side effects (those stay in index.ts). These functions are
 * pure: the same args produce the same decision.
 *
 * This is a behavior-preserving refactor of the previous inline handler logic,
 * not a behavior change. The handler now calls decideSnap / decideEndSession and
 * then either performs all I/O on a `persist` result, or (on a `reject` result)
 * logs a value-blind diagnostic and returns the envelope verbatim.
 *
 * Scope note: this module does NOT introduce the gated Phase 2 single-narrative
 * `handoff` field. It only mirrors the existing accepted fields.
 */
import {
  sanitizeArgsToolGrammar,
  buildBridgeContent,
  normalizeTags,
  normalizeStringList,
  clampImportance,
  buildErrorEnvelope,
  reconstructedPlaceholder,
} from "./bridge.js";

/** Reject outcome: the handler returns `envelope` verbatim (isError: true). */
export interface RejectDecision {
  kind: "reject";
  /** Stable machine-readable code. Today this path is always missing-required. */
  code: "ZEOS_MISSING_REQUIRED";
  /** Names of the required fields that were absent. */
  missingFields: string[];
  /** Pre-serialized structured error envelope, returned to the caller as-is. */
  envelope: string;
}

/** Persist outcome for zeos_snap: the derived values the handler writes. */
export interface SnapPersist {
  kind: "persist";
  project: string;
  bridge: string;
  note: string;
  tags: string[];
  /** Sanitized `agent` arg ("" when absent); the handler completes resolution. */
  agentArg: string;
  recovered: boolean;
  sanitizedFields: string[];
  recoveryMissing: string[];
}

export type SnapDecision = SnapPersist | RejectDecision;

/** Persist outcome for zeos_end_session: the derived values the handler writes. */
export interface EndPersist {
  kind: "persist";
  project: string;
  summary: string;
  title: string;
  finalBridge: string;
  nextActions: string;
  tags: string[];
  importance: number;
  why: string;
  howToApply: string;
  refs: string[];
  /** Sanitized `agent` arg ("" when absent); the handler completes resolution. */
  agentArg: string;
  recovered: boolean;
  sanitizedFields: string[];
  recoveryMissing: string[];
}

export type EndDecision = EndPersist | RejectDecision;

/**
 * Decide the zeos_snap outcome from raw handler args. Mirrors the prior inline
 * logic exactly: sanitize tool-grammar, derive the bridge/tags, reject when
 * required content is absent (and not recovered), else fill any recovered gap
 * with an honest placeholder and return the persist values.
 */
export function decideSnap(rawArgs: Record<string, unknown> | undefined): SnapDecision {
  const { args: sanitizedArgs, fields: sanitizedFields } = sanitizeArgsToolGrammar(rawArgs);
  const recovered = sanitizedFields.length > 0;
  const args = recovered ? sanitizedArgs : rawArgs;

  const project = args?.project as string;
  const delta = (args?.delta as string) || "";
  const note = (args?.note as string) || "";
  let tags = normalizeTags(args?.tags);
  if (recovered && !tags.includes("recovered")) tags = ["recovered", ...tags.filter(t => t !== "recovered")].slice(0, 12);
  let bridge = buildBridgeContent({
    objective: args?.objective as string,
    state: args?.state as string,
    openThreads: normalizeStringList(args?.open_threads),
    verified: normalizeStringList(args?.verified),
    assumed: normalizeStringList(args?.assumed),
    blockers: normalizeStringList(args?.blockers),
    deadEnds: normalizeStringList(args?.dead_ends),
    nextTacticalMove: args?.next_tactical_move as string,
    delta,
  });

  if (!project || (!bridge && !recovered)) {
    const missing: string[] = [];
    if (!project) missing.push("project");
    if (!bridge) missing.push("bridge content (delta or one of objective/state/open_threads/verified/assumed/blockers/dead_ends/next_tactical_move)");
    return {
      kind: "reject",
      code: "ZEOS_MISSING_REQUIRED",
      missingFields: missing,
      envelope: buildErrorEnvelope({
        error_code: "ZEOS_MISSING_REQUIRED",
        error: "Missing required fields for zeos_snap.",
        missing_fields: missing,
        hint: "Send each value as a separate plain JSON string parameter, never wrapped in XML tags. Minimal valid call: { project, delta }. `delta` is the catch-all for bridge content; the structured fields (objective/state/open_threads/verified/assumed/blockers/dead_ends/next_tactical_move) are optional alternatives.",
        expected_shape: {
          project: "string (required)",
          delta: "string (catch-all bridge content; required if no structured fields provided)",
          objective: "string (optional)",
          next_tactical_move: "string (optional)",
        },
      }),
    };
  }

  const recoveryMissing: string[] = [];
  if (recovered && !bridge) {
    bridge = reconstructedPlaceholder("bridge content");
    recoveryMissing.push("bridge");
  }

  return {
    kind: "persist",
    project,
    bridge,
    note,
    tags,
    agentArg: (args?.agent as string) || "",
    recovered,
    sanitizedFields,
    recoveryMissing,
  };
}

/**
 * Decide the zeos_end_session outcome from raw handler args. Mirrors the prior
 * inline logic exactly: sanitize tool-grammar, derive summary/title/bridge/
 * nextActions/tags/importance/why/howToApply/refs, reject when a required field
 * is absent (and not recovered), else fill any recovered gap with an honest
 * placeholder and return the persist values.
 */
export function decideEndSession(rawArgs: Record<string, unknown> | undefined): EndDecision {
  const { args: sanitizedArgs, fields: sanitizedFields } = sanitizeArgsToolGrammar(rawArgs);
  const recovered = sanitizedFields.length > 0;
  const args = recovered ? sanitizedArgs : rawArgs;

  const project = args?.project as string;
  let summary = args?.summary as string;
  const title = (args?.title as string) || "";
  const delta = (args?.delta as string) || "";
  let nextActions = args?.nextActions as string;
  let tags = normalizeTags(args?.tags);
  if (recovered && !tags.includes("recovered")) tags = ["recovered", ...tags.filter(t => t !== "recovered")].slice(0, 12);
  let importance = clampImportance(args?.importance);
  if (recovered) importance = Math.min(importance, 2);
  const why = (args?.why as string) || "";
  const howToApply = (args?.how_to_apply as string) || "";
  const refs = normalizeStringList(args?.refs);
  let finalBridge = buildBridgeContent({
    objective: args?.objective as string,
    state: args?.state as string,
    openThreads: normalizeStringList(args?.open_threads),
    verified: normalizeStringList(args?.verified),
    assumed: normalizeStringList(args?.assumed),
    blockers: normalizeStringList(args?.blockers),
    deadEnds: normalizeStringList(args?.dead_ends),
    nextTacticalMove: args?.next_tactical_move as string,
    delta,
  });

  const recoveryMissing: string[] = [];
  if (!project || ((!summary || !finalBridge || !nextActions) && !recovered)) {
    const missing: string[] = [];
    if (!project) missing.push("project");
    if (!summary) missing.push("summary");
    if (!finalBridge) missing.push("final bridge content (delta or one of objective/state/open_threads/verified/assumed/blockers/dead_ends/next_tactical_move)");
    if (!nextActions) missing.push("nextActions");
    return {
      kind: "reject",
      code: "ZEOS_MISSING_REQUIRED",
      missingFields: missing,
      envelope: buildErrorEnvelope({
        error_code: "ZEOS_MISSING_REQUIRED",
        error: "Missing required fields for zeos_end_session.",
        missing_fields: missing,
        hint: "Send each value as a separate plain JSON string parameter, never wrapped in XML tags. Minimal valid call: { project, summary, nextActions, delta }. All four are required; `delta` is the catch-all for bridge content.",
        expected_shape: {
          project: "string (required)",
          summary: "string (required)",
          nextActions: "string (required)",
          delta: "string (catch-all bridge content; required if no structured fields provided)",
        },
      }),
    };
  }

  if (recovered) {
    // Degraded persistence: never lose a recovered handoff. Fill any
    // still-missing required field with an honest placeholder.
    if (!summary) { summary = reconstructedPlaceholder("summary"); recoveryMissing.push("summary"); }
    if (!finalBridge) { finalBridge = reconstructedPlaceholder("bridge content"); recoveryMissing.push("bridge"); }
    if (!nextActions) { nextActions = reconstructedPlaceholder("nextActions"); recoveryMissing.push("nextActions"); }
  }

  return {
    kind: "persist",
    project,
    summary,
    title,
    finalBridge,
    nextActions,
    tags,
    importance,
    why,
    howToApply,
    refs,
    agentArg: (args?.agent as string) || "",
    recovered,
    sanitizedFields,
    recoveryMissing,
  };
}
