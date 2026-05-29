const IMPORTANCE_DEFAULT = 3;

export interface BridgeSections {
  objective?: string;
  state?: string;
  openThreads?: string[];
  verified?: string[];
  assumed?: string[];
  blockers?: string[];
  deadEnds?: string[];
  nextTacticalMove?: string;
  delta?: string;
}

export function firstContentLine(text: string): string {
  const line = text
    .split("\n")
    .map(l => l.trim())
    .find(l => l.length > 0 && !l.startsWith("#") && !l.match(/^[-*]\s*$/));
  return line || "Session continuity update";
}

export function titleFromSummary(summary: string): string {
  return firstContentLine(summary)
    .replace(/^[-*]\s*/, "")
    .substring(0, 150);
}

export function stripListMarker(line: string): string {
  return line
    .replace(/^-\s*\[\s*\]\s*/, "")
    .replace(/^(?:[-*]\s*|\d+[\.)]\s*)/, "")
    .trim();
}

export function normalizeStringList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap(item => normalizeStringList(item)).filter(Boolean);
  }
  return String(value)
    .split(/\n|,/)
    .map(item => stripListMarker(item.trim()))
    .filter(Boolean);
}

export function normalizeTags(value: unknown): string[] {
  return [...new Set(normalizeStringList(value)
    .map(tag => tag.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean))]
    .slice(0, 12);
}

export function clampImportance(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return IMPORTANCE_DEFAULT;
  return Math.min(5, Math.max(1, Math.round(parsed)));
}

export function formatListSection(items: string[], checkbox: boolean = false): string {
  if (items.length === 0) return "";
  return items.map(item => `${checkbox ? "- [ ]" : "-"} ${item}`).join("\n");
}

export function buildBridgeContent(sections: BridgeSections): string {
  const parts: string[] = [];
  if (sections.objective?.trim()) parts.push(`### Objective\n${sections.objective.trim()}`);
  if (sections.state?.trim()) parts.push(`### State of the World\n${sections.state.trim()}`);
  if (sections.openThreads?.length) parts.push(`### Open Threads\n${formatListSection(sections.openThreads, true)}`);
  if (sections.verified?.length) parts.push(`### Verified\n${formatListSection(sections.verified)}`);
  if (sections.assumed?.length) parts.push(`### Assumed\n${formatListSection(sections.assumed)}`);
  if (sections.blockers?.length) parts.push(`### Blockers\n${formatListSection(sections.blockers)}`);
  if (sections.deadEnds?.length) parts.push(`### Dead Ends\n${formatListSection(sections.deadEnds)}`);
  if (sections.nextTacticalMove?.trim()) parts.push(`### Next Tactical Move\n${sections.nextTacticalMove.trim()}`);
  if (sections.delta?.trim()) parts.push(`### Delta\n${sections.delta.trim()}`);
  return parts.join("\n\n").trim();
}

// =============================================================================
// Tool-grammar leak detection and structured error envelopes.
//
// Defensive layer for zeos_snap and zeos_end_session handlers. An LLM that
// invents an XML envelope (e.g. <summary>...</summary>) or leaks its own
// tool-invocation grammar (e.g. </invoke>) into a JSON string parameter will
// hit detectToolGrammarLeak; the handler then returns a structured error
// envelope built via buildToolGrammarLeakResponse so the agent reads the
// expected shape directly in the rejection and can converge on next call.
// =============================================================================

const TOOL_GRAMMAR_LEAK_PATTERNS: RegExp[] = [
  // Field starts with a known tool-grammar opening tag.
  /^\s*<(summary|delta|nextActions|next_tactical_move|bridge|invoke)\b/i,
  // Closing tag for a known tool-grammar token anywhere in the field.
  /<\/(summary|delta|nextActions|next_tactical_move|bridge|invoke)>/i,
];

export interface ToolGrammarLeak {
  /** Field name where the leak was detected (e.g. "delta" or "open_threads[2]"). */
  field: string;
  /** First 80 chars of the offending value, trimmed. */
  sample: string;
  /** Index of the matched pattern in TOOL_GRAMMAR_LEAK_PATTERNS. */
  pattern_index: number;
}

function checkString(s: string): { sample: string; pattern_index: number } | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  for (let i = 0; i < TOOL_GRAMMAR_LEAK_PATTERNS.length; i++) {
    if (TOOL_GRAMMAR_LEAK_PATTERNS[i].test(trimmed)) {
      return { sample: trimmed.slice(0, 80), pattern_index: i };
    }
  }
  return null;
}

/**
 * Scan handler arguments for tool-grammar leakage. Inspects string values and
 * elements of string arrays. Returns the first leak encountered, or null when
 * the args are clean. Only known tool-grammar tokens trigger; arbitrary
 * inline angle content and legitimate HTML pass through unflagged.
 */
export function detectToolGrammarLeak(
  args: Record<string, unknown> | undefined,
): ToolGrammarLeak | null {
  if (!args) return null;
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      const hit = checkString(v);
      if (hit) return { field: k, sample: hit.sample, pattern_index: hit.pattern_index };
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (typeof item !== "string") continue;
        const hit = checkString(item);
        if (hit) return { field: `${k}[${i}]`, sample: hit.sample, pattern_index: hit.pattern_index };
      }
    }
  }
  return null;
}

export interface ErrorEnvelopeOpts {
  /** Stable machine-readable code (e.g. "ZEOS_TOOL_GRAMMAR_LEAK"). */
  error_code: string;
  /** Human-readable summary of the failure. */
  error: string;
  /** Optional one-line recovery guidance for the caller. */
  hint?: string;
  /** Field name that produced the error, when applicable. */
  offending_field?: string;
  /** Truncated sample of the offending value, when applicable. */
  offending_sample?: string;
  /** Names of required fields that were missing, when applicable. */
  missing_fields?: string[];
  /** Abbreviated reference shape for the expected payload, when applicable. */
  expected_shape?: Record<string, unknown>;
}

/**
 * Serialize a structured error envelope as a pretty-printed JSON string. Used
 * by zeos_snap and zeos_end_session to return machine-groupable error codes
 * alongside human-readable hints. Pure function; safe to unit-test directly.
 */
export function buildErrorEnvelope(opts: ErrorEnvelopeOpts): string {
  return JSON.stringify(opts, null, 2);
}

/**
 * Build the tool-grammar-leak error envelope from a detector result. Always
 * carries error_code "ZEOS_TOOL_GRAMMAR_LEAK" and surfaces the offending
 * field/sample plus the expected shape so the agent has the contract in the
 * rejection.
 */
export function buildToolGrammarLeakResponse(leak: ToolGrammarLeak): string {
  return buildErrorEnvelope({
    error_code: "ZEOS_TOOL_GRAMMAR_LEAK",
    error: `Field '${leak.field}' is wrapped in an XML/tag envelope. This tool takes plain JSON strings, not XML.`,
    hint: "Pass raw text in each field. Do not wrap content in <summary>/<delta>/<nextActions> or any tool-grammar tags.",
    offending_field: leak.field,
    offending_sample: leak.sample,
    expected_shape: {
      _note: "All fields are plain strings or arrays of strings. Never wrap in XML tags.",
      project: "string (required)",
      summary: "string (required for zeos_end_session)",
      nextActions: "string (required for zeos_end_session)",
      delta: "string (optional bridge content)",
    },
  });
}
