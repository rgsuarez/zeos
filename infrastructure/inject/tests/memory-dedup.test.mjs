import test from "node:test";
import assert from "node:assert/strict";

import {
  parseMemoryMd,
  formatMemoryMd,
  dedupeMemoryEntries,
  memoryEntryIdentity,
  MEMORY_ENTRY_DECAY_DEFAULT,
} from "../dist/lib/memory.js";

// Build a MEMORY entry body carrying a Source Journal pointer (the primary
// dedup identity key).
function entryBody(journalPath) {
  return [
    "### Summary",
    "did some work",
    "",
    "### Final Bridge",
    "bridge text",
    "",
    "### Next Actions",
    "- next thing",
    "",
    "### Source Journal",
    journalPath,
  ].join("\n");
}

function memoryDoc(entries) {
  let out = "---\ndocument: MEMORY\n---\n\n# Project Memory: demo\n\n";
  for (const e of entries) {
    out += `## ${e.date}: ${e.title} [decay:${e.decay}] [importance:3]\n\n${e.body}\n\n---\n\n`;
  }
  return out;
}

function archiveDoc(entries) {
  let out = "# Project Memory Archive: demo\n\n*Cold storage*\n\n---\n\n";
  for (const e of entries) {
    out += `## ${e.date}: ${e.title} [decay:${e.decay}] [importance:3]\n\n${e.body}\n\n---\n\n`;
  }
  return out;
}

// ── memoryEntryIdentity ────────────────────────────────────────────────────

test("memoryEntryIdentity: prefers the Source Journal path", () => {
  const id = memoryEntryIdentity({
    date: "2026-06-10",
    title: "anything",
    content: entryBody("/x/2026-06-10-001-claude.md"),
  });
  assert.equal(id, "journal::/x/2026-06-10-001-claude.md");
});

test("memoryEntryIdentity: falls back to date::title when no Source Journal", () => {
  const id = memoryEntryIdentity({
    date: "2026-06-10",
    title: "no source",
    content: "### Summary\njust prose\n",
  });
  assert.equal(id, "dt::2026-06-10::no source");
});

test("memoryEntryIdentity: same journal path keeps identity across active/archive move", () => {
  const active = memoryEntryIdentity({ date: "2026-06-10", title: "A", content: entryBody("/x/j.md") });
  const archived = memoryEntryIdentity({ date: "2026-06-10", title: "A", content: entryBody("/x/j.md") });
  assert.equal(active, archived);
});

// ── crash-between-files: DESTINATION-first leaves a DUPLICATE, not a LOSS ───

test("crash during end-session curation (archive written, MEMORY not) leaves the entry in BOTH; load dedups to active", () => {
  // End-session curation writes ARCHIVE (destination) first, then MEMORY
  // (source) without the moved entry. A crash BETWEEN them leaves the moved
  // entry present in MEMORY (old copy) AND ARCHIVE (new copy): a duplicate.
  const journal = "/x/2026-06-09-002-claude.md";
  const movedEntry = { date: "2026-06-09", title: "Moved", decay: 1, body: entryBody(journal) };
  const keptEntry = { date: "2026-06-10", title: "Kept", decay: 5, body: entryBody("/x/keep.md") };

  // Post-crash on-disk state: MEMORY still has the moved entry; ARCHIVE has it too.
  const memoryContent = memoryDoc([keptEntry, movedEntry]);
  const archiveContent = archiveDoc([movedEntry]);

  const parsed = parseMemoryMd(memoryContent, archiveContent);

  // The duplicate is resolved: the entry exists exactly once, in active.
  const activeIds = parsed.entries.map(memoryEntryIdentity);
  const archiveIds = parsed.archivedEntries.map(memoryEntryIdentity);
  assert.ok(activeIds.includes(`journal::${journal}`), "moved entry survives in active (no loss)");
  assert.ok(!archiveIds.includes(`journal::${journal}`), "archived shadow dropped (no duplicate)");
  assert.equal(parsed.entries.length, 2, "kept + moved, deduped");
});

test("crash during promote (MEMORY written, ARCHIVE not) leaves the entry in BOTH; load dedups to active", () => {
  // /memory-curate promote writes MEMORY (destination) first, then ARCHIVE
  // (source) without the entry. A crash BETWEEN leaves the entry in MEMORY (new)
  // AND ARCHIVE (old): a duplicate, recoverable by keeping active.
  const journal = "/x/2026-06-01-001-claude.md";
  const promoted = { date: "2026-06-01", title: "Promoted", decay: 12, body: entryBody(journal) };
  const other = { date: "2026-06-02", title: "Other", decay: 4, body: entryBody("/x/other.md") };

  const memoryContent = memoryDoc([promoted]);
  const archiveContent = archiveDoc([promoted, other]);

  const parsed = parseMemoryMd(memoryContent, archiveContent);
  const activeIds = parsed.entries.map(memoryEntryIdentity);
  const archiveIds = parsed.archivedEntries.map(memoryEntryIdentity);
  assert.ok(activeIds.includes(`journal::${journal}`), "promoted entry present in active (no loss)");
  assert.ok(!archiveIds.includes(`journal::${journal}`), "archived shadow dropped");
  assert.ok(archiveIds.includes("journal::/x/other.md"), "the genuinely-archived entry is retained");
});

// ── dedupeMemoryEntries: no-op in the common (clean) case ───────────────────

test("dedupeMemoryEntries: no duplicates means no removals and lists are preserved", () => {
  const parsed = parseMemoryMd(
    memoryDoc([{ date: "2026-06-10", title: "A", decay: 5, body: entryBody("/x/a.md") }]),
    archiveDoc([{ date: "2026-06-09", title: "B", decay: 1, body: entryBody("/x/b.md") }])
  );
  // parseMemoryMd already deduped (clean); a second pass removes nothing.
  const { removed } = dedupeMemoryEntries(parsed);
  assert.equal(removed, 0);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.archivedEntries.length, 1);
});

test("dedupeMemoryEntries: a within-active duplicate collapses to one", () => {
  // Two active entries with the same Source Journal (pathological double-add).
  const journal = "/x/dup.md";
  const parsed = {
    frontmatter: {},
    projectName: "demo",
    entries: [
      { date: "2026-06-10", title: "First", decay: 5, importance: 3, tags: [], refs: [], promoted: false, content: entryBody(journal), isArchived: false },
      { date: "2026-06-10", title: "First copy", decay: 5, importance: 3, tags: [], refs: [], promoted: false, content: entryBody(journal), isArchived: false },
    ],
    archivedEntries: [],
  };
  const { removed } = dedupeMemoryEntries(parsed);
  assert.equal(removed, 1);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].title, "First", "first occurrence wins");
});

test("dedupeMemoryEntries round-trip through formatMemoryMd preserves the deduped entry content", () => {
  const journal = "/x/rt.md";
  const movedEntry = { date: "2026-06-09", title: "Moved", decay: 1, body: entryBody(journal) };
  const parsed = parseMemoryMd(memoryDoc([movedEntry]), archiveDoc([movedEntry]));
  const rendered = formatMemoryMd(parsed);
  // The journal pointer appears exactly once in the rendered active file.
  const occurrences = rendered.split(journal).length - 1;
  assert.equal(occurrences, 1, "deduped entry rendered exactly once");
});
