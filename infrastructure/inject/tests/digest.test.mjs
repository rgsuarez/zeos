import test from "node:test";
import assert from "node:assert/strict";
import { parseDigestFromMemory, formatCarryForwardBlock } from "../dist/lib/digest.js";

const SAMPLE_MEMORY = `---
document: MEMORY
---

# Project Memory: test

## Continuity Digest

### Last 3 Sessions
- 2026-05-22-001-claude: did a thing
- 2026-05-21-001-claude: did another thing

### Open Threads
- [ ] thread one
- [ ] thread two

### Decisions/Constraints
- Decision A

### Next Actions
1. Do the thing
2. Then the other thing

---

## 2026-05-22: Some entry [decay:12] [importance:3]

content here
`;

test("parseDigestFromMemory: extracts all four sections", () => {
  const digest = parseDigestFromMemory(SAMPLE_MEMORY);
  assert(digest !== null);
  assert.deepEqual(digest.lastSessions, ["2026-05-22-001-claude: did a thing", "2026-05-21-001-claude: did another thing"]);
  assert.deepEqual(digest.openThreads, ["thread one", "thread two"]);
  assert.deepEqual(digest.decisions, ["Decision A"]);
  assert.deepEqual(digest.nextActions, ["Do the thing", "Then the other thing"]);
});

test("parseDigestFromMemory: returns null when no digest section", () => {
  const digest = parseDigestFromMemory("# Project Memory: x\n\n## 2026-05-22: foo [decay:1] [importance:1]\n\nx\n");
  assert.equal(digest, null);
});

test("parseDigestFromMemory: handles digest at EOF with no entries", () => {
  const digestOnly = `# Project Memory: x\n\n## Continuity Digest\n\n### Open Threads\n- [ ] lonely thread\n\n---\n`;
  const digest = parseDigestFromMemory(digestOnly);
  assert(digest !== null);
  assert.deepEqual(digest.openThreads, ["lonely thread"]);
});

test("formatCarryForwardBlock: renders populated sections", () => {
  const block = formatCarryForwardBlock({
    lastSessions: [],
    openThreads: ["thread one"],
    decisions: ["Decision A"],
    nextActions: ["Do the thing"],
  });
  assert.match(block, /## Carry-Forward from Previous Session/);
  assert.match(block, /### Open Threads\n- \[ \] thread one/);
  assert.match(block, /### Decisions\/Constraints\n- Decision A/);
  assert.match(block, /### Next Actions\n1\. Do the thing/);
});

test("formatCarryForwardBlock: empty digest yields placeholder", () => {
  const block = formatCarryForwardBlock({ lastSessions: [], openThreads: [], decisions: [], nextActions: [] });
  assert.match(block, /## Carry-Forward from Previous Session/);
  assert.match(block, /\*No prior continuity digest available\*/);
});
