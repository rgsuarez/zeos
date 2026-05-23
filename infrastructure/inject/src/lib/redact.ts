export interface RedactionResult {
  text: string;
  count: number;
  labels: string[];
}

export interface RedactionPattern {
  label: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
}

/**
 * Generic, readable redaction rules. Three classes only:
 *
 *   - ENV_SECRET: env-style assignment of a secret-named key. The value
 *     gets replaced; the key name is preserved so downstream logs still
 *     describe what was held.
 *   - BEARER_TOKEN: an Authorization-style Bearer with a length floor
 *     to avoid matching prose like "Bearer of bad news".
 *   - PRIVATE_KEY: full PEM-encoded private key block.
 *
 * Provider-specific signatures (AWS, GitHub, Slack, Stripe, Anthropic,
 * OpenAI, Notion, Linear, Google) are intentionally not encoded here:
 * the env-style rule catches them when they sit in env-shape fixtures
 * or assignment-shape prose, and the Bearer rule catches them when
 * they sit in Authorization headers. Generic rules keep this file
 * free of literal token signatures that secret scanners flag in code.
 */
export const SECRET_PATTERNS: RedactionPattern[] = [
  {
    label: "ENV_SECRET",
    pattern: /\b(api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|password|passwd|token|secret)(\s*[:=]\s*)(["']?)([A-Za-z0-9+/_\-.=]{20,})\3/gi,
    replacement: (_match, key, sep, quote) => `${key}${sep}${quote}[REDACTED:ENV_SECRET]${quote}`,
  },
  {
    label: "BEARER_TOKEN",
    pattern: /\bBearer\s+[A-Za-z0-9._\-+/]{16,}=*/g,
    replacement: "Bearer [REDACTED:BEARER]",
  },
  {
    label: "PRIVATE_KEY",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED |PRIVATE )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED |PRIVATE )?PRIVATE KEY-----/g,
    replacement: "[REDACTED:PRIVATE_KEY]",
  },
];

export function redactSensitiveText(input: string): RedactionResult {
  let text = input || "";
  let count = 0;
  const labels = new Set<string>();

  for (const secretPattern of SECRET_PATTERNS) {
    text = text.replace(secretPattern.pattern, (...args: any[]) => {
      const match = args[0] as string;
      // Skip if the match looks like an already-applied marker; this keeps
      // the pass idempotent against `[REDACTED:...]` text in input.
      if (!match || match.includes("[REDACTED:")) return match;
      count += 1;
      labels.add(secretPattern.label);
      if (typeof secretPattern.replacement === "function") {
        return secretPattern.replacement(...(args as [string, ...string[]]));
      }
      return secretPattern.replacement;
    });
  }

  return { text, count, labels: [...labels].sort() };
}

export function mergeRedactions(...results: RedactionResult[]): RedactionResult {
  const labels = new Set<string>();
  let count = 0;
  for (const result of results) {
    count += result.count;
    for (const label of result.labels) labels.add(label);
  }
  return { text: "", count, labels: [...labels].sort() };
}

export function formatRedactionNotice(redactions: RedactionResult): string {
  if (redactions.count === 0) return "";
  const labels = redactions.labels.length > 0 ? ` (${redactions.labels.join(", ")})` : "";
  return `\n### Redactions\n- ${redactions.count} sensitive value(s) redacted before persistence${labels}.\n`;
}
