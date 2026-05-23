import test from "node:test";
import assert from "node:assert/strict";
import { findMemoryByTags } from "../dist/lib/memory-find.js";

const MEMORY = `---
document: MEMORY
project: test
---

# Project Memory: test

## 2026-05-22: A [decay:12] [importance:3] [tags:foo,bar]

content a

---

## 2026-05-21: B [decay:11] [importance:3] [tags:bar]

content b

---

## 2026-05-20: C [decay:10] [importance:3] [tags:baz]

content c

---
`;

const ARCHIVE = `---
document: MEMORY_ARCHIVE
project: test
---

## 2026-04-01: Old [decay:0] [importance:3] [tags:foo]

old content

---
`;

test("findMemoryByTags: AND semantics narrows on multiple tags", () => {
  const results = findMemoryByTags(MEMORY, ARCHIVE, ["foo", "bar"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "A");
});

test("findMemoryByTags: searches both active and archive", () => {
  const results = findMemoryByTags(MEMORY, ARCHIVE, ["foo"]);
  const titles = results.map(r => r.title).sort();
  assert.deepEqual(titles, ["A", "Old"]);
});

test("findMemoryByTags: empty when no match", () => {
  const results = findMemoryByTags(MEMORY, ARCHIVE, ["nope"]);
  assert.deepEqual(results, []);
});
