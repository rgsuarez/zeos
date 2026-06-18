import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getLatestJournal,
  createJournalStub,
  extractJournalSummary,
} from "../dist/lib/journal.js";
import { RedactionAssertionError } from "../dist/lib/atomic-write.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zeos-journal-test-"));
}

// Runtime-built secret-shaped string, never a static token literal (mirrors the
// joinParts/padEnd technique used by redact.test.mjs).
function joinParts(...parts) {
  return parts.join("");
}
function secretShapedLine() {
  const value = joinParts("a", "b", "c").padEnd(32, "x");
  return `api_key="${value}"`;
}

test("createJournalStub: preserves full schema (schema_version, session_id, project, date, sequence, agent, instance, status, created)", () => {
  const dir = tempDir();
  try {
    const stub = createJournalStub(dir, "claude", { app_id: "demo" });
    const content = fs.readFileSync(path.join(dir, stub), "utf-8");
    assert.match(content, /schema_version: "2\.0\.0"/);
    assert.match(content, /session_id: "\d{4}-\d{2}-\d{2}-001"/);
    assert.match(content, /project: "demo"/);
    assert.match(content, /date: "\d{4}-\d{2}-\d{2}"/);
    assert.match(content, /sequence: 1\b/);
    assert.match(content, /agent: "claude"/);
    assert.match(content, /instance: "claude"/);
    assert.match(content, /status: active/);
    assert.match(content, /created: "\d{4}-\d{2}-\d{2}T/);
    assert.match(content, /# Session Journal: \d{4}-\d{2}-\d{2}-001/);
    assert.match(content, /\*Session started via zeos Inject MCP\*/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createJournalStub: atomic creation rejects sequence collision and advances", () => {
  const dir = tempDir();
  try {
    const stub1 = createJournalStub(dir, "claude", { app_id: "demo" });
    const stub2 = createJournalStub(dir, "claude", { app_id: "demo" });
    assert.notEqual(stub1, stub2);
    assert.match(stub1, /-001-claude\.md$/);
    assert.match(stub2, /-002-claude\.md$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createJournalStub: seeds carry-forward when provided", () => {
  const dir = tempDir();
  try {
    const cf = "## Carry-Forward from Previous Session\n\n### Open Threads\n- [ ] thread one\n";
    const stub = createJournalStub(dir, "claude", { app_id: "demo" }, cf);
    const content = fs.readFileSync(path.join(dir, stub), "utf-8");
    assert.match(content, /## Carry-Forward from Previous Session/);
    assert.match(content, /- \[ \] thread one/);
    assert.match(content, /schema_version: "2\.0\.0"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createJournalStub: no carry-forward section when not provided", () => {
  const dir = tempDir();
  try {
    const stub = createJournalStub(dir, "claude", { app_id: "demo" });
    const content = fs.readFileSync(path.join(dir, stub), "utf-8");
    assert(!content.includes("Carry-Forward from Previous Session"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createJournalStub: a carry-forward carrying a secret-shaped token throws BEFORE the file is written", () => {
  const dir = tempDir();
  try {
    // Carry-forward content is inherited from a prior session and could carry a
    // secret-shaped token. The pre-write gate must reject it before the
    // `{flag:"wx"}` write so no secret-shaped seed lands on disk.
    const cf = `## Carry-Forward from Previous Session\n\n### Open Threads\n- leaked ${secretShapedLine()}\n`;
    assert.throws(
      () => createJournalStub(dir, "claude", { app_id: "demo" }, cf),
      RedactionAssertionError,
    );
    // No journal file was created (the gate fired before the write).
    const stubs = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".md")) : [];
    assert.deepEqual(stubs, [], "no stub file is written when the redaction gate aborts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getLatestJournal: prefers status:complete over status:active", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "2026-05-22-001-claude.md"), `---
schema_version: "2.0.0"
session_id: "2026-05-22-001"
project: "demo"
date: "2026-05-22"
sequence: 1
agent: "claude"
instance: "claude"
status: complete
created: "2026-05-22T15:00:00Z"
---

# Session Journal: 2026-05-22-001

## Session End: 15:00:00

### Summary
Completed work on feature X with enough body content to exceed the stub threshold.

### Final Bridge
Done.
`);
    fs.writeFileSync(path.join(dir, "2026-05-22-002-claude.md"), `---
schema_version: "2.0.0"
session_id: "2026-05-22-002"
project: "demo"
date: "2026-05-22"
sequence: 2
agent: "claude"
instance: "claude"
status: active
created: "2026-05-22T16:00:00Z"
---

# Session Journal: 2026-05-22-002

## Carry-Forward from Previous Session

### Open Threads
- [ ] resume X
`);
    const latest = getLatestJournal(dir);
    assert(latest !== null);
    assert.match(latest, /status: complete/);
    assert(!latest.includes("Carry-Forward"), "active stub must not be returned as latest");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractJournalSummary: extracts ### Summary section", () => {
  const journal = `---
status: complete
---
# Session Journal

## Session End: 15:00:00

### Summary
This is the session summary.

### Final Bridge
ignored
`;
  assert.equal(extractJournalSummary(journal), "This is the session summary.");
});

test("getLatestJournal: expands ~/ paths internally (Redline 1)", () => {
  const home = os.homedir();
  const absDir = fs.mkdtempSync(path.join(home, "zeos-journal-tilde-test-"));
  try {
    fs.writeFileSync(path.join(absDir, "2026-05-22-001-claude.md"), `---
status: complete
---
# Session Journal

### Summary
Done with substantive content well past the stub threshold so this returns from the first pass.
`);
    const tildeDir = "~/" + path.relative(home, absDir);
    const latest = getLatestJournal(tildeDir);
    assert(latest !== null, "must expand ~/ before fs ops; null indicates expansion failure");
    assert.match(latest, /Done with substantive content/);
  } finally {
    fs.rmSync(absDir, { recursive: true, force: true });
  }
});

test("getLatestJournal: legacy journal without status frontmatter is treated as substantive (Redline 7)", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "2026-05-21-001-claude.md"), `---
date: 2026-05-21
sequence: 1
---
# Session Journal

## Summary
Legacy entry with no status field but with real content here.

More body content that exceeds the stub threshold by a comfortable margin so the second-pass back-compat branch returns it.
`);
    const latest = getLatestJournal(dir);
    assert(latest !== null);
    assert.match(latest, /Legacy entry with no status field/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getLatestJournal: active stub newer than completed journal returns the completed one (Redline 7)", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "2026-05-20-001-claude.md"), `---
status: complete
---
# Session Journal

### Summary
Older but complete with substantive body content that crosses the stub threshold by a wide margin.
`);
    fs.writeFileSync(path.join(dir, "2026-05-22-001-claude.md"), `---
status: active
---
# Session Journal

## Carry-Forward from Previous Session

Active stub seeded with carry-forward but no real session work yet, so should be skipped.
`);
    const latest = getLatestJournal(dir);
    assert(latest !== null);
    assert.match(latest, /Older but complete/, "newer active stub must NOT shadow older complete journal");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getLatestJournal: all-stub fallback returns newest stub (Redline 7)", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "2026-05-21-001-claude.md"), `---
status: active
---
# Session Journal
`);
    fs.writeFileSync(path.join(dir, "2026-05-22-001-claude.md"), `---
status: active
---
# Session Journal
`);
    const latest = getLatestJournal(dir);
    assert(latest !== null);
    assert(latest.includes("status: active"), "fallback should still return a stub when nothing else exists");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
