import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { rebuildMemoryFromJournals, commitRebuild } from "../dist/lib/memory-rebuild.js";
import {
  parseMemoryMd,
  formatMemoryMd,
  formatEntryHeading,
  MEMORY_ENTRY_DECAY_DEFAULT,
  MEMORY_PROMOTION_IMPORTANCE_THRESHOLD,
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

    // Use the real handler write path (commitRebuild), which removes the stale
    // archive in the zero-archive case as part of its crash-safe ordering.
    fs.mkdirSync(memDir, { recursive: true });
    acquireMemoryLock(memoryPath);
    try {
      commitRebuild(result.rebuilt, memoryPath, archivePath);
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

// -- Data-integrity remediation (PR review panel findings) --------------------

// Finding 1: ARCHIVE-ONLY forward-carry must NOT be bypassed. When MEMORY.md is
// empty/missing but MEMORY_ARCHIVE.md holds a promoted entry the rebuild cannot
// reproduce, the commit must FAIL CLOSED exactly like the active-only case
// (previously the empty-MEMORY guard skipped the carry index and canCommit
// stayed true, silently dropping the promotion marker).
test("rebuild finding-1: archive-only promoted entry the rebuild cannot reproduce FAILS CLOSED (empty MEMORY)", () => {
  const dir = mkTmpDir();
  try {
    // The only journal on disk is unrelated; the promoted entry's journal (seq 9)
    // is gone, so the rebuild cannot reproduce it.
    seedJournals(dir, [journalWithSessionEnd({ date: "2026-06-12", seq: 1, summary: "unrelated work" })]);

    // MEMORY.md is EMPTY; the promoted entry lives ONLY in the archive.
    const archive = currentArchiveDoc("demo", [
      memoryEntry(dir, { date: "2026-06-10", seq: 9, title: "archived promoted decision", importance: 5, promoted: true, isArchived: true }),
    ]);

    const result = rebuildMemoryFromJournals(dir, {
      tokenLimit: 100000,
      currentMemory: "",        // empty MEMORY.md (the recovery scenario)
      currentArchive: archive,  // promoted entry survives only here
    });

    assert.equal(result.canCommit, false, "archive-only promoted would-drop must block commit");
    assert.ok(
      result.conflicts.some(c => c.kind === "dropped-promoted" && c.title === "archived promoted decision"),
      "the archive-only promoted entry is reported as a dropped-promoted conflict",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild finding-1: archive-only commit aborts and writes nothing (handler shape)", async () => {
  // Mirrors the handler's commit gate: when canCommit is false, NOTHING is
  // written to disk. With MEMORY.md empty and a promoted entry only in the
  // archive whose journal is gone, the commit must abort before any write.
  const { acquireMemoryLock, releaseMemoryLock } = await import("../dist/lib/memory-lock.js");

  const journalDir = mkTmpDir("memory-rebuild-j-");
  const stateRoot = mkTmpDir("memory-rebuild-s-");
  try {
    seedJournals(journalDir, [journalWithSessionEnd({ date: "2026-06-12", seq: 1, summary: "unrelated work" })]);
    const memDir = path.join(stateRoot, "memory", "arch-only");
    fs.mkdirSync(memDir, { recursive: true });
    const memoryPath = path.join(memDir, "MEMORY.md");
    const archivePath = path.join(memDir, "MEMORY_ARCHIVE.md");

    // No MEMORY.md on disk; archive holds a promoted entry whose journal is gone.
    const archive = currentArchiveDoc("arch-only", [
      memoryEntry(journalDir, { date: "2026-06-10", seq: 9, title: "archived promoted", importance: 5, promoted: true, isArchived: true }),
    ]);
    fs.writeFileSync(archivePath, archive);
    const archiveBytesBefore = fs.readFileSync(archivePath, "utf-8");

    const currentMemory = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, "utf-8") : "";
    const currentArchive = fs.existsSync(archivePath) ? fs.readFileSync(archivePath, "utf-8") : "";

    acquireMemoryLock(memoryPath);
    try {
      const result = rebuildMemoryFromJournals(journalDir, {
        tokenLimit: 100000,
        currentMemory,
        currentArchive,
        projectName: "arch-only",
      });
      // The handler refuses to write when canCommit is false. Only on a
      // committable rebuild would it call the real commitRebuild write path.
      assert.equal(result.canCommit, false, "archive-only would-drop blocks the commit");
      if (result.canCommit) {
        commitRebuild(result.rebuilt, memoryPath, archivePath); // (unreached here)
      }
    } finally {
      releaseMemoryLock(memoryPath);
    }

    assert.equal(fs.existsSync(memoryPath), false, "no MEMORY.md written on a fail-closed commit");
    assert.equal(fs.readFileSync(archivePath, "utf-8"), archiveBytesBefore, "archive untouched on a fail-closed commit");
  } finally {
    fs.rmSync(journalDir, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("rebuild finding-1: archive placement + promoted forward-carry work in the archive-only case", () => {
  // Positive case: MEMORY.md empty, but the archive holds a promoted entry whose
  // journal IS still on disk. The rebuild reproduces it, forward-carries promoted
  // + archive placement from the archive-only current state, and commits cleanly.
  const dir = mkTmpDir();
  try {
    seedJournals(dir, [
      journalWithSessionEnd({ date: "2026-06-11", seq: 1, summary: "live active work" }),
      journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "cold promoted work" }),
    ]);

    // MEMORY.md empty; both current facts live in the archive (placement to carry).
    const archive = currentArchiveDoc("demo", [
      memoryEntry(dir, { date: "2026-06-11", seq: 1, title: "live active work", importance: 3, isArchived: true }),
      memoryEntry(dir, { date: "2026-06-10", seq: 1, title: "cold promoted work", importance: 2, promoted: true, isArchived: true }),
    ]);

    const result = rebuildMemoryFromJournals(dir, {
      tokenLimit: 100000,
      currentMemory: "",
      currentArchive: archive,
    });

    assert.equal(result.canCommit, true, "reproducible archive-only entries commit cleanly");

    // The promoted archive entry forward-carries its marker even though MEMORY
    // was empty (the carry index ran off the archive). It is also rescued to the
    // active set because a promoted entry must never stay archived.
    const promoted = [...result.rebuilt.entries, ...result.rebuilt.archivedEntries]
      .find(e => e.title === "cold promoted work");
    assert.ok(promoted, "promoted archive-only entry is present after rebuild");
    assert.equal(promoted.promoted, true, "promoted marker forward-carried from the archive-only current state");

    // Provenance shows a durable match happened (carry index built from archive).
    const prov = result.provenance.find(p => p.title === "cold promoted work");
    assert.equal(prov.carry, "durable", "archive-only entry matched by durable id");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 2: the date+title fallback must be unique across ALL current entries
// (durable-keyed + legacy), not just among legacy entries. A legacy entry that
// shares a date+title with a DURABLE-keyed current entry is ambiguous and must
// NOT attach to a rebuilt entry whose durable id belongs to the OTHER entry.
test("rebuild finding-2: legacy metadata does NOT mis-attach when a durable-keyed entry shares its date+title", () => {
  const dir = mkTmpDir();
  try {
    // One journal on disk: seq 1, title "shared title". Its rebuilt entry has a
    // durable id = journal::<dir>/2026-06-10-001-claude.md.
    seedJournals(dir, [journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "shared title" })]);

    // Current MEMORY has TWO entries sharing date "2026-06-10" + title "shared title":
    //   A) a DURABLE-keyed entry pointing at a DIFFERENT journal (seq 2, not on
    //      disk) -> rebuilt entry's durable id will NOT match this one.
    //   B) a LEGACY entry (no Source Journal line) with distinctive importance 5.
    // The rebuilt entry (durable id for seq 1) misses on durable, then must NOT
    // adopt B via the date+title fallback because the key is ambiguous across the
    // full current set (A also holds it).
    const durableSibling = memoryEntry(dir, { date: "2026-06-10", seq: 2, title: "shared title", importance: 4 });
    const legacyContent = ["### Summary", "shared title", "", "### Final Bridge", "b", "", "### Next Actions", "- n"].join("\n");
    const legacy = { date: "2026-06-10", title: "shared title", decay: 9, importance: 5, tags: [], refs: [], promoted: false, content: legacyContent, isArchived: false };
    const current = currentMemoryDoc("demo", [durableSibling, legacy]);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });

    const rebuiltEntry = result.rebuilt.entries.find(e => e.title === "shared title");
    assert.ok(rebuiltEntry, "the rebuilt entry exists");
    assert.equal(rebuiltEntry.importance, 3, "ambiguous legacy importance must NOT attach (no mis-attach)");
    const prov = result.provenance.find(p => p.title === "shared title");
    assert.equal(prov.carry, "none", "no fallback carry when the date+title is ambiguous across ALL current entries");

    // The durable-keyed sibling (A) and the legacy entry (B) both went unmatched.
    // Neither was promoted/pinned-by-promotion at a level that blocks commit here:
    // A has importance 4 (>= threshold) so it is reported as a dropped-pinned
    // conflict (its metadata was not silently lost - it is surfaced).
    assert.ok(
      result.conflicts.some(c => c.kind === "dropped-pinned" && c.title === "shared title"),
      "the unmatched durable-keyed sibling is surfaced as a conflict, not silently dropped",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 3: in the zero-archive path the stale archive unlink must PRECEDE the
// MEMORY write (so the parent-dir fsync of the MEMORY rename durably commits the
// removal), while the non-zero path keeps archive-first ordering. Exercises the
// REAL commitRebuild helper (the single source of truth for write ordering),
// not a test-local copy, so a future reorder is caught.
test("rebuild finding-3: zero-archive commitRebuild removes the stale archive (no resurrection)", async () => {
  const { acquireMemoryLock, releaseMemoryLock } = await import("../dist/lib/memory-lock.js");

  const journalDir = mkTmpDir("memory-rebuild-j-");
  const stateRoot = mkTmpDir("memory-rebuild-s-");
  try {
    seedJournals(journalDir, [journalWithSessionEnd({ date: "2026-06-12", seq: 1, summary: "live entry" })]);
    const memDir = path.join(stateRoot, "memory", "ordering");
    fs.mkdirSync(memDir, { recursive: true });
    const memoryPath = path.join(memDir, "MEMORY.md");
    const archivePath = path.join(memDir, "MEMORY_ARCHIVE.md");

    const current = currentMemoryDoc("ordering", [
      memoryEntry(journalDir, { date: "2026-06-12", seq: 1, title: "live entry", importance: 3 }),
    ]);
    // Stale archive: journal seq 8 gone, importance 2 (not pinned) -> rebuild
    // produces zero archived entries.
    const archive = currentArchiveDoc("ordering", [
      memoryEntry(journalDir, { date: "2026-06-08", seq: 8, title: "long-gone archived", importance: 2, isArchived: true }),
    ]);
    fs.writeFileSync(memoryPath, current);
    fs.writeFileSync(archivePath, archive);

    const result = rebuildMemoryFromJournals(journalDir, {
      tokenLimit: 100000, currentMemory: current, currentArchive: archive, projectName: "ordering",
    });
    assert.equal(result.rebuilt.archivedEntries.length, 0, "rebuild has zero archived entries");
    assert.equal(result.canCommit, true);

    acquireMemoryLock(memoryPath);
    try {
      commitRebuild(result.rebuilt, memoryPath, archivePath);
    } finally {
      releaseMemoryLock(memoryPath);
    }

    assert.equal(fs.existsSync(archivePath), false, "stale archive removed by commitRebuild");
    assert.ok(fs.existsSync(memoryPath), "MEMORY.md written by commitRebuild");
    // Happy path: reloading MEMORY + (absent) archive yields only the live entry,
    // i.e. the dropped archived entry does NOT resurrect via dedupe-on-load.
    const reloaded = parseMemoryMd(fs.readFileSync(memoryPath, "utf-8"), "");
    const titles = [...reloaded.entries, ...reloaded.archivedEntries].map(e => e.title);
    assert.deepEqual(titles, ["live entry"], "dropped archived entry does not resurrect");
  } finally {
    fs.rmSync(journalDir, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

// Finding 3 (non-zero archive): commitRebuild keeps archive-first ordering and
// writes BOTH files (the complement of the zero-archive stale-removal path).
test("rebuild finding-3: non-zero-archive commitRebuild writes both MEMORY and the archive", async () => {
  const journalDir = mkTmpDir("memory-rebuild-j-");
  const stateRoot = mkTmpDir("memory-rebuild-s-");
  try {
    // Two reproducible journals; force one into the archive via the token limit.
    const big = "word ".repeat(400).trim();
    seedJournals(journalDir, [
      journalWithSessionEnd({ date: "2026-06-12", seq: 1, summary: `active big ${big}` }),
      journalWithSessionEnd({ date: "2026-06-08", seq: 1, summary: `older big ${big}` }),
    ]);
    const memDir = path.join(stateRoot, "memory", "nonzero");
    fs.mkdirSync(memDir, { recursive: true });
    const memoryPath = path.join(memDir, "MEMORY.md");
    const archivePath = path.join(memDir, "MEMORY_ARCHIVE.md");

    const result = rebuildMemoryFromJournals(journalDir, {
      tokenLimit: 500, currentMemory: "", projectName: "nonzero",
    });
    assert.ok(result.rebuilt.archivedEntries.length > 0, "rebuild produced archived entries");
    assert.equal(result.canCommit, true);

    commitRebuild(result.rebuilt, memoryPath, archivePath);

    assert.ok(fs.existsSync(memoryPath), "MEMORY.md written");
    assert.ok(fs.existsSync(archivePath), "MEMORY_ARCHIVE.md written (archive-first, not removed)");
    // Reload both: every rebuilt entry is present across active+archive.
    const reloaded = parseMemoryMd(fs.readFileSync(memoryPath, "utf-8"), fs.readFileSync(archivePath, "utf-8"));
    assert.equal(reloaded.entries.length + reloaded.archivedEntries.length, 2, "both entries persisted");
  } finally {
    fs.rmSync(journalDir, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

// Finding 4: operator-supplied References must be FORWARD-CARRIED from the
// current MEMORY entry (the journal Session End block has no References section,
// so a rebuild would otherwise rewrite the entry with refs=[]).
test("rebuild finding-4: an existing entry's References survive the rebuild (forward-carried, not journal-derived)", () => {
  const dir = mkTmpDir();
  try {
    // The journal has NO References section (mirrors real /end output).
    seedJournals(dir, [journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "work with refs" })]);

    // Current MEMORY entry carries operator-supplied refs the journal never had.
    const seq = "001";
    const journalPath = path.join(dir, `2026-06-10-${seq}-claude.md`);
    const withRefsContent = [
      "### Summary", "work with refs", "",
      "### Final Bridge", "b", "",
      "### Next Actions", "- n", "",
      "### References", "- LQOS-42", "- https://example.com/doc", "",
      "### Source Journal", journalPath,
    ].join("\n");
    const current = currentMemoryDoc("demo", [
      { date: "2026-06-10", title: "work with refs", decay: 5, importance: 3, tags: [], refs: ["LQOS-42", "https://example.com/doc"], promoted: false, content: withRefsContent, isArchived: false },
    ]);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });

    const entry = result.rebuilt.entries.find(e => e.title === "work with refs");
    assert.ok(entry, "entry present after rebuild");
    assert.deepEqual(entry.refs, ["LQOS-42", "https://example.com/doc"], "refs forward-carried onto the entry");
    assert.match(entry.content, /### References\n- LQOS-42\n- https:\/\/example\.com\/doc/, "References section regenerated in the body");

    // Round-trip: refs survive a full format/parse cycle (they live in the body).
    const reparsed = parseMemoryMd(formatMemoryMd(result.rebuilt));
    const reEntry = reparsed.entries.find(e => e.title === "work with refs");
    assert.match(reEntry.content, /### References\n- LQOS-42/, "refs persist through a format/parse cycle");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 5: a stale frontmatter.token_estimate must NOT be trusted by
// curateMemory; a rebuild that grows content past the limit must still archive
// the overflow.
test("rebuild finding-5: a rebuild that grows past the limit still curates (stale token_estimate ignored)", () => {
  const dir = mkTmpDir();
  try {
    // Three substantial journals: their rebuilt content exceeds a tight limit.
    const big = "word ".repeat(400).trim();
    seedJournals(dir, [
      journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: `oldest big ${big}` }),
      journalWithSessionEnd({ date: "2026-06-11", seq: 1, summary: `middle big ${big}` }),
      journalWithSessionEnd({ date: "2026-06-12", seq: 1, summary: `newest big ${big}` }),
    ]);

    // Current MEMORY claims a TINY token_estimate in frontmatter. If curateMemory
    // trusted it, the oversized rebuild would skip curation entirely.
    const current = [
      "---",
      'document: "MEMORY"',
      "token_estimate: 5",
      "---",
      "",
      "# Project Memory: demo",
      "",
    ].join("\n");

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 500, currentMemory: current });

    assert.ok(result.rebuilt.archivedEntries.length > 0, "overflow archived despite the stale tiny token_estimate");
    assert.ok(
      result.rebuilt.entries.length < 3,
      "not all three big entries stayed active under the 500-token limit",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 7: a promoted entry whose importance is below the active-retention
// threshold must STAY ACTIVE after the rebuild (curateMemory would archive it;
// the rebuild rescues it). curateMemory itself is unchanged (shared with /end).
test("rebuild finding-7: a promoted low-importance entry stays ACTIVE after rebuild", () => {
  const dir = mkTmpDir();
  try {
    const big = "word ".repeat(400).trim();
    // Filler journals to force curation, plus the promoted-low entry.
    seedJournals(dir, [
      journalWithSessionEnd({ date: "2026-06-09", seq: 1, summary: `filler one ${big}` }),
      journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: `filler two ${big}` }),
      journalWithSessionEnd({ date: "2026-06-08", seq: 1, summary: "promoted low note" }),
    ]);

    const lowImportance = MEMORY_PROMOTION_IMPORTANCE_THRESHOLD - 2; // below the retain bar
    assert.ok(lowImportance >= 1, "test importance stays in range");
    // Current MEMORY: the old promoted entry has LOW importance (would be archived
    // by curateMemory on size pressure) but its promoted marker must keep it active.
    const current = currentMemoryDoc("demo", [
      memoryEntry(dir, { date: "2026-06-09", seq: 1, title: `filler one ${big}`, importance: 3 }),
      memoryEntry(dir, { date: "2026-06-10", seq: 1, title: `filler two ${big}`, importance: 3 }),
      memoryEntry(dir, { date: "2026-06-08", seq: 1, title: "promoted low note", importance: lowImportance, promoted: true }),
    ]);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 500, currentMemory: current });

    assert.equal(result.canCommit, true, "promoted entry is reproduced, so no conflict");
    const active = result.rebuilt.entries.find(e => e.title === "promoted low note");
    const archived = result.rebuilt.archivedEntries.find(e => e.title === "promoted low note");
    assert.ok(active, "promoted low-importance entry is in the ACTIVE set");
    assert.equal(archived, undefined, "promoted low-importance entry is NOT archived");
    assert.equal(active.promoted, true, "marker preserved");
    // Sanity: curation DID run (something got archived under the 500-token limit).
    assert.ok(result.rebuilt.archivedEntries.length > 0, "curation ran (overflow archived)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 7 (boundary): a promoted entry DELIBERATELY forward-carried as ARCHIVED
// must KEEP its archive placement. The rescue only undoes curation-driven
// archival, not an operator's intentional archive placement.
test("rebuild finding-7: a promoted entry forward-carried as ARCHIVED stays archived (placement respected)", () => {
  const dir = mkTmpDir();
  try {
    seedJournals(dir, [
      journalWithSessionEnd({ date: "2026-06-11", seq: 1, summary: "active work" }),
      journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "deliberately archived promoted" }),
    ]);

    // MEMORY has the active entry; the archive holds a PROMOTED entry the operator
    // intentionally placed cold. Plenty of token budget, so curation does NOT run.
    const current = currentMemoryDoc("demo", [
      memoryEntry(dir, { date: "2026-06-11", seq: 1, title: "active work", importance: 3 }),
    ]);
    const archive = currentArchiveDoc("demo", [
      memoryEntry(dir, { date: "2026-06-10", seq: 1, title: "deliberately archived promoted", importance: 3, promoted: true, isArchived: true }),
    ]);

    const result = rebuildMemoryFromJournals(dir, {
      tokenLimit: 100000, currentMemory: current, currentArchive: archive,
    });

    const inArchive = result.rebuilt.archivedEntries.find(e => e.title === "deliberately archived promoted");
    const inActive = result.rebuilt.entries.find(e => e.title === "deliberately archived promoted");
    assert.ok(inArchive, "deliberately-archived promoted entry stays in the ARCHIVE");
    assert.equal(inActive, undefined, "it is NOT lifted into active by the rescue");
    assert.equal(inArchive.promoted, true, "marker preserved");
    assert.equal(result.canCommit, true, "reproducible promoted entry is not a conflict");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 6: a journal that quotes `## Session End:` inside a fenced code block
// before the REAL appended block must parse the REAL block (the region locator
// must be fence-aware, matching hasSessionEndBlock).
test("rebuild finding-6: a fenced/quoted '## Session End:' is ignored; the real block is parsed", () => {
  const dir = mkTmpDir();
  try {
    const filename = "2026-06-10-001-claude.md";
    // The body quotes a Session End heading inside a ``` fence (e.g. documenting
    // the format), THEN has the real appended block with a DIFFERENT summary.
    const content = [
      "---",
      'schema_version: "2.0.0"',
      'session_id: "2026-06-10-001"',
      'project: "demo"',
      'date: "2026-06-10"',
      "sequence: 1",
      'agent: "claude"',
      "status: active",
      'created: "2026-06-10T12:00:00.000Z"',
      "previous_session: null",
      "---",
      "",
      "# Session Journal: 2026-06-10-001",
      "",
      "## Notes",
      "Documenting the end-block format for future reference, with enough body",
      "text here to be clearly substantive and not an unworked stub placeholder.",
      "",
      "```md",
      "## Session End: TEMPLATE",
      "",
      "### Summary",
      "QUOTED TEMPLATE SUMMARY - must NOT become the entry",
      "```",
      "",
      "## Session End: 2026-06-10T18:00:00.000Z",
      "",
      "### Summary",
      "the real session summary",
      "",
      "### Final Bridge",
      "real bridge",
      "",
      "### Next Actions",
      "- real next",
      "",
      "---",
      "*Session complete*",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, filename), content);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000 });

    assert.equal(result.journalEntryCount, 1, "the journal is rebuilt from its REAL Session End block");
    const entry = result.rebuilt.entries[0];
    assert.equal(entry.title, "the real session summary", "title from the real block, not the quoted template");
    assert.match(entry.content, /### Summary\nthe real session summary/, "body from the real block");
    assert.doesNotMatch(entry.content, /QUOTED TEMPLATE SUMMARY/, "the fenced template block is not parsed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 8: the rebuild's title derivation must use the live titleFromSummary
// (which skips heading/blank lines), so a regenerated title byte-matches how
// /end stored it (keeping the legacy date+title fallback aligned).
test("rebuild finding-8: title uses titleFromSummary parity (skips a leading heading line)", () => {
  const dir = mkTmpDir();
  try {
    // A summary whose first line is a markdown heading. titleFromSummary skips it
    // and uses the first real content line; a naive firstLine would keep the '#'.
    const filename = "2026-06-10-001-claude.md";
    const content = [
      "---",
      'schema_version: "2.0.0"',
      'session_id: "2026-06-10-001"',
      'project: "demo"',
      'date: "2026-06-10"',
      "sequence: 1",
      'agent: "claude"',
      "status: active",
      'created: "2026-06-10T12:00:00.000Z"',
      "previous_session: null",
      "---",
      "",
      "# Session Journal: 2026-06-10-001",
      "",
      "## Worked on real things with a clearly substantive body to avoid the stub",
      "filter, padding padding padding padding padding padding padding padding.",
      "",
      "## Session End: 2026-06-10T18:00:00.000Z",
      "",
      "### Summary",
      "# Heading line that should be skipped",
      "the actual title content line",
      "",
      "### Final Bridge",
      "b",
      "",
      "### Next Actions",
      "- n",
      "",
      "---",
      "*Session complete*",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, filename), content);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000 });
    const entry = result.rebuilt.entries[0];
    assert.equal(entry.title, "the actual title content line", "titleFromSummary skips the heading line");
    assert.doesNotMatch(entry.title, /^#/, "the derived title does not start with a markdown heading marker");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── P2 residual data-safety fixes ────────────────────────────────────────────

// Fix 1: `### Why` and `### How to Apply` are authored ONLY into the current
// MEMORY entry (the /end flow), never into the journal Session End block, so they
// must be FORWARD-CARRIED. A rebuild that dropped them would erase doctrinal
// content that zeos_soul_promote requires (it rejects an entry with neither), so
// a later promotion would fail.
test("rebuild fix-1: an entry's Why / How to Apply survive the rebuild (forward-carried doctrine)", () => {
  const dir = mkTmpDir();
  try {
    // The journal has NO Why/How sections (mirrors real /end output).
    seedJournals(dir, [journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "doctrine note" })]);

    // Current MEMORY entry carries operator/agent-authored Why + How to Apply.
    const seq = "001";
    const journalPath = path.join(dir, `2026-06-10-${seq}-claude.md`);
    const whyText = "the durable reason this decision holds";
    const howText = "apply it by checking the gate before every write";
    const withDoctrineContent = [
      "### Summary", "doctrine note", "",
      "### Why", whyText, "",
      "### How to Apply", howText, "",
      "### Final Bridge", "b", "",
      "### Next Actions", "- n", "",
      "### Source Journal", journalPath,
    ].join("\n");
    const current = currentMemoryDoc("demo", [
      { date: "2026-06-10", title: "doctrine note", decay: 5, importance: 3, tags: [], refs: [], promoted: false, content: withDoctrineContent, isArchived: false },
    ]);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });

    const entry = result.rebuilt.entries.find(e => e.title === "doctrine note");
    assert.ok(entry, "entry present after rebuild");
    assert.match(entry.content, /### Why\nthe durable reason this decision holds/, "Why section forward-carried into the body");
    assert.match(entry.content, /### How to Apply\napply it by checking the gate before every write/, "How to Apply forward-carried into the body");

    // Round-trip: both survive a full format/parse cycle.
    const reparsed = parseMemoryMd(formatMemoryMd(result.rebuilt));
    const reEntry = reparsed.entries.find(e => e.title === "doctrine note");
    assert.match(reEntry.content, /### Why\nthe durable reason/, "Why persists through format/parse");
    assert.match(reEntry.content, /### How to Apply\napply it by/, "How to Apply persists through format/parse");

    // The promotion path reads these sections back and REQUIRES at least one; the
    // rebuilt entry must still satisfy that (it would have rejected with both empty).
    const whyMatch = reEntry.content.match(/### Why\n([\s\S]*?)(?=\n### |$)/);
    const howMatch = reEntry.content.match(/### How to Apply\n([\s\S]*?)(?=\n### |$)/);
    assert.equal(whyMatch && whyMatch[1].trim(), whyText, "Why extractable for promotion");
    assert.equal(howMatch && howMatch[1].trim(), howText, "How to Apply extractable for promotion");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Fix 1 (boundary): forward-carried Why/How and forward-carried References must
// COEXIST in the rebuilt body. The body is rebuilt in one pass, so carrying one
// must not clobber the others.
test("rebuild fix-1: Why / How to Apply / References are all carried together (single re-render)", () => {
  const dir = mkTmpDir();
  try {
    seedJournals(dir, [journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "combined doctrine" })]);
    const journalPath = path.join(dir, "2026-06-10-001-claude.md");
    const content = [
      "### Summary", "combined doctrine", "",
      "### Why", "why-A", "",
      "### How to Apply", "how-B", "",
      "### Final Bridge", "b", "",
      "### Next Actions", "- n", "",
      "### References", "- LQOS-7", "",
      "### Source Journal", journalPath,
    ].join("\n");
    const current = currentMemoryDoc("demo", [
      { date: "2026-06-10", title: "combined doctrine", decay: 5, importance: 3, tags: [], refs: ["LQOS-7"], promoted: false, content, isArchived: false },
    ]);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });
    const entry = result.rebuilt.entries.find(e => e.title === "combined doctrine");
    assert.ok(entry, "entry present");
    assert.match(entry.content, /### Why\nwhy-A/, "Why present");
    assert.match(entry.content, /### How to Apply\nhow-B/, "How to Apply present");
    assert.match(entry.content, /### References\n- LQOS-7/, "References present");
    assert.deepEqual(entry.refs, ["LQOS-7"], "refs carried alongside doctrine");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Fix 2: commitRebuild must PREFLIGHT the MEMORY redaction gates BEFORE mutating
// the archive. A pre-existing MEMORY.md carrying a secret-shaped value makes
// atomicWriteWithBackup throw (pre-existing-target); without the preflight the
// archive would ALREADY be unlinked/rewritten by then. With the preflight the
// commit aborts with the archive UNCHANGED.
test("rebuild fix-2: a pre-existing MEMORY with a secret aborts commit with the archive UNCHANGED", async () => {
  const { acquireMemoryLock, releaseMemoryLock } = await import("../dist/lib/memory-lock.js");
  const { RedactionAssertionError } = await import("../dist/lib/atomic-write.js");

  const journalDir = mkTmpDir("memory-rebuild-j-");
  const stateRoot = mkTmpDir("memory-rebuild-s-");
  try {
    // One reproducible active journal -> the rebuild has ZERO archived entries,
    // so the commit's zero-archive branch would UNLINK the stale archive.
    seedJournals(journalDir, [journalWithSessionEnd({ date: "2026-06-12", seq: 1, summary: "live entry" })]);
    const memDir = path.join(stateRoot, "memory", "preflight");
    fs.mkdirSync(memDir, { recursive: true });
    const memoryPath = path.join(memDir, "MEMORY.md");
    const archivePath = path.join(memDir, "MEMORY_ARCHIVE.md");

    // A pre-existing MEMORY.md whose body carries a secret-shaped value, built at
    // runtime so no literal secret sits in source. The ENV_SECRET rule matches a
    // `token: <20+ alnum>` assignment.
    const secretValue = "z" + "Ab12Cd34".repeat(5); // 41 alnum chars
    const leakedMemory = [
      "---", 'document: "MEMORY"', "---", "",
      "# Project Memory: preflight", "",
      "## 2026-06-12: live entry [decay:12] [importance:3]", "",
      "### Summary", "live entry", "",
      "### Final Bridge", `leaked token: ${secretValue}`, "",
      "### Next Actions", "- n", "",
      "### Source Journal", path.join(journalDir, "2026-06-12-001-claude.md"), "",
      "---", "",
    ].join("\n");
    fs.writeFileSync(memoryPath, leakedMemory);

    // A stale archive that the zero-archive commit path would otherwise remove.
    const archive = currentArchiveDoc("preflight", [
      memoryEntry(journalDir, { date: "2026-06-08", seq: 8, title: "long-gone", importance: 2, isArchived: true }),
    ]);
    fs.writeFileSync(archivePath, archive);
    const archiveBytesBefore = fs.readFileSync(archivePath, "utf-8");

    const currentMemory = fs.readFileSync(memoryPath, "utf-8");
    const currentArchive = fs.readFileSync(archivePath, "utf-8");
    const result = rebuildMemoryFromJournals(journalDir, {
      tokenLimit: 100000, currentMemory, currentArchive, projectName: "preflight",
    });
    assert.equal(result.rebuilt.archivedEntries.length, 0, "rebuild has zero archived entries (zero-archive path)");
    assert.equal(result.canCommit, true);

    acquireMemoryLock(memoryPath);
    try {
      assert.throws(
        () => commitRebuild(result.rebuilt, memoryPath, archivePath),
        RedactionAssertionError,
        "commit aborts on the pre-existing secret",
      );
    } finally {
      releaseMemoryLock(memoryPath);
    }

    // The archive was NOT mutated: the preflight ran before the unlink.
    assert.equal(fs.existsSync(archivePath), true, "MEMORY_ARCHIVE.md still exists (not unlinked)");
    assert.equal(fs.readFileSync(archivePath, "utf-8"), archiveBytesBefore, "MEMORY_ARCHIVE.md bytes unchanged");
  } finally {
    fs.rmSync(journalDir, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

// Fix 3: the current Continuity Digest is a projection of the NEWEST Session End
// blocks; a rebuild can change the newest entry, so the stale digest must NOT be
// carried forward (the boot path reads it verbatim to seed carry-forward). It is
// dropped so the next /end recomputes it.
test("rebuild fix-3: a stale Continuity Digest is dropped (not carried forward)", () => {
  const dir = mkTmpDir();
  try {
    // Two journals; the rebuild regenerates entries from the journal log.
    seedJournals(dir, [
      journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "older work" }),
      journalWithSessionEnd({ date: "2026-06-11", seq: 1, summary: "newest work changed" }),
    ]);

    // Current MEMORY carries a Continuity Digest referencing a DIFFERENT newest
    // session than the rebuild will produce (stale relative to the rebuilt set).
    const current = [
      "---", 'document: "MEMORY"', "---", "",
      "# Project Memory: demo", "",
      "## Continuity Digest", "",
      "### Last 3 Sessions", "- 2026-06-09: STALE prior session summary", "",
      "### Open Threads", "- [ ] STALE open thread that no longer applies", "",
      "### Decisions/Constraints", "*None this session*", "",
      "### Next Actions", "*None specified*", "",
      "---", "",
    ].join("\n");

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });

    // The rebuilt parsed memory carries no digest...
    assert.equal(result.rebuilt.continuityDigest, undefined, "stale digest not retained on the rebuilt memory");
    // ...and the formatted/committed doc has no stale digest content.
    const formatted = formatMemoryMd(result.rebuilt);
    assert.doesNotMatch(formatted, /STALE prior session summary/, "stale last-session line not persisted");
    assert.doesNotMatch(formatted, /STALE open thread/, "stale open-thread line not persisted");
    assert.doesNotMatch(formatted, /## Continuity Digest/, "no Continuity Digest block persisted");

    // Re-parsing the committed doc surfaces no digest, so a boot would seed no
    // (false) carry-forward from it.
    const reparsed = parseMemoryMd(formatted);
    assert.equal(reparsed.continuityDigest, undefined, "no digest survives the commit round-trip");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Fix 4: an older entry that stored its References as a HEADING token
// (`[refs:...]`, which parseEntryHeadingTail surfaces on entry.refs while the body
// has no `### References` section) must still forward-carry its refs. The carry
// index falls back to entry.refs when the body has none.
test("rebuild fix-4: legacy refs stored in the heading token are forward-carried", () => {
  const dir = mkTmpDir();
  try {
    seedJournals(dir, [journalWithSessionEnd({ date: "2026-06-10", seq: 1, summary: "legacy heading refs" })]);
    const journalPath = path.join(dir, "2026-06-10-001-claude.md");

    // A current MEMORY doc whose entry carries refs ONLY in the heading token and
    // has NO `### References` body section (the legacy persistence shape).
    const current = [
      "---", 'document: "MEMORY"', "---", "",
      "# Project Memory: demo", "",
      "## 2026-06-10: legacy heading refs [decay:5] [importance:3] [refs:LQOS-99,https://x.test/d]", "",
      "### Summary", "legacy heading refs", "",
      "### Final Bridge", "b", "",
      "### Next Actions", "- n", "",
      "### Source Journal", journalPath, "",
      "---", "",
    ].join("\n");

    // Sanity: the current doc really stores refs in the heading, not the body.
    const parsedCurrent = parseMemoryMd(current);
    assert.deepEqual(parsedCurrent.entries[0].refs, ["LQOS-99", "https://x.test/d"], "current refs come from the heading token");
    assert.doesNotMatch(parsedCurrent.entries[0].content, /### References/, "current body has no References section");

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000, currentMemory: current });

    const entry = result.rebuilt.entries.find(e => e.title === "legacy heading refs");
    assert.ok(entry, "entry present after rebuild");
    assert.deepEqual(entry.refs, ["LQOS-99", "https://x.test/d"], "legacy heading refs forward-carried");
    assert.match(entry.content, /### References\n- LQOS-99\n- https:\/\/x\.test\/d/, "refs materialized into the rebuilt body");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Fix 5: a malformed/legacy Session End block that OMITS `### Final Bridge` runs
// the Summary straight into the closing `\n---\n*Session complete*` rule. The
// summary (and derived title) must stop at the HR, not swallow the rule. The
// bounded `### Summary` extract (stops at `\n---`) replaces the shared
// extractJournalSummary `### Summary` pattern that stops only at the next heading.
test("rebuild fix-5: a Summary followed by the closing rule (no Final Bridge) is not swallowed", () => {
  const dir = mkTmpDir();
  try {
    const filename = "2026-06-10-001-claude.md";
    const content = [
      "---",
      'schema_version: "2.0.0"',
      'session_id: "2026-06-10-001"',
      'project: "demo"',
      'date: "2026-06-10"',
      "sequence: 1",
      'agent: "claude"',
      "status: active",
      'created: "2026-06-10T12:00:00.000Z"',
      "previous_session: null",
      "---",
      "",
      "# Session Journal: 2026-06-10-001",
      "",
      "## Worked on a real substantive body to clear the unworked-stub filter with",
      "padding padding padding padding padding padding padding padding padding text.",
      "",
      "## Session End: 2026-06-10T18:00:00.000Z",
      "",
      "### Summary",
      "the clean summary with no trailing rule",
      // NO ### Final Bridge: the Summary is immediately followed by the closing rule.
      "",
      "---",
      "*Session complete*",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, filename), content);

    const result = rebuildMemoryFromJournals(dir, { tokenLimit: 100000 });
    const entry = result.rebuilt.entries[0];

    assert.equal(entry.title, "the clean summary with no trailing rule", "title is the clean summary line");
    assert.doesNotMatch(entry.title, /Session complete/, "title does not swallow the closing marker");
    assert.doesNotMatch(entry.title, /---/, "title does not swallow the HR");

    // The rendered body must not contain the swallowed closing rule anywhere. The
    // shared extractJournalSummary `### Summary` pattern (which stops only at the
    // next heading) would fold `\n---\n*Session complete*` INTO the summary, and
    // formatMemoryEntryContent would then emit it inside the `### Summary` body.
    // The bounded extract cuts at the HR, so the marker never reaches the body.
    assert.doesNotMatch(entry.content, /Session complete/, "rendered body does not contain the swallowed closing marker");
    assert.match(entry.content, /### Summary\nthe clean summary with no trailing rule\n/, "Summary section holds only the clean line");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
