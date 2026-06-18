import * as fs from "node:fs";
import {
  parseMemoryMd,
  formatMemoryMd,
  type MemoryEntry,
  type ParsedMemory,
} from "./memory.js";
import { atomicWriteFileSync, atomicWriteWithBackup, assertNoSecrets } from "./atomic-write.js";
import { acquireMemoryLock, releaseMemoryLock } from "./memory-lock.js";

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

  // Real commit. The MEMORY read-modify-write (read -> set [promoted:true] ->
  // write) must be serialized against a concurrent locked /end or
  // zeos_memory_curate, or a stale read here would clobber their write and lose
  // the promotion marker (the lost-update class). Hold the memory lock for the
  // WHOLE MEMORY cycle, mirroring the curate handler in index.ts.
  const lockAcquired = acquireMemoryLock(opts.memoryPath);
  if (!lockAcquired) {
    return {
      promoted: false,
      dryRun: false,
      error:
        "Could not acquire MEMORY.md lock (parallel write in progress). Retry the promote shortly.",
    };
  }

  try {
    // Re-read MEMORY INSIDE the held lock so the marker is applied to the
    // freshest committed state (a concurrent /end may have added entries since
    // the pre-lock read).
    const freshContent = fs.readFileSync(opts.memoryPath, "utf-8");
    const freshParsed = parseMemoryMd(freshContent);
    const freshSelected = selectEntry(freshParsed, opts.entryDate, opts.entryTitle);
    if ("error" in freshSelected) {
      return { promoted: false, dryRun: false, error: freshSelected.error };
    }
    const freshEntry = freshSelected.entry;

    // PREFLIGHT before SOUL is touched (atomicity of the two-file commit).
    // SOUL is written first and has no .bak/rollback of its own, so if the
    // paired MEMORY marker write later aborts, SOUL is already committed while
    // MEMORY stays unmarked: a divergent, unrecoverable audit state. The only
    // way that write aborts is the pre-existing-target redaction halt inside
    // atomicWriteWithBackup (a legacy secret-shaped value already on disk in
    // MEMORY). Assert the SAME gate here, inside the held lock and BEFORE the
    // SOUL write, so a dirty MEMORY aborts the whole promote with SOUL untouched
    // rather than half-committed. The marker mutation is in-memory and cannot
    // introduce a new secret, so the only failure mode this needs to front-run
    // is the dirty prior MEMORY.
    assertNoSecrets(freshContent, "promote-preflight-memory", opts.memoryPath);

    // Write SOUL first (idempotent insert). SOUL has no concurrent-writer
    // contract of its own; the memory lock guards the marker write that pairs
    // with it, and the preflight above guarantees the paired MEMORY write will
    // not abort on a dirty prior file after SOUL is already committed.
    if (!alreadyInSoul) {
      const headingEnd = (sectionMatch.index || 0) + sectionMatch[1].length;
      const nextSectionIdx = soulOriginal.slice(headingEnd).search(/\n## /);
      const insertAt = nextSectionIdx === -1 ? soulOriginal.length : headingEnd + nextSectionIdx;
      const soulUpdated = soulOriginal.slice(0, insertAt) + doctrineBlock + soulOriginal.slice(insertAt);
      atomicWriteFileSync(opts.soulPath, soulUpdated);
    }

    // Write the marker through atomicWriteWithBackup so the promotion-marker
    // write gets the same single-generation .bak snapshot as every other MEMORY
    // mutation. The preflight already proved the prior MEMORY is clean.
    if (!freshEntry.promoted) {
      freshEntry.promoted = true;
      atomicWriteWithBackup(opts.memoryPath, formatMemoryMd(freshParsed));
    }

    return { promoted: true, dryRun: false };
  } finally {
    releaseMemoryLock(opts.memoryPath);
  }
}
