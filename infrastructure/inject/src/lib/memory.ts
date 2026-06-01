import { formatListSection, normalizeStringList, normalizeTags, clampImportance } from "./bridge.js";

export const MEMORY_ENTRY_DECAY_DEFAULT = 12;
export const MEMORY_ENTRY_IMPORTANCE_DEFAULT = 3;
export const MEMORY_PROMOTION_IMPORTANCE_THRESHOLD = 4;

export interface MemoryEntry {
  date: string;
  title: string;
  decay: number;
  importance: number;
  tags: string[];
  refs: string[];
  /**
   * Durable audit marker. Set true when this entry was promoted into the
   * project SOUL via `zeos_soul_promote`. Persisted in the heading as
   * `[promoted:true]` so subsequent parseMemoryMd/formatMemoryMd cycles
   * (`/end` writes, curation, archive moves) cannot strip it.
   */
  promoted: boolean;
  content: string;
  isArchived: boolean;
}

export interface ParsedMemory {
  frontmatter: Record<string, any>;
  projectName: string;
  entries: MemoryEntry[];
  archivedEntries: MemoryEntry[];
  continuityDigest?: string;
}

export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).length;
  return Math.ceil(words * 1.8);
}

export function getMemoryTokenLimit(profileContent: string = ""): number {
  const match = profileContent.match(/memory_token_limit:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 10000;
}

export function formatMemoryEntryContent(
  summary: string,
  finalBridge: string,
  nextActions: string,
  journalPath: string | null,
  redactions: { count: number; labels: string[] },
  why: string = "",
  howToApply: string = "",
  refs: string[] = [],
  recoveryNotice: string = ""
): string {
  let output = "";
  if (recoveryNotice.trim()) output += `${recoveryNotice.trim()}\n\n`;
  output += `### Summary\n${summary.trim()}\n\n`;
  if (why.trim()) output += `### Why\n${why.trim()}\n\n`;
  if (howToApply.trim()) output += `### How to Apply\n${howToApply.trim()}\n\n`;
  output += `### Final Bridge\n${finalBridge.trim()}\n\n`;
  output += `### Next Actions\n${nextActions.trim()}\n`;
  if (refs.length > 0) output += `\n### References\n${formatListSection(refs)}\n`;
  if (journalPath) output += `\n### Source Journal\n${journalPath}\n`;
  if (redactions.count > 0) {
    const labels = redactions.labels.length > 0 ? ` (${redactions.labels.join(", ")})` : "";
    output += `\n### Redactions\n- ${redactions.count} sensitive value(s) redacted before persistence${labels}.\n`;
  }
  return output.trim();
}

export function formatEntryHeading(entry: MemoryEntry): string {
  let heading = `## ${entry.date}: ${entry.title} [decay:${entry.decay}]`;
  heading += ` [importance:${entry.importance ?? MEMORY_ENTRY_IMPORTANCE_DEFAULT}]`;
  if (entry.tags?.length) heading += ` [tags:${entry.tags.join(",")}]`;
  // Durable promotion audit marker. Emitted after tags so the trailing token is
  // easy to scan and the heading stays stable across active <-> archive moves.
  if (entry.promoted) heading += ` [promoted:true]`;
  return heading;
}

export function parseEntryHeadingTail(tail: string): Pick<MemoryEntry, "importance" | "tags" | "refs" | "promoted"> {
  const importanceMatch = tail.match(/\[importance:(\d+)\]/);
  const tagsMatch = tail.match(/\[tags:([^\]]*)\]/);
  const refsMatch = tail.match(/\[refs:([^\]]*)\]/);
  const promotedMatch = tail.match(/\[promoted:(true|false)\]/i);

  return {
    importance: importanceMatch
      ? clampImportance(importanceMatch[1])
      : MEMORY_ENTRY_IMPORTANCE_DEFAULT,
    tags: tagsMatch ? normalizeTags(tagsMatch[1]) : [],
    refs: refsMatch ? normalizeStringList(refsMatch[1]) : [],
    promoted: promotedMatch ? promotedMatch[1].toLowerCase() === "true" : false,
  };
}

export function memoryRetentionScore(entry: Pick<MemoryEntry, "decay" | "importance">): number {
  return Math.max(entry.decay, entry.importance ?? MEMORY_ENTRY_IMPORTANCE_DEFAULT);
}

export function ageMemoryEntries(parsed: ParsedMemory): void {
  for (const entry of parsed.entries) {
    entry.decay = Math.max(0, entry.decay - 1);
  }
}

function parseFrontmatter(content: string, target: ParsedMemory): void {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return;

  const fmLines = fmMatch[1].split("\n");
  for (const line of fmLines) {
    const [key, ...valueParts] = line.split(":");
    if (key && valueParts.length) {
      const value = valueParts.join(":").trim().replace(/^["']|["']$/g, "");
      target.frontmatter[key.trim()] = isNaN(Number(value)) ? value : Number(value);
    }
  }
}

function parseEntries(content: string, isArchived: boolean): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const entryRegex = /## (\d{4}-\d{2}-\d{2}): (.+?) \[decay:(\d+)\]([^\n]*)\n\n([\s\S]*?)(?=\n---|\n## \d{4}|## Continuity|$)/g;

  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(content)) !== null) {
    const headingMeta = parseEntryHeadingTail(match[4] || "");
    entries.push({
      date: match[1],
      title: match[2],
      decay: parseInt(match[3], 10),
      importance: headingMeta.importance,
      tags: headingMeta.tags,
      refs: headingMeta.refs,
      promoted: headingMeta.promoted,
      content: match[5].trim(),
      isArchived,
    });
  }
  return entries;
}

export function parseMemoryMd(content: string, archiveContent: string = ""): ParsedMemory {
  const result: ParsedMemory = {
    frontmatter: {},
    projectName: "",
    entries: [],
    archivedEntries: [],
  };

  parseFrontmatter(content, result);

  const nameMatch = content.match(/# Project Memory: (.+)/);
  if (nameMatch) result.projectName = nameMatch[1];

  const digestMatch = content.match(/## Continuity Digest\n\n([\s\S]*?)(?=\n## \d{4}|\n---\n|$)/);
  if (digestMatch) result.continuityDigest = digestMatch[0];

  result.entries = parseEntries(content, false);
  if (archiveContent) {
    result.archivedEntries = parseEntries(archiveContent, true);
  }

  return result;
}

export function formatMemoryMd(parsed: ParsedMemory, type: "active" | "archive" = "active"): string {
  if (type === "archive") {
    let output = `# Project Memory Archive: ${parsed.projectName}\n\n`;
    output += `*Cold storage for project memory entries moved from MEMORY.md*\n\n---\n\n`;
    for (const entry of parsed.archivedEntries) {
      output += `${formatEntryHeading(entry)}\n\n`;
      output += `${entry.content}\n\n`;
      output += "---\n\n";
    }
    return output;
  }

  parsed.frontmatter.entry_count = parsed.entries.length;
  parsed.frontmatter.archive_count = parsed.archivedEntries.length;
  parsed.frontmatter.last_updated = new Date().toISOString();

  let allContent = `# Project Memory: ${parsed.projectName}\n\n`;
  if (parsed.continuityDigest) {
    allContent += parsed.continuityDigest;
  }
  for (const entry of parsed.entries) {
    allContent += `${formatEntryHeading(entry)}\n\n${entry.content}\n\n---\n\n`;
  }
  parsed.frontmatter.token_estimate = estimateTokens(allContent);

  let output = "---\n";
  for (const [key, value] of Object.entries(parsed.frontmatter)) {
    if (typeof value === "string") {
      output += `${key}: "${value}"\n`;
    } else {
      output += `${key}: ${value}\n`;
    }
  }
  output += "---\n\n";

  output += `# Project Memory: ${parsed.projectName}\n\n`;

  if (parsed.continuityDigest) {
    output += parsed.continuityDigest.trimEnd() + "\n\n";
  }

  for (const entry of parsed.entries) {
    output += `${formatEntryHeading(entry)}\n\n`;
    output += `${entry.content}\n\n`;
    output += "---\n\n";
  }

  return output;
}

export function curateMemory(parsed: ParsedMemory, tokenLimit: number): { curated: ParsedMemory; movedEntries: MemoryEntry[] } {
  const movedEntries: MemoryEntry[] = [];
  let currentTokens = parsed.frontmatter.token_estimate || estimateTokens(formatMemoryMd(parsed));

  if (currentTokens <= tokenLimit) {
    return { curated: parsed, movedEntries: [] };
  }

  const sortedEntries = [...parsed.entries].sort((a, b) => memoryRetentionScore(a) - memoryRetentionScore(b));
  while (currentTokens > tokenLimit && sortedEntries.length > 0) {
    const entryToArchive = sortedEntries[0];
    if (entryToArchive.importance >= MEMORY_PROMOTION_IMPORTANCE_THRESHOLD) {
      break;
    }

    sortedEntries.shift();
    const archiveIdx = parsed.entries.indexOf(entryToArchive);
    if (archiveIdx !== -1) {
      parsed.entries.splice(archiveIdx, 1);
    }
    entryToArchive.isArchived = true;
    movedEntries.push(entryToArchive);
    parsed.archivedEntries.unshift(entryToArchive);
    currentTokens = estimateTokens(formatMemoryMd(parsed));
  }

  return { curated: parsed, movedEntries };
}
