import * as fs from "node:fs";
import {
  parseMemoryMd,
  formatMemoryMd,
  type MemoryEntry,
  type ParsedMemory,
} from "./memory.js";
import { atomicWriteFileSync } from "./atomic-write.js";

export interface PromoteOptions {
  soulPath: string;
  memoryPath: string;
  entryDate: string;
  entryTitle?: string;
  section: string;
  /** When true (default), return a preview WITHOUT writing. Operator must pass false to commit. */
  dryRun?: boolean;
}

export interface PromoteResult {
  promoted: boolean;
  dryRun: boolean;
  preview?: string;
  error?: string;
}

interface DoctrineSections {
  why: string;
  howToApply: string;
}

/**
 * Lift only the doctrinal sections from a MEMORY entry body.
 *
 * Policy (Redline 3, tightened):
 *   - Summary body is NOT promoted. The MEMORY title becomes the pointer line
 *     in SOUL; the Summary lives only in MEMORY and is reachable via that
 *     pointer.
 *   - Why and How to Apply ARE promoted. They are durable doctrine.
 *   - Operational sections (Final Bridge, Next Actions, References,
 *     Source Journal, Redactions) are never promoted to identity doctrine.
 */
function extractDoctrineSections(body: string): DoctrineSections {
  const whyMatch = body.match(/### Why\n([\s\S]*?)(?=\n### |$)/);
  const howMatch = body.match(/### How to Apply\n([\s\S]*?)(?=\n### |$)/);
  return {
    why: whyMatch ? whyMatch[1].trim() : "",
    howToApply: howMatch ? howMatch[1].trim() : "",
  };
}

function buildDoctrineBlock(entryDate: string, entryTitle: string, sections: DoctrineSections): string {
  let out = `\n> Promoted from MEMORY ${entryDate}: ${entryTitle}\n\n`;
  if (sections.why) out += `**Why:** ${sections.why}\n\n`;
  if (sections.howToApply) out += `**How to apply:** ${sections.howToApply}\n\n`;
  return out;
}

/**
 * Locate the active MEMORY entry the operator wants to promote.
 *
 * Promotion is ACTIVE-MEMORY-ONLY by design: if an entry has decayed enough
 * to fall into MEMORY_ARCHIVE.md, the operator never elevated it to durable
 * doctrine, and silently promoting from archive would obscure that signal.
 * Operators who want to promote an archived entry must first surface it back
 * to active with `/memory-curate promote <date>` (or `unpin`/`pin` to restore
 * importance), then call this tool.
 *
 * Returns the unique matching active entry, or an error string describing
 * why no unique match was possible (missing date, ambiguity without title).
 */
function selectEntry(
  parsed: ParsedMemory,
  entryDate: string,
  entryTitle: string | undefined,
): { entry: MemoryEntry } | { error: string } {
  const candidates = parsed.entries.filter(e => e.date === entryDate);

  if (candidates.length === 0) {
    return { error: `Active entry for ${entryDate} not found in MEMORY.md (archived entries are not promotable; surface with /memory-curate first)` };
  }

  if (candidates.length > 1 && !entryTitle) {
    const titles = candidates.map(c => `"${c.title}"`).join(", ");
    return {
      error: `Multiple entries for ${entryDate} (${titles}); please specify entry_title.`,
    };
  }

  const chosen = entryTitle
    ? candidates.find(c => c.title === entryTitle)
    : candidates[0];
  if (!chosen) {
    return { error: `Entry "${entryTitle}" not found for ${entryDate}` };
  }

  return { entry: chosen };
}

export function promoteMemoryEntryToSoul(opts: PromoteOptions): PromoteResult {
  const dryRun = opts.dryRun !== false;

  if (!fs.existsSync(opts.soulPath)) {
    return { promoted: false, dryRun, error: `SOUL.md not found: ${opts.soulPath}` };
  }
  if (!fs.existsSync(opts.memoryPath)) {
    return { promoted: false, dryRun, error: `MEMORY.md not found: ${opts.memoryPath}` };
  }

  const memoryContent = fs.readFileSync(opts.memoryPath, "utf-8");
  // Promotion is active-MEMORY-only by design (see selectEntry doc).
  // MEMORY_ARCHIVE.md is intentionally NOT loaded: archived entries are not
  // promotable. Operators must restore them to active via /memory-curate first.
  const parsed = parseMemoryMd(memoryContent);

  const selected = selectEntry(parsed, opts.entryDate, opts.entryTitle);
  if ("error" in selected) {
    return { promoted: false, dryRun, error: selected.error };
  }
  const entry = selected.entry;

  const sections = extractDoctrineSections(entry.content);
  if (!sections.why && !sections.howToApply) {
    return {
      promoted: false,
      dryRun,
      error: "Entry has no Why or How to Apply content; nothing doctrinal to promote.",
    };
  }

  const soulOriginal = fs.readFileSync(opts.soulPath, "utf-8");
  const promotionMarker = `Promoted from MEMORY ${opts.entryDate}: ${entry.title}`;
  const alreadyInSoul = soulOriginal.includes(promotionMarker);

  const sectionRegex = new RegExp(`(^## ${opts.section}\\b[^\\n]*\\n)`, "m");
  const sectionMatch = soulOriginal.match(sectionRegex);
  if (!sectionMatch) {
    return {
      promoted: false,
      dryRun,
      error: `Section "## ${opts.section}" not found in SOUL.md`,
    };
  }

  const doctrineBlock = buildDoctrineBlock(opts.entryDate, entry.title, sections);
  const preview =
    `Would append to ## ${opts.section}:\n${doctrineBlock}\n` +
    `And mark MEMORY entry [promoted:true] (durable model-level marker).`;

  if (dryRun) {
    return { promoted: false, dryRun: true, preview };
  }

  // Real commit: write SOUL first (idempotent insert), then mark MEMORY entry
  // promoted via the model so the marker round-trips through parseMemoryMd /
  // formatMemoryMd and cannot be stripped by later curation or /end writes.
  if (!alreadyInSoul) {
    const headingEnd = (sectionMatch.index || 0) + sectionMatch[1].length;
    const nextSectionIdx = soulOriginal.slice(headingEnd).search(/\n## /);
    const insertAt = nextSectionIdx === -1 ? soulOriginal.length : headingEnd + nextSectionIdx;
    const soulUpdated = soulOriginal.slice(0, insertAt) + doctrineBlock + soulOriginal.slice(insertAt);
    atomicWriteFileSync(opts.soulPath, soulUpdated);
  }

  if (!entry.promoted) {
    entry.promoted = true;
    atomicWriteFileSync(opts.memoryPath, formatMemoryMd(parsed));
  }

  return { promoted: true, dryRun: false };
}
