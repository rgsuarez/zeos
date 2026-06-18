import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { rebuildMemoryFromJournals } from "../dist/lib/memory-rebuild.js";
import {
  parseMemoryMd,
  formatMemoryMd,
  formatEntryHeading,
  MEMORY_ENTRY_DECAY_DEFAULT,
} from "../dist/lib/memory.js";

// ── fixtures ────────────────────────────────────────────────────────────────

function mkTmpDir(prefix = "memory-rebuild-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A complete journal: frontmatter stub + an appended `## Session End:` block,
// byte-shaped like what the live /end path writes (so the parser exercises the
// real format, not a simplified one).
function journalWithSessionEnd({
  date,
  seq,
  agent = "claude",
  summary,
  finalBridge = "handoff bridge",
  nextActions = "- continue the work",
  tags = [],
  refs = [],
}) {
  const sequence = String(seq).padStart(3, "0");
  const sessionId = `${date}-${sequence}`;
  const filename = `${date}-${sequence}-${agent}.md`;
  let body = `---
schema_version: "2.0.0"
session_id: "${sessionId}"
project: "demo"
date: "${date}"
sequence: ${seq}
agent: "${agent}"
instance: "${agent}"
status: active
created: "${date}T12:00:00.000Z"
previous_session: null
---

# Session Journal: ${sessionId}

*Session started via zeos Inject MCP*

---

## Session worked
Did real work here that is clearly more than a stub body so the journal counts
as substantive and not an unworked stub placeholder filler text padding padding.

## Session End: ${date}T18:00:00.000Z

### Summary
${summary}

### Final Bridge
${finalBridge}

### Next Actions
${nextActions}
`;
  if (tags.length > 0) {
    body += `\n### Tags\n${tags.map(t => `- ${t}`).join("\n")}\n`;
  }
  if (refs.length > 0) {
    body += `\n### References\n${refs.map(r => `- ${r}`).join("\n")}\n`;
  }
  body += `\n---\n*Session complete*\n`;
  return { filename, content: body, sessionId };
}

// A journal with NO Session End block (interrupted) - must be skipped by rebuild.
function interruptedJournal({ date, seq, agent = "claude" }) {
  const sequence = String(seq).padStart(3, "0");
  const sessionId = `${date}-${sequence}`;
  const filename = `${date}-${sequence}-${agent}.md`;
  const content = `---
schema_version: "2.0.0"
session_id: "${sessionId}"
project: "demo"
date: "${date}"
sequence: ${seq}
agent: "${agent}"
status: active
created: "${date}T12:00:00.000Z"
previous_session: null
---

# Session Journal: ${sessionId}

Real in-flight work that never got a Session End block because the session was
interrupted before /end ran, so this body is substantive but not complete here.
`;
  return { filename, content };
}

function seedJournals(dir, journals) {
  for (const j of journals) {
    fs.writeFileSync(path.join(dir, j.filename), j.content);
  }
}

// Build a current MEMORY.md doc from entry specs, using the real formatter so
// the Source Journal pointer (durable id) is shaped exactly like production.
function currentMemoryDoc(projectName, entries) {
  const parsed = {
    frontmatter: { document: "MEMORY", project: projectName },
    projectName,
    entries,
    archivedEntries: [],
  };
  return formatMemoryMd(parsed, "active");
}

function currentArchiveDoc(projectName, archivedEntries) {
  const parsed = {
    frontmatter: { document: "MEMORY" },
    projectName,
    entries: [],
    archivedEntries,
  };
  return formatMemoryMd(parsed, "archive");
}

// A MemoryEntry whose body carries a Source Journal pointer to an absolute
// journal path inside `dir` (so it can forward-carry onto a rebuilt entry).
function memoryEntry(dir, { date, seq, agent = "claude", title, decay = 5, importance = 3, promoted = false, isArchived = false }) {
  const sequence = String(seq).padStart(3, "0");
  const filename = `${date}-${sequence}-${agent}.md`;
  const journalPath = path.join(dir, filename);
  const content = [
    "### Summary",
    title,
    "",
    "### Final Bridge",
    "prior bridge",
    "",
    "### Next Actions",
    "- prior next",
    "",
    "### Source Journal",
    journalPath,
  ].join("\n");
  return { date, title, decay, importance, tags: [], refs: [], promoted, content, isArchived };
}

// ── Case 1: N Session End blocks -> N entries, correct content/tags/order ─────

test("rebuild: N Session End blocks produce N entries with content, tags, and decay ordering", () => {
  const dir = mkTmpDir();
  try {
    const j1 = journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "oldest session work", tags: ["alpha"] });
    const j2 = journalWithSessionEnd({ date: "2026-06-11", seq: 1, summary: "middle session work", tags: ["beta", "gamma"] });
    const j3 = journalWithSessionEnd({ date: "2026-06-12", seq: 1, summary: "newest session work", refs: ["LQOS-1"] });
    seedJournals(dir, [j1, j2, j3]);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000 });

    assert.equal(result.journalEntryCount, 3, "one entry per Session End block");
    assert.equal(result.rebuilt.entries.length, 3);

    // Newest-first ordering: highest decay on the newest session.
    const titles = result.rebuilt.entries.map(e => e.title);
    assert.deepEqual(titles, ["newest session work", "middle session work", "oldest session work"]);

    const decays = result.rebuilt.entries.map(e => e.decay);
    assert.equal(decays[0], MEMORY_ENTRY_DECAY_DEFAULT, "newest keeps the full decay seed");
    assert.equal(decays[1], MEMORY_ENTRY_DECAY_DEFAULT - 1);
    assert.equal(decays[2], MEMORY_ENTRY_DECAY_DEFAULT - 2);
    assert.ok(decays[0] > decays[1] && decays[1] > decays[2], "decay strictly decreases with age");

    // Content + tags + refs regenerated from the journal body.
    const newest = result.rebuilt.entries[0];
    assert.match(newest.content, /### Summary\nnewest session work/);
    assert.match(newest.content, /### Source Journal\n.*2026-06-12-001-claude\.md/);
    assert.deepEqual(newest.refs, ["LQOS-1"]);

    const middle = result.rebuilt.entries[1];
    assert.deepEqual(middle.tags, ["beta", "gamma"], "tags parsed from the Session End block");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild: interrupted journals (no Session End block) are skipped", () => {
  const dir = mkTmpDir();
  try {
    seedJournals(dir, [
      journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "completed work" }),
      interruptedJournal({ date: "2026-06-11", seq: 1 }),
    ]);
    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000 });
    assert.equal(result.journalEntryCount, 1, "only the Session-End journal is rebuilt");
    assert.equal(result.rebuilt.entries[0].title, "completed work");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Case 2: promoted-flag forward-carry ──────────────────────────────────────

test("rebuild: a pre-existing [promoted:true] entry survives the rebuild with its marker", () => {
  const dir = mkTmpDir();
  try {
    const j1 = journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "doctrine decision" });
    const j2 = journalWithSessionEnd({ date: "2026-06-11", seq: 1, summary: "routine work" });
    seedJournals(dir, [j1, j2]);

    // Current MEMORY: the j1 entry is promoted + high importance; j2 is plain.
    const current = currentMemoryDoc("demo", [
      memoryEntry(dir, { date: "2026-06-11", seq: 1, title: "routine work", decay: 4, importance: 3 }),
      memoryEntry(dir, { date: "2026-06-10", seq: 1, title: "doctrine decision", decay: 2, importance: 5, promoted: true }),
    ]);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });

    const promotedEntry = result.rebuilt.entries.find(e => e.title === "doctrine decision");
    assert.ok(promotedEntry, "promoted entry is present after rebuild");
    assert.equal(promotedEntry.promoted, true, "promoted flag forward-carried");
    assert.equal(promotedEntry.importance, 5, "operator importance forward-carried");

    // The heading emitted by the formatter retains the [promoted:true] marker.
    const heading = formatEntryHeading(promotedEntry);
    assert.match(heading, /\[promoted:true\]/);

    // Re-parse the committed-shape doc to prove round-trip persistence.
    const reparsed = parseMemoryMd(formatMemoryMd(result.rebuilt));
    const reEntry = reparsed.entries.find(e => e.title === "doctrine decision");
    assert.equal(reEntry.promoted, true, "marker survives a full format/parse cycle");

    // Provenance records the durable-id match.
    const prov = result.provenance.find(p => p.title === "doctrine decision");
    assert.equal(prov.carry, "durable");
    assert.equal(result.canCommit, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild: archived-vs-active placement is forward-carried by Source Journal id", () => {
  const dir = mkTmpDir();
  try {
    seedJournals(dir, [
      journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "cold entry" }),
      journalWithSessionEnd({ date: "2026-06-11", seq: 1, summary: "warm entry" }),
    ]);
    const current = currentMemoryDoc("demo", [
      memoryEntry(dir, { date: "2026-06-11", seq: 1, title: "warm entry", importance: 3 }),
    ]);
    const archive = currentArchiveDoc("demo", [
      memoryEntry(dir, { date: "2026-06-10", seq: 1, title: "cold entry", importance: 3, isArchived: true }),
    ]);

    const result = rebuildMemoryFromJournals(dir, {
      tokenLimit: 100000,
      currentMemory: current,
      currentArchive: archive,
    });

    const activeTitles = result.rebuilt.entries.map(e => e.title);
    const archivedTitles = result.rebuilt.archivedEntries.map(e => e.title);
    assert.deepEqual(activeTitles, ["warm entry"], "active placement preserved");
    assert.deepEqual(archivedTitles, ["cold entry"], "archive placement preserved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Case 3: dry-run writes nothing; commit writes under lock ──────────────────

test("rebuild dry-run is pure: rebuildMemoryFromJournals writes nothing to disk", () => {
  const dir = mkTmpDir();
  try {
    seedJournals(dir, [journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "work" })]);
    const before = fs.readdirSync(dir).sort();
    rebuildMemoryFromJournals(dir, { tokenLimit: 100000 });
    const after = fs.readdirSync(dir).sort();
    assert.deepEqual(after, before, "no files created or removed by the pure rebuild");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild commit path: writing under a held lock then releasing leaves MEMORY.md present and lock-free", async () => {
  // Exercises the same commit shape the tool handler uses: lock -> read ->
  // rebuild -> atomic write -> release. Uses the real helpers against dist.
  const { acquireMemoryLock, releaseMemoryLock } = await import("../dist/lib/memory-lock.js");
  const { atomicWriteWithBackup } = await import("../dist/lib/atomic-write.js");

  const journalDir = mkTmpDir("memory-rebuild-j-");
  const memoryDir = mkTmpDir("memory-rebuild-m-");
  try {
    seedJournals(journalDir, [journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "committed work" })]);
    const memoryPath = path.join(memoryDir, "MEMORY.md");

    const acquired = acquireMemoryLock(memoryPath);
    assert.equal(acquired, true, "lock acquired before the read-modify-write");
    assert.ok(fs.existsSync(memoryPath + ".lock"), "lock file is held during the write");
    try {
      const result = rebuildMemoryFromJournals(journalDir, {
        tokenLimit: 100000,
        currentMemory: "",
        currentArchive: "",
        projectName: "demo",
      });
      assert.equal(result.canCommit, true);
      atomicWriteWithBackup(memoryPath, formatMemoryMd(result.rebuilt));
    } finally {
      releaseMemoryLock(memoryPath);
    }

    assert.ok(fs.existsSync(memoryPath), "MEMORY.md written on commit");
    assert.equal(fs.existsSync(memoryPath + ".lock"), false, "lock released in finally");
    const written = parseMemoryMd(fs.readFileSync(memoryPath, "utf-8"));
    assert.equal(written.entries[0].title, "committed work");
  } finally {
    fs.rmSync(journalDir, { recursive: true, force: true });
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});

// ── Fail-closed: ambiguous same-date same-title metadata never mis-attaches ───

test("rebuild fail-closed: two same-date same-title journals do NOT mis-attach metadata", () => {
  const dir = mkTmpDir();
  try {
    // Two DISTINCT journals on the same date with the SAME summary/title but
    // different sequence numbers (distinct Source Journal paths = distinct
    // durable ids).
    seedJournals(dir, [
      journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "duplicate title" }),
      journalWithSessionEnd({ date: "2026-06-10", seq: 2, summary: "duplicate title" }),
    ]);

    // Current MEMORY: a legacy entry with NO durable id (no Source Journal line)
    // sharing that same date+title. Its date+title key is ambiguous against the
    // two rebuilt entries, so the metadata must attach to NEITHER.
    const legacyContent = ["### Summary", "duplicate title", "", "### Final Bridge", "b", "", "### Next Actions", "- n"].join("\n");
    const current = currentMemoryDoc("demo", [
      { date: "2026-06-10", title: "duplicate title", decay: 9, importance: 5, tags: [], refs: [], promoted: true, content: legacyContent, isArchived: false },
    ]);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });

    // Both rebuilt entries exist; NEITHER carries the legacy promoted/importance.
    const dupEntries = result.rebuilt.entries.filter(e => e.title === "duplicate title");
    assert.equal(dupEntries.length, 2, "both same-title rebuilt entries survive");
    for (const e of dupEntries) {
      assert.equal(e.promoted, false, "ambiguous legacy promoted must NOT attach to either entry");
      assert.equal(e.importance, 3, "ambiguous legacy importance must NOT attach to either entry");
    }
    // Provenance shows no date-title carry happened for these.
    const provs = result.provenance.filter(p => p.title === "duplicate title");
    assert.ok(provs.every(p => p.carry === "none"), "no fallback carry on the ambiguous key");

    // The legacy entry was promoted and went unmatched, so committing would drop
    // a promotion marker: the rebuild must fail closed rather than lose it.
    assert.equal(result.canCommit, false, "ambiguous unmatched promoted entry blocks commit");
    assert.ok(result.conflicts.some(c => c.kind === "dropped-promoted" && c.title === "duplicate title"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild fail-closed: a unique date+title legacy entry DOES forward-carry (fallback works when collision-free)", () => {
  const dir = mkTmpDir();
  try {
    seedJournals(dir, [journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "unique title" })]);
    const legacyContent = ["### Summary", "unique title", "", "### Final Bridge", "b", "", "### Next Actions", "- n"].join("\n");
    const current = currentMemoryDoc("demo", [
      { date: "2026-06-10", title: "unique title", decay: 9, importance: 5, tags: [], refs: [], promoted: true, content: legacyContent, isArchived: false },
    ]);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });
    const entry = result.rebuilt.entries.find(e => e.title === "unique title");
    assert.equal(entry.promoted, true, "collision-free date+title fallback carries promoted");
    assert.equal(entry.importance, 5, "collision-free date+title fallback carries importance");
    const prov = result.provenance.find(p => p.title === "unique title");
    assert.equal(prov.carry, "date-title");
    assert.equal(result.canCommit, true, "matched promoted entry is not a conflict");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Fail-closed: a would-drop-promoted entry aborts the commit ────────────────

test("rebuild fail-closed: a currently-promoted entry with no journal aborts commit", () => {
  const dir = mkTmpDir();
  try {
    // The journal that produced the promoted entry is GONE; only an unrelated
    // journal remains. The rebuild cannot reproduce the promoted entry.
    seedJournals(dir, [journalWithSessionEnd({ date: "2026-06-12", seq: 1, summary: "unrelated work" })]);

    const current = currentMemoryDoc("demo", [
      memoryEntry(dir, { date: "2026-06-12", seq: 1, title: "unrelated work", importance: 3 }),
      // Promoted entry whose Source Journal (seq 9) is not on disk anymore.
      memoryEntry(dir, { date: "2026-06-10", seq: 9, title: "lost promoted decision", importance: 5, promoted: true }),
    ]);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });

    assert.equal(result.canCommit, false, "commit refused when a promoted entry would drop");
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].kind, "dropped-promoted");
    assert.equal(result.conflicts[0].title, "lost promoted decision");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild fail-closed: a currently-pinned (high-importance) entry with no journal aborts commit", () => {
  const dir = mkTmpDir();
  try {
    seedJournals(dir, [journalWithSessionEnd({ date: "2026-06-12", seq: 1, summary: "unrelated work" })]);
    const current = currentMemoryDoc("demo", [
      memoryEntry(dir, { date: "2026-06-12", seq: 1, title: "unrelated work", importance: 3 }),
      memoryEntry(dir, { date: "2026-06-10", seq: 9, title: "pinned but lost", importance: 5, promoted: false }),
    ]);
    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });
    assert.equal(result.canCommit, false);
    assert.equal(result.conflicts[0].kind, "dropped-pinned");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Lossy fields documented: deleted entries reported as unrecoverable ────────

test("rebuild documents unrecoverable entries (deleted by past curation, low importance)", () => {
  const dir = mkTmpDir();
  try {
    seedJournals(dir, [journalWithSessionEnd({ date: "2026-06-12", seq: 1, summary: "kept work" })]);
    const current = currentMemoryDoc("demo", [
      memoryEntry(dir, { date: "2026-06-12", seq: 1, title: "kept work", importance: 3 }),
      // A plain, low-importance entry whose journal is gone: unrecoverable but
      // NOT a hard conflict (it was not promoted or pinned).
      memoryEntry(dir, { date: "2026-06-09", seq: 7, title: "long-gone note", importance: 2, promoted: false }),
    ]);
    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });

    assert.equal(result.canCommit, true, "plain dropped entry does not block commit");
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.unrecoverable.length, 1, "the dropped plain entry is reported as unrecoverable");
    assert.equal(result.unrecoverable[0].title, "long-gone note");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild commit path: first-ever rebuild creates the memory dir before locking (no ENOENT)", async () => {
  // The lock file is a sibling of MEMORY.md. On a first-ever rebuild the
  // memory/<app_id>/ directory does not exist yet, so the commit MUST create it
  // before acquiring the lock or the lock write ENOENTs. This pins that order.
  const { acquireMemoryLock, releaseMemoryLock } = await import("../dist/lib/memory-lock.js");
  const { atomicWriteWithBackup } = await import("../dist/lib/atomic-write.js");

  const journalDir = mkTmpDir("memory-rebuild-j-");
  const stateRoot = mkTmpDir("memory-rebuild-s-");
  try {
    seedJournals(journalDir, [journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "fresh project work" })]);
    // A nested memory path whose parent dir does NOT exist yet.
    const memoryPath = path.join(stateRoot, "memory", "fresh-proj", "MEMORY.md");
    assert.equal(fs.existsSync(path.dirname(memoryPath)), false, "memory dir absent at start");

    // Mirror the handler's commit order: mkdir -> lock -> read -> rebuild -> write.
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    const acquired = acquireMemoryLock(memoryPath);
    assert.equal(acquired, true, "lock acquired without ENOENT once the dir exists");
    try {
      const result = rebuildMemoryFromJournals(journalDir, { tokenLimit: 100000, currentMemory: "", projectName: "fresh-proj" });
      atomicWriteWithBackup(memoryPath, formatMemoryMd(result.rebuilt));
    } finally {
      releaseMemoryLock(memoryPath);
    }
    assert.ok(fs.existsSync(memoryPath), "MEMORY.md written into the freshly-created dir");
    assert.equal(fs.existsSync(memoryPath + ".lock"), false, "lock released");
  } finally {
    fs.rmSync(journalDir, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("rebuild commit path: a stale MEMORY_ARCHIVE.md is removed when the rebuild has no archived entries", async () => {
  // A pre-existing archive holds an entry whose journal is GONE (unrecoverable,
  // low importance so not a hard conflict). The rebuild reproduces only the
  // live active entry and produces ZERO archived entries. The commit must remove
  // the stale archive so the dropped entry cannot resurrect via dedupe-on-load.
  const { acquireMemoryLock, releaseMemoryLock } = await import("../dist/lib/memory-lock.js");
  const { atomicWriteWithBackup, atomicWriteFileSync } = await import("../dist/lib/atomic-write.js");

  const journalDir = mkTmpDir("memory-rebuild-j-");
  const stateRoot = mkTmpDir("memory-rebuild-s-");
  try {
    seedJournals(journalDir, [journalWithSessionEnd({ date: "2026-06-12", seq: 1, summary: "live entry" })]);

    const memDir = path.join(stateRoot, "memory", "stale-arch");
    fs.mkdirSync(memDir, { recursive: true });
    const memoryPath = path.join(memDir, "MEMORY.md");
    const archivePath = path.join(memDir, "MEMORY_ARCHIVE.md");

    const current = currentMemoryDoc("stale-arch", [
      memoryEntry(journalDir, { date: "2026-06-12", seq: 1, title: "live entry", importance: 3 }),
    ]);
    // Stale archive entry: journal seq 8 is not on disk; importance 2 (not pinned).
    const archive = currentArchiveDoc("stale-arch", [
      memoryEntry(journalDir, { date: "2026-06-08", seq: 8, title: "long-gone archived", importance: 2, isArchived: true }),
    ]);
    fs.writeFileSync(memoryPath, current);
    fs.writeFileSync(archivePath, archive);

    const result = rebuildMemoryFromJournals(journalDir, {
      tokenLimit: 100000,
      currentMemory: current,
      currentArchive: archive,
      projectName: "stale-arch",
    });
    assert.equal(result.canCommit, true, "plain dropped archived entry does not block commit");
    assert.equal(result.rebuilt.archivedEntries.length, 0, "rebuild has no archived entries");
    assert.ok(result.unrecoverable.some(u => u.title === "long-gone archived"));

    // Mirror the handler's commit ordering, including the stale-archive cleanup.
    fs.mkdirSync(memDir, { recursive: true });
    acquireMemoryLock(memoryPath);
    try {
      if (result.rebuilt.archivedEntries.length > 0) {
        atomicWriteFileSync(archivePath, formatMemoryMd(result.rebuilt, "archive"));
      }
      atomicWriteWithBackup(memoryPath, formatMemoryMd(result.rebuilt));
      if (result.rebuilt.archivedEntries.length === 0 && fs.existsSync(archivePath)) {
        fs.unlinkSync(archivePath);
      }
    } finally {
      releaseMemoryLock(memoryPath);
    }

    assert.equal(fs.existsSync(archivePath), false, "stale MEMORY_ARCHIVE.md removed on commit");
    // Re-loading MEMORY + (absent) archive yields only the live entry; the
    // long-gone archived entry does NOT resurrect.
    const reloaded = parseMemoryMd(fs.readFileSync(memoryPath, "utf-8"), "");
    const allTitles = [...reloaded.entries, ...reloaded.archivedEntries].map(e => e.title);
    assert.deepEqual(allTitles, ["live entry"], "dropped archived entry does not resurrect");
  } finally {
    fs.rmSync(journalDir, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ── No journals: empty rebuild is safe ───────────────────────────────────────

test("rebuild: empty journal dir yields zero entries and is committable", () => {
  const dir = mkTmpDir();
  try {
    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000 });
    assert.equal(result.journalEntryCount, 0);
    assert.equal(result.rebuilt.entries.length, 0);
    assert.equal(result.canCommit, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
