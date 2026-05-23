import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMemoryMd,
  formatMemoryMd,
  formatEntryHeading,
  parseEntryHeadingTail,
  ageMemoryEntries,
  memoryRetentionScore,
  curateMemory,
  formatMemoryEntryContent,
  estimateTokens,
  getMemoryTokenLimit,
  MEMORY_ENTRY_DECAY_DEFAULT,
  MEMORY_ENTRY_IMPORTANCE_DEFAULT,
  MEMORY_PROMOTION_IMPORTANCE_THRESHOLD,
} from "../dist/lib/memory.js";

test("constants: sensible defaults", () => {
  assert.equal(MEMORY_ENTRY_DECAY_DEFAULT, 12);
  assert.equal(MEMORY_ENTRY_IMPORTANCE_DEFAULT, 3);
  assert.equal(MEMORY_PROMOTION_IMPORTANCE_THRESHOLD, 4);
});

test("getMemoryTokenLimit: reads memory_token_limit from profile content", () => {
  assert.equal(getMemoryTokenLimit("memory_token_limit: 12345\nother: stuff"), 12345);
});

test("getMemoryTokenLimit: defaults to 10000 when missing", () => {
  assert.equal(getMemoryTokenLimit("name: operator\n"), 10000);
});

test("getMemoryTokenLimit: defaults to 10000 when content is empty", () => {
  assert.equal(getMemoryTokenLimit(""), 10000);
});

test("formatEntryHeading + parseEntryHeadingTail: round-trip", () => {
  const heading = formatEntryHeading({
    date: "2026-05-22",
    title: "Test entry",
    decay: 8,
    importance: 4,
    tags: ["alpha", "beta"],
    refs: [],
    content: "",
    isArchived: false,
  });
  assert.match(heading, /## 2026-05-22: Test entry \[decay:8\] \[importance:4\] \[tags:alpha,beta\]/);

  const tail = " [importance:4] [tags:alpha,beta]";
  const parsed = parseEntryHeadingTail(tail);
  assert.equal(parsed.importance, 4);
  assert.deepEqual(parsed.tags, ["alpha", "beta"]);
});

test("parseEntryHeadingTail: legacy heading defaults", () => {
  const parsed = parseEntryHeadingTail("");
  assert.equal(parsed.importance, MEMORY_ENTRY_IMPORTANCE_DEFAULT);
  assert.deepEqual(parsed.tags, []);
  assert.deepEqual(parsed.refs, []);
});

test("ageMemoryEntries: decrements decay, floor 0", () => {
  const parsed = {
    frontmatter: {},
    projectName: "test",
    entries: [
      { date: "2026-05-22", title: "a", decay: 3, importance: 2, tags: [], refs: [], content: "x", isArchived: false },
      { date: "2026-05-21", title: "b", decay: 0, importance: 5, tags: [], refs: [], content: "y", isArchived: false },
    ],
    archivedEntries: [],
  };
  ageMemoryEntries(parsed);
  assert.equal(parsed.entries[0].decay, 2);
  assert.equal(parsed.entries[1].decay, 0);
});

test("memoryRetentionScore: max(decay, importance)", () => {
  assert.equal(memoryRetentionScore({ decay: 1, importance: 5 }), 5);
  assert.equal(memoryRetentionScore({ decay: 8, importance: 2 }), 8);
  assert.equal(memoryRetentionScore({ decay: 3, importance: 3 }), 3);
});

test("curateMemory: archives lowest retention first", () => {
  // Use whitespace-separated content so estimateTokens (words * 1.8) reflects size.
  const longContent = ("word ".repeat(800)).trim(); // ~800 words = ~1440 tokens per entry
  const parsed = {
    frontmatter: {},
    projectName: "test",
    entries: [
      { date: "2026-05-22", title: "a", decay: 1, importance: 1, tags: [], refs: [], content: longContent, isArchived: false },
      { date: "2026-05-21", title: "b", decay: 10, importance: 5, tags: [], refs: [], content: longContent, isArchived: false },
      { date: "2026-05-20", title: "c", decay: 2, importance: 2, tags: [], refs: [], content: longContent, isArchived: false },
    ],
    archivedEntries: [],
  };
  const { curated, movedEntries } = curateMemory(parsed, 1000);
  assert(movedEntries.length >= 1);
  assert.equal(movedEntries[0].title, "a");
  const titles = curated.entries.map(e => e.title);
  assert(titles.includes("b"));
});

test("curateMemory: never archives importance >= MEMORY_PROMOTION_IMPORTANCE_THRESHOLD", () => {
  const longContent = ("word ".repeat(2000)).trim(); // ~3600 tokens
  const parsed = {
    frontmatter: {},
    projectName: "test",
    entries: [
      { date: "2026-05-22", title: "important", decay: 0, importance: 5, tags: [], refs: [], content: longContent, isArchived: false },
    ],
    archivedEntries: [],
  };
  const { curated, movedEntries } = curateMemory(parsed, 100);
  assert.equal(movedEntries.length, 0);
  assert.equal(curated.entries.length, 1);
});

test("formatMemoryEntryContent: includes Why and HowToApply when present", () => {
  const content = formatMemoryEntryContent(
    "summary text", "bridge text", "next actions",
    "/path/to/journal.md", { text: "", count: 0, labels: [] },
    "the why", "how to apply", ["file:a.ts", "PR #42"]
  );
  assert.match(content, /### Summary\nsummary text/);
  assert.match(content, /### Why\nthe why/);
  assert.match(content, /### How to Apply\nhow to apply/);
  assert.match(content, /### References\n- file:a\.ts\n- PR #42/);
  assert.match(content, /### Source Journal\n\/path\/to\/journal\.md/);
});

test("parseMemoryMd + formatMemoryMd: round-trip preserves entries", () => {
  const original = `---
document: MEMORY
project: test
purpose: test
token_estimate: 0
entry_count: 1
archive_count: 0
---

# Project Memory: test

## 2026-05-22: Test entry [decay:12] [importance:3] [tags:foo,bar]

### Summary
Some summary.

### Next Actions
Do the thing.

---
`;
  const parsed = parseMemoryMd(original);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].title, "Test entry");
  assert.equal(parsed.entries[0].importance, 3);
  assert.deepEqual(parsed.entries[0].tags, ["foo", "bar"]);

  const reformatted = formatMemoryMd(parsed);
  const reparsed = parseMemoryMd(reformatted);
  assert.equal(reparsed.entries[0].title, parsed.entries[0].title);
  assert.deepEqual(reparsed.entries[0].tags, parsed.entries[0].tags);
});

test("formatEntryHeading: refs are NOT emitted in heading (Redline 3 - refs live in body)", () => {
  const heading = formatEntryHeading({
    date: "2026-05-22",
    title: "Entry",
    decay: 8,
    importance: 4,
    tags: ["foo"],
    refs: ["file:a.ts", "PR #1"],
    content: "",
    isArchived: false,
  });
  assert(!heading.includes("[refs:"), "refs must not appear in heading; refs live in entry body under ### References");
});

test("formatMemoryMd active: frontmatter quotes strings, leaves numbers unquoted, sets bookkeeping fields (Redline 2)", () => {
  const parsed = {
    frontmatter: { document: "MEMORY", project: "test", purpose: "test purpose", token_estimate: 0, entry_count: 0, archive_count: 0 },
    projectName: "test",
    entries: [
      { date: "2026-05-22", title: "Active", decay: 5, importance: 3, tags: [], refs: [], content: "body", isArchived: false },
    ],
    archivedEntries: [],
  };
  const out = formatMemoryMd(parsed, "active");
  assert.match(out, /^---\n/);
  assert.match(out, /document: "MEMORY"/, "string values must be quoted");
  assert.match(out, /project: "test"/);
  assert.match(out, /entry_count: 1/, "numeric values unquoted; entry_count reflects actual count");
  assert.match(out, /archive_count: 0/);
  assert.match(out, /last_updated: "\d{4}-\d{2}-\d{2}T/, "last_updated must be ISO timestamp string");
  assert.match(out, /token_estimate: \d+/, "token_estimate must be a positive number computed over header + digest + entries");
});

test("formatMemoryMd active: includes continuity digest before entries when present", () => {
  const parsed = {
    frontmatter: { document: "MEMORY" },
    projectName: "test",
    entries: [
      { date: "2026-05-22", title: "After", decay: 5, importance: 3, tags: [], refs: [], content: "body", isArchived: false },
    ],
    archivedEntries: [],
    continuityDigest: "## Continuity Digest\n\n### Open Threads\n- [ ] one\n\n---\n",
  };
  const out = formatMemoryMd(parsed, "active");
  const digestIdx = out.indexOf("## Continuity Digest");
  const entryIdx = out.indexOf("## 2026-05-22:");
  assert(digestIdx > 0 && entryIdx > digestIdx, "digest must appear before entries");
});

test("formatMemoryMd archive: archive header, no frontmatter, cold-storage subheader (Redline 4)", () => {
  const parsed = {
    frontmatter: { document: "MEMORY" },
    projectName: "test",
    entries: [],
    archivedEntries: [
      { date: "2026-04-01", title: "Old", decay: 0, importance: 3, tags: ["foo"], refs: [], content: "old content", isArchived: true },
    ],
  };
  const out = formatMemoryMd(parsed, "archive");
  assert(!out.startsWith("---"), "archive output must NOT have YAML frontmatter");
  assert.match(out, /^# Project Memory Archive: test/, "archive header line must match exact format");
  assert.match(out, /\*Cold storage for project memory entries moved from MEMORY\.md\*/, "cold-storage subheader required");
  assert.match(out, /## 2026-04-01: Old \[decay:0\] \[importance:3\] \[tags:foo\]/);
  assert(out.includes("old content"));
});

test("parseMemoryMd: parses dated entries from archive content with no frontmatter (Redline 4)", () => {
  const archive = `# Project Memory Archive: test

*Cold storage for project memory entries moved from MEMORY.md*

---

## 2026-04-01: Old [decay:0] [importance:3] [tags:foo]

old content

---
`;
  const parsed = parseMemoryMd("# Project Memory: test\n", archive);
  assert.equal(parsed.archivedEntries.length, 1);
  assert.equal(parsed.archivedEntries[0].title, "Old");
  assert.deepEqual(parsed.archivedEntries[0].tags, ["foo"]);
});

test("estimateTokens: positive correlation with input length", () => {
  const small = estimateTokens("hello");
  const big = estimateTokens("hello ".repeat(100));
  assert(big > small);
  assert(small >= 1);
});
