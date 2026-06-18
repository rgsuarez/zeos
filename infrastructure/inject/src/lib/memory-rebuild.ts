import * as fs from "node:fs";
import * as path from "node:path";
import { expandPath } from "../path-resolver.js";
import {
  listJournalMetas,
  hasSessionEndBlock,
  extractJournalSummary,
  type JournalMeta,
} from "./journal.js";
import {
  MEMORY_ENTRY_DECAY_DEFAULT,
  MEMORY_ENTRY_IMPORTANCE_DEFAULT,
  MEMORY_PROMOTION_IMPORTANCE_THRESHOLD,
  formatMemoryEntryContent,
  parseMemoryMd,
  formatMemoryMd,
  durableMemoryEntryIdentity,
  curateMemory,
  type MemoryEntry,
  type ParsedMemory,
} from "./memory.js";

/**
 * Rebuild MEMORY.md as a regenerable VIEW over the journal log.
 *
 * North star: MEMORY.md is not fragile single-copy state. Its CONTENT and its
 * decay MODEL can be re-derived deterministically from the append-only journal
 * `## Session End:` blocks, so a corrupt/lost MEMORY.md is recoverable.
 *
 * What regenerates vs what is preserved vs what is unrecoverable:
 *   - REGENERATED from journals: each entry's body (Summary / Final Bridge /
 *     Next Actions / Tags / References / Source Journal), and the decay SEED +
 *     relative-age model.
 *   - PRESERVED (forward-carried) from the CURRENT MEMORY.md / MEMORY_ARCHIVE.md:
 *     `promoted`, `importance`, pin state (importance at/above the promotion
 *     threshold), and archived-vs-active placement. These are operator-set
 *     curation deltas that are NOT in the journal log, so a naive rebuild would
 *     silently destroy them.
 *   - UNRECOVERABLE: entries deleted by past manual curation. A deletion is a
 *     state mutation with no journal-log counterpart (the journal that produced
 *     the entry may itself be gone or was never a `## Session End:` capture), so
 *     it cannot be reconstructed. This tool says so; it never claims lossless
 *     reconstruction.
 *
 * Forward-carry matching is FAIL-CLOSED:
 *   - PRIMARY key: the durable per-entry identity (`durableMemoryEntryIdentity`,
 *     i.e. the Source Journal path), which is unique per captured session and
 *     survives active<->archive moves unchanged.
 *   - FALLBACK key: `date::title`, used ONLY for a current entry that has no
 *     durable id, and ONLY when it is collision-free. Two current entries that
 *     share a date and title (and lack a durable id) are AMBIGUOUS: metadata is
 *     NOT attached to any rebuilt entry on that key, because attaching to the
 *     wrong same-day duplicate would silently corrupt the audit state.
 *   - A currently-`promoted` or pinned entry that has NO match among the rebuilt
 *     entries is a hard conflict: the rebuild would drop a durable audit marker.
 *     The tool refuses to commit and reports the conflict.
 */

export interface RebuildOptions {
  /** Token limit handed to curateMemory; defaults to 10000 (the model default). */
  tokenLimit?: number;
  /**
   * Current MEMORY.md content (for forward-carry). Omit/empty when there is no
   * existing MEMORY.md (a pure from-scratch rebuild, nothing to preserve).
   */
  currentMemory?: string;
  /** Current MEMORY_ARCHIVE.md content (for forward-carry of archive placement). */
  currentArchive?: string;
  /** Project display name for the rebuilt header; defaults to "" (filled by caller). */
  projectName?: string;
}

/** A single rebuilt entry plus the provenance of its forward-carried metadata. */
export interface RebuiltEntryProvenance {
  date: string;
  title: string;
  sourceJournal: string;
  /** How curation metadata was attached: by durable id, by date+title, or not at all. */
  carry: "durable" | "date-title" | "none";
  promoted: boolean;
  importance: number;
  placement: "active" | "archive";
}

/** A currently-curated fact that the rebuild could not preserve. */
export interface CarryConflict {
  kind: "dropped-promoted" | "dropped-pinned";
  date: string;
  title: string;
  sourceJournal: string | null;
  reason: string;
}

export interface RebuildResult {
  /** The rebuilt memory (active + archived entries), curated to the token limit. */
  rebuilt: ParsedMemory;
  /** Per-entry provenance of the rebuild + forward-carry. */
  provenance: RebuiltEntryProvenance[];
  /** Number of journal `## Session End:` blocks that produced an entry. */
  journalEntryCount: number;
  /** Current entries (by date+title) that have no rebuilt counterpart and were
   * deleted by past curation, so are unrecoverable from the journal log. */
  unrecoverable: { date: string; title: string; sourceJournal: string | null }[];
  /** Hard conflicts (a promoted/pinned current entry the rebuild would drop). */
  conflicts: CarryConflict[];
  /** False when conflicts are present: the commit path must refuse. */
  canCommit: boolean;
  /** Human-readable diff vs the current MEMORY.md (active set). */
  diff: string;
}

/**
 * Carry-forward metadata extracted from a current entry, keyed for re-attachment.
 */
interface CarriedMetadata {
  promoted: boolean;
  importance: number;
  /** Whether the entry was archived (cold) vs active in the current state. */
  isArchived: boolean;
  /** For conflict reporting. */
  date: string;
  title: string;
  sourceJournal: string | null;
}

/** True when an entry is "pinned" in the operator sense: importance has been
 * raised to or above the promotion/retention threshold, so curateMemory will
 * refuse to auto-archive it. Used to fail-closed on a would-drop. */
function isPinned(meta: { importance: number }): boolean {
  return meta.importance >= MEMORY_PROMOTION_IMPORTANCE_THRESHOLD;
}

/**
 * Extract a single `### <Section>` block from the body region of a journal's
 * `## Session End:` block. Anchored to the Session End region only (callers pass
 * that slice) and stops at the next `###`, `##`, an HR, or end of text.
 */
function extractSection(endRegion: string, section: string): string {
  const re = new RegExp(`### ${section}\\n([\\s\\S]*?)(?=\\n### |\\n## |\\n---|$)`);
  const m = endRegion.match(re);
  return m && m[1] ? m[1].trim() : "";
}

/** Parse a `### Tags` / `### References` list section into a string[]. */
function parseListSection(endRegion: string, section: string): string[] {
  const raw = extractSection(endRegion, section);
  if (!raw) return [];
  return raw
    .split("\n")
    .map(line => line.replace(/^[-*]\s+/, "").trim())
    .filter(line => line.length > 0);
}

/** Isolate the `## Session End:` block body of a journal (drops anything before
 * it, e.g. the inherited carry-forward and the in-session work, which are not
 * memory content). Returns null when the journal has no Session End block. */
function sessionEndRegion(content: string): string | null {
  const idx = content.search(/^## Session End:/m);
  if (idx === -1) return null;
  return content.slice(idx);
}

/**
 * Turn one journal's `## Session End:` block into a MemoryEntry. The body is
 * built through the SAME `formatMemoryEntryContent` the live `/end` path uses,
 * so a rebuilt entry is byte-shaped like a natively-written one (and carries the
 * Source Journal pointer that is its durable identity). `decay`/`importance`/
 * `promoted` are seeded here and corrected by forward-carry + relative aging.
 */
function journalToEntry(meta: JournalMeta, absoluteJournalPath: string): MemoryEntry {
  const region = sessionEndRegion(meta.content) ?? meta.content;

  const summary = extractJournalSummary(region) ?? "";
  const finalBridge = extractSection(region, "Final Bridge");
  const nextActions = extractSection(region, "Next Actions");
  const tags = parseListSection(region, "Tags");
  const refs = parseListSection(region, "References");

  const content = formatMemoryEntryContent(
    summary,
    finalBridge,
    nextActions,
    absoluteJournalPath,
    { count: 0, labels: [] },
    "", // Why: not part of the Session End block
    "", // How to Apply: not part of the Session End block
    refs,
    "" // recovery notice: not regenerated
  );

  return {
    date: meta.sessionId.slice(0, 10), // YYYY-MM-DD from the session id
    title: summary ? firstLineTitle(summary) : meta.sessionId,
    decay: MEMORY_ENTRY_DECAY_DEFAULT,
    importance: MEMORY_ENTRY_IMPORTANCE_DEFAULT,
    tags,
    refs,
    promoted: false,
    content,
    isArchived: false,
  };
}

/** First non-empty line of the summary, capped, as the entry title (mirrors the
 * live titleFromSummary behavior closely enough for a regenerated view). */
function firstLineTitle(summary: string): string {
  const line = summary.split("\n").map(s => s.trim()).find(s => s.length > 0) ?? summary.trim();
  return line.substring(0, 150);
}

/**
 * Build the forward-carry index from the current MEMORY + ARCHIVE.
 *
 * Two maps:
 *   - byDurable: durable id -> metadata (always unique; the durable id is unique
 *     per captured session).
 *   - byDateTitle: `date::title` -> metadata[] (a LIST, so a same-day duplicate
 *     is detectable and the fallback can fail closed on it). Only entries that
 *     LACK a durable id are eligible for the date+title fallback; an entry with
 *     a durable id is matched by that id alone.
 */
function buildCarryIndex(parsed: ParsedMemory): {
  byDurable: Map<string, CarriedMetadata>;
  byDateTitle: Map<string, CarriedMetadata[]>;
  all: CarriedMetadata[];
} {
  const byDurable = new Map<string, CarriedMetadata>();
  const byDateTitle = new Map<string, CarriedMetadata[]>();
  const all: CarriedMetadata[] = [];

  const ingest = (entry: MemoryEntry, isArchived: boolean) => {
    const durable = durableMemoryEntryIdentity(entry);
    const sourceMatch = entry.content.match(/### Source Journal\n([^\n]+)/);
    const meta: CarriedMetadata = {
      promoted: entry.promoted,
      importance: entry.importance ?? MEMORY_ENTRY_IMPORTANCE_DEFAULT,
      isArchived,
      date: entry.date,
      title: entry.title,
      sourceJournal: sourceMatch ? sourceMatch[1].trim() : null,
    };
    all.push(meta);
    if (durable) {
      byDurable.set(durable, meta);
    } else {
      const key = `${entry.date}::${entry.title}`;
      const list = byDateTitle.get(key) ?? [];
      list.push(meta);
      byDateTitle.set(key, list);
    }
  };

  for (const e of parsed.entries) ingest(e, false);
  for (const e of parsed.archivedEntries) ingest(e, true);

  return { byDurable, byDateTitle, all };
}

/**
 * Apply relative-session-age decay. The newest captured session keeps the full
 * seed; each older session (by recency rank) has its decay stepped down by one
 * per rank, floored at 0. This reproduces the live model where each elapsed
 * session calls ageMemoryEntries once (decrementing every entry), so the
 * recency ORDER of entries is preserved deterministically by the rebuild.
 *
 * `entriesNewestFirst` MUST be ordered newest-first.
 */
function applyRelativeAge(entriesNewestFirst: MemoryEntry[]): void {
  entriesNewestFirst.forEach((entry, rank) => {
    entry.decay = Math.max(0, MEMORY_ENTRY_DECAY_DEFAULT - rank);
  });
}

export function rebuildMemoryFromJournals(
  journalDir: string,
  opts: RebuildOptions = {}
): RebuildResult {
  const tokenLimit = opts.tokenLimit ?? 10000;
  const expandedDir = expandPath(journalDir);

  // 1. List journals (newest-first) and keep only those with a Session End block.
  const metas = listJournalMetas(journalDir).filter(m => hasSessionEndBlock(m.content));

  // 2. Regenerate one entry per Session End block. Each carries its Source
  //    Journal absolute path (the durable identity).
  const rebuiltEntries: MemoryEntry[] = metas.map(meta =>
    journalToEntry(meta, path.join(expandedDir, meta.file))
  );

  // 3. Relative-age decay by recency (metas are newest-first).
  applyRelativeAge(rebuiltEntries);

  // 4. Forward-carry curation metadata from the CURRENT state.
  const current: ParsedMemory | null = (opts.currentMemory ?? "").trim()
    ? parseMemoryMd(opts.currentMemory ?? "", opts.currentArchive ?? "")
    : null;

  const provenance: RebuiltEntryProvenance[] = [];
  const matchedCurrent = new Set<CarriedMetadata>();

  let carry: ReturnType<typeof buildCarryIndex> | null = null;
  if (current) carry = buildCarryIndex(current);

  // Count rebuilt entries per date+title key. The date+title FALLBACK is only
  // safe when the key is unique on BOTH sides: a key shared by two rebuilt
  // entries is just as ambiguous as one shared by two current entries, and
  // attaching the same legacy metadata to both rebuilt entries would corrupt the
  // audit state. So the fallback is suppressed whenever >1 rebuilt entry shares
  // the key (fail-closed from the rebuilt side too).
  const rebuiltKeyCount = new Map<string, number>();
  for (const e of rebuiltEntries) {
    const key = `${e.date}::${e.title}`;
    rebuiltKeyCount.set(key, (rebuiltKeyCount.get(key) ?? 0) + 1);
  }

  for (const entry of rebuiltEntries) {
    const durable = durableMemoryEntryIdentity(entry);
    const sourceMatch = entry.content.match(/### Source Journal\n([^\n]+)/);
    const sourceJournal = sourceMatch ? sourceMatch[1].trim() : entry.title;

    let attached: CarriedMetadata | null = null;
    let carryKind: RebuiltEntryProvenance["carry"] = "none";

    if (carry) {
      // PRIMARY: match by durable id (Source Journal). A rebuilt entry always
      // has one, but the CURRENT entry it should inherit from may be a legacy
      // entry that lacks a Source Journal line (so it lives only in byDateTitle).
      if (durable) {
        const hit = carry.byDurable.get(durable);
        if (hit) {
          attached = hit;
          carryKind = "durable";
        }
      }
      // FALLBACK: on a durable miss, fall through to date+title, but ONLY when
      // that key is collision-free in the current state (fail-closed). The two
      // index maps are disjoint (byDurable holds entries WITH a durable id,
      // byDateTitle holds entries WITHOUT one), so this fallback can never steal
      // a durable-keyed entry's metadata; it only adopts a legacy current entry.
      if (!attached) {
        const key = `${entry.date}::${entry.title}`;
        const candidates = carry.byDateTitle.get(key) ?? [];
        const uniqueOnRebuiltSide = (rebuiltKeyCount.get(key) ?? 0) === 1;
        if (candidates.length === 1 && uniqueOnRebuiltSide) {
          attached = candidates[0];
          carryKind = "date-title";
        }
        // Skip the fallback when the key is ambiguous on EITHER side: >1 current
        // entry shares it (candidates.length > 1) OR >1 rebuilt entry shares it
        // (!uniqueOnRebuiltSide) OR there is no current match (0). Never guess
        // which duplicate owns the metadata.
      }
    }

    if (attached) {
      entry.promoted = attached.promoted;
      entry.importance = attached.importance;
      entry.isArchived = attached.isArchived;
      matchedCurrent.add(attached);
    }

    provenance.push({
      date: entry.date,
      title: entry.title,
      sourceJournal,
      carry: carryKind,
      promoted: entry.promoted,
      importance: entry.importance,
      placement: entry.isArchived ? "archive" : "active",
    });
  }

  // 5. Conflicts + unrecoverable: any current entry NOT matched by a rebuilt
  //    entry was either deleted by past curation (unrecoverable) or, if it is
  //    promoted/pinned, a hard conflict that blocks commit (the rebuild would
  //    drop a durable audit marker / operator pin).
  const conflicts: CarryConflict[] = [];
  const unrecoverable: { date: string; title: string; sourceJournal: string | null }[] = [];

  if (carry) {
    for (const meta of carry.all) {
      if (matchedCurrent.has(meta)) continue;
      if (meta.promoted) {
        conflicts.push({
          kind: "dropped-promoted",
          date: meta.date,
          title: meta.title,
          sourceJournal: meta.sourceJournal,
          reason:
            "Currently promoted (durable SOUL audit marker) but no journal Session End block reproduces it; a rebuild would silently drop the promotion marker.",
        });
      } else if (isPinned(meta)) {
        conflicts.push({
          kind: "dropped-pinned",
          date: meta.date,
          title: meta.title,
          sourceJournal: meta.sourceJournal,
          reason: `Currently pinned (importance ${meta.importance} >= ${MEMORY_PROMOTION_IMPORTANCE_THRESHOLD}) but no journal Session End block reproduces it; a rebuild would drop an operator-pinned entry.`,
        });
      } else {
        unrecoverable.push({
          date: meta.date,
          title: meta.title,
          sourceJournal: meta.sourceJournal,
        });
      }
    }
  }

  // 6. Assemble the rebuilt ParsedMemory, partitioning by the (possibly
  //    forward-carried) archive placement, then run curateMemory on the active
  //    set so the rebuilt view honors the token limit exactly as a live write
  //    would. Forward-carried promoted/importance flow into curateMemory's
  //    retention math, so pinned/promoted entries are never auto-archived.
  const activeEntries = rebuiltEntries.filter(e => !e.isArchived);
  const archivedEntries = rebuiltEntries.filter(e => e.isArchived);

  const rebuilt: ParsedMemory = {
    frontmatter: current?.frontmatter ?? {
      document: "MEMORY",
      purpose: "Rolling synopsis of session work - long-term memory tier",
    },
    projectName: opts.projectName ?? current?.projectName ?? "",
    entries: activeEntries,
    archivedEntries,
    continuityDigest: current?.continuityDigest,
  };

  curateMemory(rebuilt, tokenLimit);

  const diff = buildDiff(current, rebuilt);

  return {
    rebuilt,
    provenance,
    journalEntryCount: rebuiltEntries.length,
    unrecoverable,
    conflicts,
    canCommit: conflicts.length === 0,
    diff,
  };
}

/** A compact, deterministic diff of active-entry titles current -> rebuilt. */
function buildDiff(current: ParsedMemory | null, rebuilt: ParsedMemory): string {
  const key = (e: MemoryEntry) =>
    durableMemoryEntryIdentity(e) ?? `dt::${e.date}::${e.title}`;

  const currentActive = new Map<string, MemoryEntry>();
  if (current) for (const e of current.entries) currentActive.set(key(e), e);

  const rebuiltActive = new Map<string, MemoryEntry>();
  for (const e of rebuilt.entries) rebuiltActive.set(key(e), e);

  const added: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];

  for (const [k, e] of rebuiltActive) {
    if (currentActive.has(k)) kept.push(`${e.date}: ${e.title}`);
    else added.push(`${e.date}: ${e.title}`);
  }
  for (const [k, e] of currentActive) {
    if (!rebuiltActive.has(k)) removed.push(`${e.date}: ${e.title}`);
  }

  const lines: string[] = [];
  lines.push(`Active entries: current ${current ? current.entries.length : 0} -> rebuilt ${rebuilt.entries.length}`);
  lines.push(`Archived entries (rebuilt): ${rebuilt.archivedEntries.length}`);
  if (added.length) lines.push(`  + ${added.length} regenerated/new:\n     ${added.join("\n     ")}`);
  if (removed.length) lines.push(`  - ${removed.length} no longer in active set:\n     ${removed.join("\n     ")}`);
  if (kept.length) lines.push(`  = ${kept.length} content-regenerated in place`);
  return lines.join("\n");
}
