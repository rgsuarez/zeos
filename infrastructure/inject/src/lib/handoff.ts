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
 * Phase 2: a preferred single-narrative `handoff` field is accepted on both
 * tools. When present (non-empty after trim) it supplies the narrative content
 * (end: summary/finalBridge/nextActions; snap: bridge) and the legacy content
 * fields are ignored; first-class scalars still apply. The full blob is stored
 * once (end: in finalBridge), never duplicated across fields.
 */
import {
  sanitizeArgsToolGrammar,
  buildBridgeContent,
  normalizeTags,
  normalizeStringList,
  clampImportance,
  buildErrorEnvelope,
  reconstructedPlaceholder,
  firstContentLine,
} from "./bridge.js";

/** Concise pointer used when a handoff blob has no explicit next-actions section. */
export const HANDOFF_NEXT_ACTIONS_FALLBACK = "Review the Final Bridge handoff.";

const NEXT_SECTION_HEADING = /^#{1,6}\s*(next\s*(actions?|steps?|tactical\s*move)|todo|handoff)\b/i;
const ANY_HEADING = /^#{1,6}\s+\S/;

/**
 * Derive a concise `nextActions` from a single-narrative handoff blob WITHOUT
 * duplicating it. The full blob is stored once (in finalBridge); this returns
 * the content under an explicit next-actions/todo/handoff heading when present
 * (heading line excluded, up to the next heading or end), otherwise a short
 * pointer. It NEVER returns the whole blob, so finalBridge and nextActions are
 * never the same content.
 */
export function deriveNextActions(blob: string): string {
  const lines = blob.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (NEXT_SECTION_HEADING.test(lines[i].trim())) start = i; // last matching heading wins
  }
  if (start === -1) return HANDOFF_NEXT_ACTIONS_FALLBACK;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_HEADING.test(lines[i].trim())) { end = i; break; }
  }
  const section = lines.slice(start + 1, end).join("\n").trim();
  return section || HANDOFF_NEXT_ACTIONS_FALLBACK;
}

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

  // Phase 2: a single-narrative `handoff` blob, when present, supplies the
  // bridge content; legacy fields above are ignored. `note`/`tags`/`agent`
  // (first-class scalars) still apply.
  const handoff = ((args?.handoff as string) ?? "").trim();
  if (handoff) bridge = handoff;

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
        hint: "Send each value as a separate plain JSON string parameter, never wrapped in XML tags. Preferred minimal call: { project, handoff } where `handoff` is the whole snapshot as one prose block. Legacy fallback: { project, delta } (`delta` is the catch-all bridge content).",
        expected_shape: {
          project: "string (required)",
          handoff: "string (preferred: the whole snapshot as one plain-text block)",
          delta: "string (legacy catch-all bridge content; used only if no handoff)",
          next_tactical_move: "string (optional, legacy)",
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

  // Phase 2: a single-narrative `handoff` blob, when present, supplies the
  // narrative content. The full blob is stored ONCE in finalBridge; summary is a
  // concise first line; nextActions is the extracted next-section or a short
  // pointer (never the whole blob). Legacy content fields above are ignored;
  // first-class scalars (title/importance/tags/why/how_to_apply/refs/agent) apply.
  const handoff = ((args?.handoff as string) ?? "").trim();
  if (handoff) {
    summary = firstContentLine(handoff);
    finalBridge = handoff;
    nextActions = deriveNextActions(handoff);
  }

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
        hint: "Send each value as a separate plain JSON string parameter, never wrapped in XML tags. Preferred minimal call: { project, handoff } where `handoff` is the whole session handoff as one prose block. Legacy fallback: { project, summary, nextActions, delta }.",
        expected_shape: {
          project: "string (required)",
          handoff: "string (preferred: the whole session handoff as one plain-text block)",
          summary: "string (legacy; used only if no handoff)",
          nextActions: "string (legacy; used only if no handoff)",
          delta: "string (legacy catch-all bridge content)",
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
