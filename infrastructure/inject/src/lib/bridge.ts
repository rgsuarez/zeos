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

// =============================================================================
// Recovery: lossless tool-grammar sanitizer + recovery routing.
//
// FIELD_NAME_ALLOWLIST is the set of field names this server accepts as real
// parameters, plus "parameter" (the MCP wrapper tag). It governs SANITIZE and
// RECOVERY only, and is intentionally BROADER than TOOL_GRAMMAR_LEAK_PATTERNS
// above (the frozen rejection-detector set, unchanged). The two are kept side
// by side so the intended divergence is explicit and unlikely to drift.
//
// When an LLM leaks tool-grammar (wraps its whole handoff as pseudo-XML inside
// one string parameter, or closes a parameter with a name-matching tag), the
// handlers no longer reject and lose the handoff. They strip the leaked tag
// tokens (preserving all other content), persist, and mark the entry recovered.
// =============================================================================

export const FIELD_NAME_ALLOWLIST = [
  "summary", "delta", "nextActions", "next_tactical_move", "bridge", "invoke",
  "objective", "state", "open_threads", "verified", "assumed", "blockers",
  "dead_ends", "why", "how_to_apply", "refs", "tags", "importance", "agent",
  "handoff", "parameter",
] as const;

const FIELD_NAME_SET = new Set<string>(FIELD_NAME_ALLOWLIST.map(n => n.toLowerCase()));

/** Machine-distinguishable prefix for fields reconstructed from a leaked payload. */
export const RECONSTRUCTED_PLACEHOLDER_PREFIX = "[ZEOS_RECONSTRUCTED]";

/**
 * Honest placeholder for a required field that was absent from a leaked payload.
 * Never asserts a fact about the work; states provenance and points to the blob.
 */
export function reconstructedPlaceholder(field: string): string {
  return `${RECONSTRUCTED_PLACEHOLDER_PREFIX} No ${field} was provided as a structured field; this handoff was recovered from a malformed (tool-grammar-leaked) payload. See the recovered summary for any embedded content.`;
}

function isWordChar(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
}

/**
 * One linear forward pass: strip allowlisted tool-grammar tags (open, close, or
 * unclosed head), preserving every other byte. The read index is monotonic and
 * each character is examined at most twice (once by look-ahead, once on emit),
 * so this pass is O(n) with no backtracking and no ReDoS surface, and it never
 * truncates. Only tag-token spans are removed.
 */
function stripOnePass(input: string): { text: string; removed: number } {
  const n = input.length;
  const out: string[] = [];
  let i = 0;
  let removed = 0;
  while (i < n) {
    if (input[i] === "<") {
      let j = i + 1;
      if (j < n && input[j] === "/") j++;
      const nameStart = j;
      while (j < n && isWordChar(input[j])) j++;
      if (j > nameStart && FIELD_NAME_SET.has(input.slice(nameStart, j).toLowerCase())) {
        // Look ahead for a tag close '>' before any '<'.
        let k = j;
        while (k < n && input[k] !== ">" && input[k] !== "<") k++;
        if (k < n && input[k] === ">") {
          removed++;
          i = k + 1;            // well-formed open/close tag: drop '<' .. '>' inclusive
          continue;
        }
        removed++;
        i = j;                  // unclosed head: drop only '<' [ '/' ] name; keep what follows
        continue;
      }
      out.push("<");            // not an allowlisted tag: keep '<' literally
      i++;
      continue;
    }
    out.push(input[i]);
    i++;
  }
  return { text: out.join(""), removed };
}

/**
 * Strip leaked tool-grammar tags losslessly for content. Runs stripOnePass to a
 * fixpoint: a single pass cannot catch interleavings like "<sum<summary>mary>"
 * where removing the inner tag makes the outer fragments adjacent, so we re-pass
 * until stable. Real leaked payloads carry sequential tags and converge in one
 * pass. No truncation, no regex backtracking, no exponential blowup.
 *
 * Invariant: detectToolGrammarLeak({f: stripToolGrammarTags(x).text}) === null.
 * Idempotent. `removed` counts the tag tokens dropped across all passes.
 */
export function stripToolGrammarTags(input: string): { text: string; removed: number } {
  if (!input || input.indexOf("<") === -1) return { text: input ?? "", removed: 0 };
  let text = input;
  let removed = 0;
  for (;;) {
    const pass = stripOnePass(text);
    if (pass.removed === 0) break;
    removed += pass.removed;
    text = pass.text;
  }
  return { text, removed };
}

/**
 * Apply stripToolGrammarTags to every string field and every string element of
 * array fields. Returns a shallow-cloned args object with sanitized values plus
 * the names of the fields that changed. Non-string/non-array values pass through.
 */
/**
 * Recursively sanitize a value: strings are stripped, arrays recurse (mirrors
 * normalizeStringList's nested-array flattening, so a tag nested inside a nested
 * array cannot reach persisted bridge content from a non-conforming client),
 * everything else passes through unchanged.
 */
function sanitizeValueDeep(v: unknown): { value: unknown; changed: boolean } {
  if (typeof v === "string") {
    const r = stripToolGrammarTags(v);
    return { value: r.text, changed: r.removed > 0 };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const value = v.map(item => {
      const r = sanitizeValueDeep(item);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value, changed };
  }
  return { value: v, changed: false };
}

export function sanitizeArgsToolGrammar(
  args: Record<string, unknown> | undefined,
): { args: Record<string, unknown>; fields: string[] } {
  const fields = new Set<string>();
  if (!args) return { args: {}, fields: [] };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const r = sanitizeValueDeep(v);
    out[k] = r.value;
    if (r.changed) fields.add(k);
  }
  return { args: out, fields: [...fields] };
}

/**
 * Recovery-routing predicate (separate from the frozen rejection detector):
 * triggered iff sanitizing would remove at least one tool-grammar tag token from
 * any string field or array element. Catches opening tags, closing tags, and
 * unclosed heads, in strings and arrays.
 */
export function shouldRecover(
  args: Record<string, unknown> | undefined,
): { triggered: boolean; fields: string[] } {
  const { fields } = sanitizeArgsToolGrammar(args);
  return { triggered: fields.length > 0, fields };
}

/**
 * Visible banner recorded in the journal and MEMORY entry when a handoff is
 * reconstructed from a leaked payload. ASCII only; names only; no user content.
 */
export function formatRecoveryNotice(sanitizedFields: string[], missingFields: string[]): string {
  if (sanitizedFields.length === 0 && missingFields.length === 0) return "";
  const lines = [
    "### Recovered Handoff",
    "- Reconstructed from a payload that leaked tool-grammar (XML-style tags inside a string field).",
  ];
  if (sanitizedFields.length > 0) {
    lines.push(`- Tool-grammar tags stripped from: ${sanitizedFields.join(", ")}. All other content preserved verbatim.`);
  }
  if (missingFields.length > 0) {
    lines.push(`- Missing required field(s) filled with placeholders: ${missingFields.join(", ")}. Treat field separation as approximate.`);
  }
  return lines.join("\n");
}
