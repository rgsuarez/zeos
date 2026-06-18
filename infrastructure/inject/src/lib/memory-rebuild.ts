import * as fs from "node:fs";
import * as path from "node:path";
import { expandPath } from "../path-resolver.js";
import { atomicWriteFileSync, atomicWriteWithBackup } from "./atomic-write.js";
import { titleFromSummary } from "./bridge.js";
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
  /**
   * Operator-supplied references from the CURRENT entry. The live `/end` path
   * does NOT write a `### References` section into the journal `## Session End:`
   * block, so refs cannot be re-derived from the journal log; they are a
   * curation delta that must be forward-carried like promoted/importance, or a
   * rebuild would silently erase them (rewrite the entry with refs=[]).
   */
  refs: string[];
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

/** Extract the `### References` list from a MEMORY entry BODY. Refs are persisted
 * as a body section (formatMemoryEntryContent), NOT as a heading token, so they
 * are read from `entry.content` for forward-carry (parseMemoryMd does not surface
 * them on entry.refs). Same list shape as parseListSection. */
function extractBodyRefs(content: string): string[] {
  return parseListSection(content, "References");
}

/** Byte ranges in `content` covered by fenced (```) code blocks, matching the
 * same paired-fence model `journal.ts#stripFencedCodeBlocks` uses for completion
 * detection. Used so the Session End locator ignores headings quoted inside a
 * fence exactly as `hasSessionEndBlock` does. */
function fencedRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** Isolate the `## Session End:` block body of a journal (drops anything before
 * it, e.g. the inherited carry-forward and the in-session work, which are not
 * memory content). Returns null when the journal has no Session End block.
 *
 * Fence-aware: `hasSessionEndBlock` (the journal filter that gates which
 * journals reach the rebuild) strips fenced code blocks before testing, so a
 * journal can pass the filter on a REAL appended block while ALSO containing an
 * earlier `## Session End:` heading quoted inside a code fence (e.g. a journal
 * that documents the end-block format). A raw `^## Session End:` search would
 * slice from that quoted heading and parse the wrong region. We skip headings
 * inside fenced ranges and anchor on the first REAL (unfenced) one, so the
 * region locator agrees with the completion detector. */
function sessionEndRegion(content: string): string | null {
  const fenced = fencedRanges(content);
  const re = /^## Session End:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const idx = m.index;
    const insideFence = fenced.some(([start, end]) => idx >= start && idx < end);
    if (!insideFence) return content.slice(idx);
  }
  return null;
}

/**
 * A rebuilt entry plus the journal-derived component sections needed to
 * regenerate its body. The body region must be rebuilt (not patched) when
 * forward-carry overrides refs, so the section pieces are kept alongside.
 */
interface RebuiltEntry {
  entry: MemoryEntry;
  /** The journal-derived body sections (refs is the journal-derived refs). */
  sections: {
    summary: string;
    finalBridge: string;
    nextActions: string;
    refs: string[];
    journalPath: string;
  };
}

/**
 * Render a rebuilt entry's body through the SAME `formatMemoryEntryContent` the
 * live `/end` path uses (so a rebuilt entry is byte-shaped like a
 * natively-written one and carries the Source Journal pointer that is its
 * durable identity). `refs` is passed explicitly so forward-carry can rebuild
 * the body with operator-supplied references that are not in the journal log.
 */
function renderEntryContent(
  sections: RebuiltEntry["sections"],
  refs: string[]
): string {
  return formatMemoryEntryContent(
    sections.summary,
    sections.finalBridge,
    sections.nextActions,
    sections.journalPath,
    { count: 0, labels: [] },
    "", // Why: not part of the Session End block
    "", // How to Apply: not part of the Session End block
    refs,
    "" // recovery notice: not regenerated
  );
}

/**
 * Turn one journal's `## Session End:` block into a MemoryEntry. `decay`/
 * `importance`/`promoted`/`refs` are seeded here and corrected by forward-carry
 * + relative aging. The title uses the live `titleFromSummary` derivation (NOT a
 * private approximation) so a rebuilt title byte-matches how `/end` actually
 * stored it, keeping the legacy date+title fallback match aligned.
 */
function journalToEntry(meta: JournalMeta, absoluteJournalPath: string): RebuiltEntry {
  const region = sessionEndRegion(meta.content) ?? meta.content;

  const summary = extractJournalSummary(region) ?? "";
  const finalBridge = extractSection(region, "Final Bridge");
  const nextActions = extractSection(region, "Next Actions");
  const tags = parseListSection(region, "Tags");
  // The journal `## Session End:` block has no `### References` section (the
  // live /end path never writes one), so this is normally empty; refs are
  // forward-carried from the current MEMORY entry instead (see the carry step).
  const refs = parseListSection(region, "References");

  const sections: RebuiltEntry["sections"] = {
    summary,
    finalBridge,
    nextActions,
    refs,
    journalPath: absoluteJournalPath,
  };

  const entry: MemoryEntry = {
    date: meta.sessionId.slice(0, 10), // YYYY-MM-DD from the session id
    title: summary ? titleFromSummary(summary) : meta.sessionId,
    decay: MEMORY_ENTRY_DECAY_DEFAULT,
    importance: MEMORY_ENTRY_IMPORTANCE_DEFAULT,
    tags,
    refs,
    promoted: false,
    content: renderEntryContent(sections, refs),
    isArchived: false,
  };

  return { entry, sections };
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
 *   - allKeyCount: `date::title` -> count across ALL current entries (durable-keyed
 *     AND legacy). The date+title fallback must be unique across the ENTIRE
 *     current set, not just among legacy entries: if a durable-keyed entry and a
 *     legacy entry share a date+title, the key is ambiguous even though only the
 *     legacy entry sits in byDateTitle, and attaching the legacy metadata to a
 *     rebuilt entry whose durable id belongs to the OTHER current entry would
 *     mis-attach. This count lets the fallback fail closed on that case.
 */
function buildCarryIndex(parsed: ParsedMemory): {
  byDurable: Map<string, CarriedMetadata>;
  byDateTitle: Map<string, CarriedMetadata[]>;
  allKeyCount: Map<string, number>;
  all: CarriedMetadata[];
} {
  const byDurable = new Map<string, CarriedMetadata>();
  const byDateTitle = new Map<string, CarriedMetadata[]>();
  const allKeyCount = new Map<string, number>();
  const all: CarriedMetadata[] = [];

  const ingest = (entry: MemoryEntry, isArchived: boolean) => {
    const durable = durableMemoryEntryIdentity(entry);
    const sourceMatch = entry.content.match(/### Source Journal\n([^\n]+)/);
    const meta: CarriedMetadata = {
      promoted: entry.promoted,
      importance: entry.importance ?? MEMORY_ENTRY_IMPORTANCE_DEFAULT,
      isArchived,
      // Refs live in the entry BODY (`### References`), not the heading:
      // formatEntryHeading emits no `[refs:...]` token, so parseMemoryMd leaves
      // entry.refs empty on a round-tripped doc. Read them from the body so a
      // forward-carry preserves the operator's actual references.
      refs: extractBodyRefs(entry.content),
      date: entry.date,
      title: entry.title,
      sourceJournal: sourceMatch ? sourceMatch[1].trim() : null,
    };
    all.push(meta);
    const dtKey = `${entry.date}::${entry.title}`;
    allKeyCount.set(dtKey, (allKeyCount.get(dtKey) ?? 0) + 1);
    if (durable) {
      byDurable.set(durable, meta);
    } else {
      const list = byDateTitle.get(dtKey) ?? [];
      list.push(meta);
      byDateTitle.set(dtKey, list);
    }
  };

  for (const e of parsed.entries) ingest(e, false);
  for (const e of parsed.archivedEntries) ingest(e, true);

  return { byDurable, byDateTitle, allKeyCount, all };
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
  //    Journal absolute path (the durable identity). The decomposed body
  //    sections are kept keyed by entry so the body can be re-rendered when
  //    forward-carry overrides refs (refs are not in the journal log).
  const rebuiltPairs = metas.map(meta =>
    journalToEntry(meta, path.join(expandedDir, meta.file))
  );
  const rebuiltEntries: MemoryEntry[] = rebuiltPairs.map(r => r.entry);
  const sectionsByEntry = new Map<MemoryEntry, RebuiltEntry["sections"]>();
  for (const r of rebuiltPairs) sectionsByEntry.set(r.entry, r.sections);

  // 3. Relative-age decay by recency (metas are newest-first).
  applyRelativeAge(rebuiltEntries);

  // 4. Forward-carry curation metadata from the CURRENT state.
  //
  // "Current state" is MEMORY.md OR MEMORY_ARCHIVE.md: an operator can promote
  // or pin an entry that has since been auto-curated into the archive, so a
  // promoted/pinned fact may live ONLY in MEMORY_ARCHIVE.md while MEMORY.md is
  // empty or missing. Gating solely on `currentMemory` would skip the carry
  // index and the fail-closed conflict check whenever MEMORY.md is empty, so an
  // archive-only promoted/pinned entry the rebuild cannot reproduce would be
  // silently dropped and `canCommit` would stay true (the core recovery
  // scenario this tool exists for: a lost/empty MEMORY.md with a surviving
  // archive). Build the index and run the conflict check whenever EITHER file
  // has content; parseMemoryMd tolerates an empty `content` and parses the
  // archive into archivedEntries.
  const hasCurrentState =
    (opts.currentMemory ?? "").trim().length > 0 ||
    (opts.currentArchive ?? "").trim().length > 0;
  const current: ParsedMemory | null = hasCurrentState
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
      // that key is collision-free in BOTH the entire current set AND the rebuilt
      // set (fail-closed). Uniqueness must hold across ALL current entries
      // (durable-keyed + legacy via allKeyCount), not just among legacy entries:
      // a legacy entry can be alone in byDateTitle yet share its date+title with a
      // DURABLE-keyed current entry, and adopting the legacy metadata for a
      // rebuilt entry whose durable id belongs to that other current entry would
      // mis-attach (and silently lose the durable-keyed entry's own metadata).
      if (!attached) {
        const key = `${entry.date}::${entry.title}`;
        const candidates = carry.byDateTitle.get(key) ?? [];
        const uniqueOnRebuiltSide = (rebuiltKeyCount.get(key) ?? 0) === 1;
        const uniqueAcrossAllCurrent = (carry.allKeyCount.get(key) ?? 0) === 1;
        if (candidates.length === 1 && uniqueOnRebuiltSide && uniqueAcrossAllCurrent) {
          attached = candidates[0];
          carryKind = "date-title";
        }
        // Skip the fallback when the key is ambiguous anywhere: >1 current entry
        // shares it among legacy (candidates.length > 1) OR across the full
        // current set (!uniqueAcrossAllCurrent, i.e. a durable-keyed sibling
        // shares it) OR >1 rebuilt entry shares it (!uniqueOnRebuiltSide) OR there
        // is no legacy match (0). Never guess which entry owns the metadata.
      }
    }

    if (attached) {
      entry.promoted = attached.promoted;
      entry.importance = attached.importance;
      entry.isArchived = attached.isArchived;
      // Forward-carry operator-supplied references. The journal `## Session End:`
      // block has no References section, so a rebuilt entry's refs are otherwise
      // always [] and a commit would erase refs the operator added to MEMORY.
      // When the carried entry has refs, adopt them AND re-render the body so the
      // `### References` section is present in the persisted content (refs live
      // only in the body, not the heading). When the carried entry has no refs,
      // leave the journal-derived (empty) refs untouched.
      if (attached.refs.length > 0) {
        entry.refs = attached.refs;
        const sections = sectionsByEntry.get(entry);
        if (sections) entry.content = renderEntryContent(sections, attached.refs);
      }
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
  // Entries archived by DELIBERATE forward-carried placement (before curation
  // runs). A promoted entry in this set was intentionally archived by the
  // operator and must KEEP its archive placement; only a promoted entry that
  // curateMemory archives anew should be rescued (finding 7). Identity by object
  // reference is exact here (same MemoryEntry instances flow through curation).
  const preCurationArchived = new Set<MemoryEntry>(archivedEntries);

  // Carry the current frontmatter but DROP its `token_estimate`. curateMemory
  // trusts `frontmatter.token_estimate` as the starting size (`... || estimate`),
  // so a stale estimate from the smaller current doc would make a rebuild that
  // GREW the entries skip curation and leave an oversized active MEMORY.md. With
  // the field cleared, curateMemory recomputes the true size from the rebuilt
  // content. (formatMemoryMd repopulates token_estimate on write.)
  const frontmatter: Record<string, any> = current?.frontmatter
    ? { ...current.frontmatter }
    : {
        document: "MEMORY",
        purpose: "Rolling synopsis of session work - long-term memory tier",
      };
  delete frontmatter.token_estimate;

  const rebuiltMemory: ParsedMemory = {
    frontmatter,
    projectName: opts.projectName ?? current?.projectName ?? "",
    entries: activeEntries,
    archivedEntries,
    continuityDigest: current?.continuityDigest,
  };

  curateMemory(rebuiltMemory, tokenLimit);

  // A `promoted` entry is a durable SOUL audit marker and must stay in the
  // ACTIVE set even when its importance is below curateMemory's active-retention
  // threshold (curateMemory keeps entries active only at importance >=
  // MEMORY_PROMOTION_IMPORTANCE_THRESHOLD, so a promoted-but-low-importance entry
  // could be archived). We do NOT change curateMemory (shared with /end); we undo
  // ONLY the curation-driven archival here, lifting a promoted entry curation
  // pushed into the archive back into active. A promoted entry that was already
  // archived by deliberate forward-carried placement keeps that placement.
  rescuePromotedFromArchive(rebuiltMemory, preCurationArchived);

  const diff = buildDiff(current, rebuiltMemory);

  return {
    rebuilt: rebuiltMemory,
    provenance,
    journalEntryCount: rebuiltEntries.length,
    unrecoverable,
    conflicts,
    canCommit: conflicts.length === 0,
    diff,
  };
}

/**
 * Lift any `promoted` entry that curateMemory pushed into the archive back into
 * the active set. A promoted entry is a durable SOUL audit marker; the rebuild
 * must keep it active even when its importance is below curateMemory's
 * active-retention threshold. This runs AFTER curateMemory and only ever moves
 * promoted entries archive -> active (it never archives anything), so it cannot
 * re-introduce a token overflow of NON-promoted entries; a promoted entry is
 * operator-pinned content that is intentionally retained regardless of size.
 *
 * `preCurationArchived` is the set of entries that were archived by DELIBERATE
 * forward-carried placement before curation. A promoted entry in that set is
 * respected (it stays archived because the operator put it there); only a
 * promoted entry that curateMemory archived ANEW is rescued.
 */
function rescuePromotedFromArchive(
  parsed: ParsedMemory,
  preCurationArchived: Set<MemoryEntry>
): void {
  const toRescue = parsed.archivedEntries.filter(
    e => e.promoted && !preCurationArchived.has(e)
  );
  if (toRescue.length === 0) return;
  const rescued = new Set<MemoryEntry>(toRescue);
  parsed.archivedEntries = parsed.archivedEntries.filter(e => !rescued.has(e));
  for (const entry of toRescue) {
    entry.isArchived = false;
    // Keep newest-first active ordering stable: a rescued promoted entry goes to
    // the front, mirroring how the live /end path unshifts the freshest entry.
    parsed.entries.unshift(entry);
  }
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

/**
 * Crash-safe two-file commit of a rebuilt memory. The single source of truth for
 * the MEMORY.md + MEMORY_ARCHIVE.md write ordering, so the handler and its tests
 * exercise the SAME code (the ordering is a crash-safety invariant, not a detail
 * to re-implement per call site).
 *
 * Caller contract: invoke ONLY after verifying `rebuilt` is committable
 * (canCommit) and while holding the MEMORY lock. This function performs no lock,
 * no canCommit gate, and no directory create; it is the write step only.
 *
 * Ordering, by whether the rebuild produced archived entries:
 *   - NON-ZERO archive: write the ARCHIVE (destination) BEFORE MEMORY (source) so
 *     a crash between them leaves a duplicate (collapsed by dedupe-on-load),
 *     never a loss. Both writes are individually crash-safe.
 *   - ZERO archive with a stale archive on disk: unlink the stale archive BEFORE
 *     the MEMORY write. The stale archive holds entries the rebuild dropped; if
 *     it survived, dedupe-on-load would resurrect them, contradicting the
 *     regenerable-view contract and the approved diff. The unlink must precede
 *     the MEMORY write so atomicWriteWithBackup's parent-directory fsync (the
 *     MEMORY rename is in the same directory) durably commits the archive removal
 *     too; unlinking AFTER opens a crash window where MEMORY is durable but the
 *     removal is not. A crash BEFORE the MEMORY write leaves the original MEMORY +
 *     archive, never a loss.
 */
export function commitRebuild(
  rebuilt: ParsedMemory,
  memoryPath: string,
  archivePath: string
): void {
  if (rebuilt.archivedEntries.length > 0) {
    atomicWriteFileSync(archivePath, formatMemoryMd(rebuilt, "archive"));
  } else if (fs.existsSync(archivePath)) {
    fs.unlinkSync(archivePath);
  }
  atomicWriteWithBackup(memoryPath, formatMemoryMd(rebuilt));
}
