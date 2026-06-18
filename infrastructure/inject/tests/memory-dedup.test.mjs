import test from "node:test";
import assert from "node:assert/strict";

import {
  parseMemoryMd,
  formatMemoryMd,
  dedupeMemoryEntries,
  memoryEntryIdentity,
  durableMemoryEntryIdentity,
  MEMORY_ENTRY_DECAY_DEFAULT,
} from "../dist/lib/memory.js";

// A legacy/manual entry body with NO Source Journal line (so no durable id).
function legacyBody(text) {
  return ["### Summary", text, "", "### Final Bridge", "bridge", "", "### Next Actions", "- thing"].join("\n");
}

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

// ---- durableMemoryEntryIdentity: null for non-durable entries (fail-closed)

test("durableMemoryEntryIdentity: returns the journal id when a Source Journal is present", () => {
  const id = durableMemoryEntryIdentity({ date: "2026-06-10", title: "A", content: entryBody("/x/j.md") });
  assert.equal(id, "journal::/x/j.md");
});

test("durableMemoryEntryIdentity: returns null when there is no Source Journal (no proven unique id)", () => {
  const id = durableMemoryEntryIdentity({ date: "2026-06-10", title: "no source", content: legacyBody("prose") });
  assert.equal(id, null);
});

// ---- P1-class: legacy/manual dedup must NOT collapse on date+title alone ---

test("two distinct legacy entries with identical date+title but distinct bodies both SURVIVE parse (no date+title collapse)", () => {
  // Neither entry has a Source Journal line, so neither has a durable id. They
  // share date AND title but are genuinely distinct (different bodies). The
  // fail-closed rule must keep BOTH; collapsing on date+title would silently
  // drop the later one (data loss).
  const a = { date: "2026-06-11", title: "Standup notes", decay: 5, body: legacyBody("morning decision A") };
  const b = { date: "2026-06-11", title: "Standup notes", decay: 5, body: legacyBody("afternoon decision B") };
  const parsed = parseMemoryMd(memoryDoc([a, b]));

  assert.equal(parsed.entries.length, 2, "both same-date same-title legacy entries survive");
  const bodies = parsed.entries.map(e => e.content);
  assert.ok(bodies.some(c => c.includes("morning decision A")), "first legacy entry retained");
  assert.ok(bodies.some(c => c.includes("afternoon decision B")), "second legacy entry retained");
});

test("dedupeMemoryEntries: two distinct legacy same-date same-title entries are NOT collapsed (removed == 0)", () => {
  const parsed = {
    frontmatter: {},
    projectName: "demo",
    entries: [
      { date: "2026-06-11", title: "Dup title", decay: 5, importance: 3, tags: [], refs: [], promoted: false, content: legacyBody("body one"), isArchived: false },
      { date: "2026-06-11", title: "Dup title", decay: 5, importance: 3, tags: [], refs: [], promoted: false, content: legacyBody("body two"), isArchived: false },
    ],
    archivedEntries: [],
  };
  const { removed } = dedupeMemoryEntries(parsed);
  assert.equal(removed, 0, "no durable id means no collapse");
  assert.equal(parsed.entries.length, 2);
});

test("a legacy entry in active and a DISTINCT legacy entry sharing its date+title in archive both survive", () => {
  // Cross-list: an active legacy entry and an archived legacy entry share
  // date+title but are distinct (no Source Journal on either). The archived
  // shadow must NOT be dropped, because there is no proven duplicate.
  const active = { date: "2026-06-11", title: "Same handle", decay: 5, body: legacyBody("active body") };
  const archived = { date: "2026-06-11", title: "Same handle", decay: 1, body: legacyBody("archived body") };
  const parsed = parseMemoryMd(memoryDoc([active]), archiveDoc([archived]));

  assert.equal(parsed.entries.length, 1, "active legacy entry retained");
  assert.equal(parsed.archivedEntries.length, 1, "distinct archived legacy entry NOT dropped on date+title");
  assert.ok(parsed.entries[0].content.includes("active body"));
  assert.ok(parsed.archivedEntries[0].content.includes("archived body"));
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
