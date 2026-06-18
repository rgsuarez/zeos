import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promoteMemoryEntryToSoul } from "../dist/lib/soul-promote.js";
import { acquireMemoryLock, releaseMemoryLock } from "../dist/lib/memory-lock.js";

function tempSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeos-promote-test-"));
  fs.mkdirSync(path.join(root, "souls", "demo"), { recursive: true });
  fs.mkdirSync(path.join(root, "memory", "demo"), { recursive: true });
  fs.writeFileSync(path.join(root, "souls", "demo", "SOUL.md"), `---
project: demo
name: Demo
type: app
classification: PROJECT_SOUL
---

# Demo

## Mission
Demo mission.

## Constraints

- **Existing constraint**: stays.

## Values
- Value A.
`);
  fs.writeFileSync(path.join(root, "memory", "demo", "MEMORY.md"), `---
document: MEMORY
project: demo
---

# Project Memory: Demo

## 2026-05-22: Important decision [decay:10] [importance:5] [tags:foo]

### Summary
The important decision body.

### Why
Because doctrine.

### How to Apply
Always.

### Final Bridge
Operational noise that should NOT be promoted.

### Next Actions
More operational noise.

### Source Journal
/path/to/journal.md

---
`);
  return root;
}

function tempSetupAmbiguous() {
  const root = tempSetup();
  const memory = fs.readFileSync(path.join(root, "memory", "demo", "MEMORY.md"), "utf-8");
  fs.writeFileSync(path.join(root, "memory", "demo", "MEMORY.md"), memory + `
## 2026-05-22: Second entry same day [decay:8] [importance:4] [tags:bar]

### Summary
Another entry.

### Why
Different why.

---
`);
  return root;
}

test("promoteMemoryEntryToSoul: dry-run is the default and does not write", () => {
  const root = tempSetup();
  try {
    const soulBefore = fs.readFileSync(path.join(root, "souls", "demo", "SOUL.md"), "utf-8");
    const memBefore = fs.readFileSync(path.join(root, "memory", "demo", "MEMORY.md"), "utf-8");
    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      section: "Constraints",
    });
    assert.equal(r.promoted, false);
    assert.equal(r.dryRun, true);
    assert(r.preview, "preview must be returned");
    // Title pointer, Why, and How to Apply appear in the preview
    assert(r.preview.includes("Important decision"));
    assert(r.preview.includes("Because doctrine"));
    assert(r.preview.includes("Always"));
    // Redline 3: Summary body text must NOT appear in the preview
    assert(!r.preview.includes("The important decision body."), "Summary body text must NOT appear in dry-run preview");
    assert(!r.preview.includes("Operational noise"));
    assert.equal(fs.readFileSync(path.join(root, "souls", "demo", "SOUL.md"), "utf-8"), soulBefore);
    assert.equal(fs.readFileSync(path.join(root, "memory", "demo", "MEMORY.md"), "utf-8"), memBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoteMemoryEntryToSoul: dryRun=false writes title pointer + Why + How to Apply only (no Summary body, no operational sections)", () => {
  const root = tempSetup();
  try {
    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });
    assert.equal(r.promoted, true);
    const soul = fs.readFileSync(path.join(root, "souls", "demo", "SOUL.md"), "utf-8");
    // Title pointer must appear (the "Important decision" pointer line)
    assert.match(soul, /## Constraints[\s\S]*Promoted from MEMORY 2026-05-22[\s\S]*Important decision/);
    // Why and How to Apply ARE promoted as doctrine
    assert.match(soul, /Because doctrine/);
    assert.match(soul, /Always/);
    // Redline 3: Summary body text must NOT appear in SOUL
    assert(!soul.includes("The important decision body."), "Summary body text must NOT be promoted into SOUL.md");
    // Operational sections must NOT appear in SOUL
    assert(!soul.includes("Operational noise"), "Final Bridge / Next Actions must NOT be promoted");
    assert(!soul.includes("/path/to/journal.md"), "Source Journal must NOT be promoted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoteMemoryEntryToSoul: marks MEMORY entry [promoted:true] only on real write", () => {
  const root = tempSetup();
  try {
    promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      section: "Values",
    });
    let memory = fs.readFileSync(path.join(root, "memory", "demo", "MEMORY.md"), "utf-8");
    assert(!memory.includes("[promoted:true]"));

    promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      section: "Values",
      dryRun: false,
    });
    memory = fs.readFileSync(path.join(root, "memory", "demo", "MEMORY.md"), "utf-8");
    assert.match(memory, /\[promoted:true\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoteMemoryEntryToSoul: requires entry_title when multiple entries share date", () => {
  const root = tempSetupAmbiguous();
  try {
    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });
    assert.equal(r.promoted, false);
    assert.match(r.error || "", /multiple entries/i);
    assert.match(r.error || "", /entry_title/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoteMemoryEntryToSoul: entry_title disambiguates among same-date entries", () => {
  const root = tempSetupAmbiguous();
  try {
    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      entryTitle: "Second entry same day",
      section: "Constraints",
      dryRun: false,
    });
    assert.equal(r.promoted, true);
    const soul = fs.readFileSync(path.join(root, "souls", "demo", "SOUL.md"), "utf-8");
    assert.match(soul, /Second entry same day/);
    assert(!soul.includes("Important decision"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoteMemoryEntryToSoul: idempotent (second real promote no-op)", () => {
  const root = tempSetup();
  try {
    promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });
    const after1 = fs.readFileSync(path.join(root, "souls", "demo", "SOUL.md"), "utf-8");
    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });
    const after2 = fs.readFileSync(path.join(root, "souls", "demo", "SOUL.md"), "utf-8");
    assert.equal(after1, after2);
    assert.equal(r.promoted, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoteMemoryEntryToSoul: error when SOUL.md missing", () => {
  const root = tempSetup();
  try {
    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "MISSING.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });
    assert.equal(r.promoted, false);
    assert.match(r.error || "", /SOUL\.md not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoteMemoryEntryToSoul: error when MEMORY.md missing", () => {
  const root = tempSetup();
  try {
    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MISSING.md"),
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });
    assert.equal(r.promoted, false);
    assert.match(r.error || "", /MEMORY\.md not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoteMemoryEntryToSoul: error when entry date not found", () => {
  const root = tempSetup();
  try {
    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "1999-01-01",
      section: "Constraints",
      dryRun: false,
    });
    assert.equal(r.promoted, false);
    assert.match(r.error || "", /not found in MEMORY/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoteMemoryEntryToSoul: error when section heading missing in SOUL", () => {
  const root = tempSetup();
  try {
    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      section: "NonexistentSection",
      dryRun: false,
    });
    assert.equal(r.promoted, false);
    assert.match(r.error || "", /Section "## NonexistentSection" not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- Redline 4 regression tests ------------------------------------------------

test("promoted marker is durable: dryRun=false sets MemoryEntry.promoted and the heading carries [promoted:true]", async () => {
  const { parseMemoryMd } = await import("../dist/lib/memory.js");
  const root = tempSetup();
  try {
    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });
    assert.equal(r.promoted, true);

    // Heading-level marker present
    const memory = fs.readFileSync(path.join(root, "memory", "demo", "MEMORY.md"), "utf-8");
    assert.match(memory, /## 2026-05-22: Important decision \[decay:\d+\] \[importance:\d+\][^\n]*\[promoted:true\]/);

    // Model-level marker present after re-parse
    const parsed = parseMemoryMd(memory);
    const entry = parsed.entries.find(e => e.date === "2026-05-22" && e.title === "Important decision");
    assert(entry, "promoted entry must still be present in active list");
    assert.equal(entry.promoted, true, "MemoryEntry.promoted must be true after dryRun=false commit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoted marker survives parseMemoryMd + formatMemoryMd round-trip (durable across curation/end writes)", async () => {
  const { parseMemoryMd, formatMemoryMd } = await import("../dist/lib/memory.js");
  const root = tempSetup();
  try {
    // Commit a real promotion to land the durable marker on the heading.
    promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });

    // Simulate a later /end or curation write: parse the file, reformat it,
    // and rewrite. The marker must survive both legs.
    const original = fs.readFileSync(path.join(root, "memory", "demo", "MEMORY.md"), "utf-8");
    const parsed = parseMemoryMd(original);
    const entryBefore = parsed.entries.find(e => e.title === "Important decision");
    assert(entryBefore && entryBefore.promoted === true, "marker present after first parse");

    const reformatted = formatMemoryMd(parsed);
    assert.match(reformatted, /\[promoted:true\]/, "reformatted MEMORY must still carry [promoted:true] in the heading");

    const reparsed = parseMemoryMd(reformatted);
    const entryAfter = reparsed.entries.find(e => e.title === "Important decision");
    assert(entryAfter, "entry must survive round-trip");
    assert.equal(entryAfter.promoted, true, "MemoryEntry.promoted must survive parse+format round-trip");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoted marker is preserved across active <-> archive moves (only the matched entry is marked)", async () => {
  const { parseMemoryMd, formatMemoryMd } = await import("../dist/lib/memory.js");
  const root = tempSetupAmbiguous();
  try {
    // Promote ONLY the "Second entry same day" entry
    promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath: path.join(root, "memory", "demo", "MEMORY.md"),
      entryDate: "2026-05-22",
      entryTitle: "Second entry same day",
      section: "Constraints",
      dryRun: false,
    });

    const memory = fs.readFileSync(path.join(root, "memory", "demo", "MEMORY.md"), "utf-8");
    const parsed = parseMemoryMd(memory);
    const promoted = parsed.entries.find(e => e.title === "Second entry same day");
    const other = parsed.entries.find(e => e.title === "Important decision");
    assert(promoted && promoted.promoted === true, "selected entry must be marked promoted");
    assert(other && other.promoted === false, "other same-date entry must NOT be marked promoted");

    // Move promoted entry to archive and re-emit; marker must persist on the heading.
    promoted.isArchived = true;
    parsed.archivedEntries.unshift(promoted);
    parsed.entries = parsed.entries.filter(e => e.title !== "Second entry same day");
    const archive = formatMemoryMd(parsed, "archive");
    assert.match(archive, /\[promoted:true\]/, "[promoted:true] must survive active -> archive transition");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- P1: the MEMORY read-modify-write is serialized under the memory lock ----

test("promoteMemoryEntryToSoul: a real promote is REFUSED while the memory lock is held (contention path)", () => {
  const root = tempSetup();
  const memoryPath = path.join(root, "memory", "demo", "MEMORY.md");
  try {
    // Simulate a concurrent locked /end or curate holding the memory lock.
    assert.equal(acquireMemoryLock(memoryPath), true, "precondition: external holder acquires the lock");

    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath,
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });

    // The promote must not clobber the concurrent writer: it refuses rather than
    // doing an unlocked read-modify-write that could lose the [promoted:true]
    // marker (the lost-update class).
    assert.equal(r.promoted, false, "promote refuses while the lock is held");
    assert.match(r.error || "", /lock/i, "the error names the lock contention");

    // The MEMORY marker write was skipped (no unlocked write happened).
    const memory = fs.readFileSync(memoryPath, "utf-8");
    assert(!memory.includes("[promoted:true]"), "no marker written while the lock was contended");
  } finally {
    releaseMemoryLock(memoryPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoteMemoryEntryToSoul: after the lock is released the promote succeeds and writes the marker", () => {
  const root = tempSetup();
  const memoryPath = path.join(root, "memory", "demo", "MEMORY.md");
  try {
    // Hold then release: the lock must not be left orphaned by a refused promote.
    assert.equal(acquireMemoryLock(memoryPath), true);
    promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath,
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });
    releaseMemoryLock(memoryPath);

    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath,
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });
    assert.equal(r.promoted, true, "promote succeeds once the lock is free");
    const memory = fs.readFileSync(memoryPath, "utf-8");
    assert.match(memory, /\[promoted:true\]/, "marker written after acquiring the lock");

    // The lock is released by the successful promote (try/finally), so a
    // subsequent acquire succeeds.
    assert.equal(acquireMemoryLock(memoryPath), true, "lock released after a successful promote");
    releaseMemoryLock(memoryPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promoteMemoryEntryToSoul: the MEMORY marker write produces a .bak snapshot (atomicWriteWithBackup)", () => {
  const root = tempSetup();
  const memoryPath = path.join(root, "memory", "demo", "MEMORY.md");
  try {
    const priorMemory = fs.readFileSync(memoryPath, "utf-8");
    const r = promoteMemoryEntryToSoul({
      soulPath: path.join(root, "souls", "demo", "SOUL.md"),
      memoryPath,
      entryDate: "2026-05-22",
      section: "Constraints",
      dryRun: false,
    });
    assert.equal(r.promoted, true);
    // The promotion-marker write goes through atomicWriteWithBackup, so a
    // single-generation .bak snapshot of the prior MEMORY.md must exist.
    assert.ok(fs.existsSync(`${memoryPath}.bak`), "MEMORY.md.bak snapshot exists after the marker write");
    assert.equal(
      fs.readFileSync(`${memoryPath}.bak`, "utf-8"),
      priorMemory,
      ".bak holds the prior (pre-marker) MEMORY.md generation"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
