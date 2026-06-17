import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SUBSTANTIVE_BODY_THRESHOLD,
  hasSessionEndBlock,
  isJournalComplete,
  isUnworkedStub,
  readJournalMeta,
  getLatestJournalMeta,
  createJournalStub,
  findReusableEmptyStub,
  checkParallelInstances,
  appendSessionEnd,
  hasOpenNextActions,
  shouldLoadPrior,
  selectPriorJournal,
  budgetPriorJournal,
} from "../dist/lib/journal.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zeos-continuity-test-"));
}

// Write a journal file with raw frontmatter + body.
function writeJournal(dir, name, fm, body) {
  fs.writeFileSync(path.join(dir, name), `---\n${fm}\n---\n\n${body}\n`);
  return name;
}

const LONG = "Real session work body content that comfortably exceeds the substantive threshold by a wide margin so the journal counts as worked.";
const today = new Date().toISOString().split("T")[0];

// ---- completion detection ----

test("hasSessionEndBlock: ISO and legacy time-only blocks both match; fenced quote does not", () => {
  assert.equal(hasSessionEndBlock("# J\n\n## Session End: 2026-01-01T00:00:00Z\n\n### Summary\nx"), true);
  assert.equal(hasSessionEndBlock("# J\n\n## Session End: 15:00:00\n\n### Summary\nx"), true);
  // quoted inside a fenced code block must NOT be treated as a real end block
  assert.equal(hasSessionEndBlock("# J\n\n```\n## Session End: 15:00:00\n```\n"), false);
  assert.equal(hasSessionEndBlock("# J\n\n## Checkpoint: 12:00:00\nwork"), false);
});

test("isJournalComplete: block OR legacy status:complete; active stub is incomplete", () => {
  const dir = tempDir();
  try {
    // block present, status still active -> complete via block
    const a = `${"---\nstatus: active\n---\n\n# J\n\n## Session End: 15:00:00\n\n### Summary\nx"}`;
    assert.equal(isJournalComplete(a), true);
    // legacy status:complete, no block -> complete via status
    assert.equal(isJournalComplete("---\nstatus: complete\n---\n\n# J\n\n### Summary\n" + LONG), true);
    // active, no block -> incomplete
    assert.equal(isJournalComplete("---\nstatus: active\n---\n\n# J\n\n" + LONG), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- substance (carry-forward stubs must not look like work) ----

test("isUnworkedStub: bare and carry-forward-only stubs are unworked; work/legacy-prose are not", () => {
  assert.equal(isUnworkedStub("---\nstatus: active\n---\n\n# Session Journal: x\n"), true);
  // carry-forward block can exceed 100 chars but is NOT real work
  const cf = "---\nstatus: active\n---\n\n# J\n\n## Carry-Forward from Previous Session\n\n### Open Threads\n- [ ] resume the long-running migration task that was left in flight earlier today\n";
  assert(cf.length > SUBSTANTIVE_BODY_THRESHOLD);
  assert.equal(isUnworkedStub(cf), true);
  // a checkpoint = real work
  assert.equal(isUnworkedStub("---\nstatus: active\n---\n\n# J\n\n## Checkpoint: 12:00:00\nwork"), false);
  // legacy prose with no carry-forward and >threshold body = real work
  assert.equal(isUnworkedStub("---\n---\n\n# J\n\n## Summary\n" + LONG), false);
});

// ---- previous_session seeding ----

test("createJournalStub: seeds previous_session (quoted) and null; readJournalMeta parses both", () => {
  const dir = tempDir();
  try {
    const withPrev = createJournalStub(dir, "claude", { app_id: "demo" }, "", "2026-05-01-001");
    const c1 = fs.readFileSync(path.join(dir, withPrev), "utf-8");
    assert.match(c1, /previous_session: "2026-05-01-001"/);
    assert.equal(readJournalMeta(dir, withPrev).previousSession, "2026-05-01-001");

    const noPrev = createJournalStub(dir, "claude", { app_id: "demo" });
    const c2 = fs.readFileSync(path.join(dir, noPrev), "utf-8");
    assert.match(c2, /previous_session: null/);
    assert.equal(readJournalMeta(dir, noPrev).previousSession, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getLatestJournalMeta: returns latest substantive sessionId; null on empty dir", () => {
  const dir = tempDir();
  try {
    assert.equal(getLatestJournalMeta(dir), null);
    writeJournal(dir, "2026-05-20-001-claude.md", 'session_id: "2026-05-20-001"\nstatus: complete', "# J\n\n## Session End: 15:00:00\n\n### Summary\n" + LONG);
    const meta = getLatestJournalMeta(dir);
    assert.equal(meta.sessionId, "2026-05-20-001");
    assert.equal(meta.isComplete, true);
    assert.equal(meta.isSubstantive, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- stub reuse (staleness-guarded) ----

test("findReusableEmptyStub: reuse only on matching previous_session; mismatch/missing/worked/other-agent -> fresh", () => {
  // (a) matching expected prior -> reuse; (b) mismatch -> null; different agent -> null
  const d1 = tempDir();
  try {
    const s1 = writeJournal(d1, `${today}-001-claude.md`, 'status: active\nprevious_session: "2026-05-01-001"', "# Session Journal");
    assert.equal(findReusableEmptyStub(d1, "claude", today, "2026-05-01-001"), s1);
    assert.equal(findReusableEmptyStub(d1, "claude", today, "2026-05-02-001"), null);
    assert.equal(findReusableEmptyStub(d1, "codex", today, "2026-05-01-001"), null);
  } finally {
    fs.rmSync(d1, { recursive: true, force: true });
  }
  // (b') missing previous_session field (pre-PR1 stub) vs a non-null expected prior -> no reuse
  const d2 = tempDir();
  try {
    writeJournal(d2, `${today}-001-claude.md`, "status: active", "# Session Journal");
    assert.equal(findReusableEmptyStub(d2, "claude", today, "2026-05-01-001"), null);
  } finally {
    fs.rmSync(d2, { recursive: true, force: true });
  }
  // (c) worked stub (has a checkpoint) is never reused even if previous_session matches
  const d3 = tempDir();
  try {
    writeJournal(d3, `${today}-001-claude.md`, 'status: active\nprevious_session: "2026-05-01-001"', "# J\n\n## Checkpoint: now\nwork");
    assert.equal(findReusableEmptyStub(d3, "claude", today, "2026-05-01-001"), null);
  } finally {
    fs.rmSync(d3, { recursive: true, force: true });
  }
});

test("findReusableEmptyStub: both-null previous_session counts as a match", () => {
  const dir = tempDir();
  try {
    const stub = writeJournal(dir, `${today}-001-claude.md`, 'status: active\nprevious_session: null', "# Session Journal");
    assert.equal(findReusableEmptyStub(dir, "claude", today, null), stub);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- parallel detection ----

test("checkParallelInstances: warns on other agents and current substantive interrupted; suppresses current unworked stub", () => {
  const dir = tempDir();
  try {
    // current agent unworked stub -> suppressed
    writeJournal(dir, `${today}-001-claude.md`, "status: active", "# Session Journal");
    // other agent unworked stub -> warns
    writeJournal(dir, `${today}-001-codex.md`, "status: active", "# Session Journal");
    // current agent substantive interrupted (checkpoint, no end) -> warns
    writeJournal(dir, `${today}-002-claude.md`, "status: active", "# J\n\n## Checkpoint: now\n" + LONG);
    // a completed journal -> never counted
    writeJournal(dir, `${today}-003-claude.md`, "status: active", "# J\n\n## Session End: 15:00:00\n\n### Summary\n" + LONG);

    const active = checkParallelInstances(dir, "claude").sort();
    assert.deepEqual(active, ["claude", "codex"]); // codex stub + claude's substantive interrupted; claude's unworked stub suppressed
    // without currentAgent, nothing is suppressed (the explicit /parallel query)
    const all = checkParallelInstances(dir).sort();
    assert.deepEqual(all, ["claude", "claude", "codex"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- append-only /end ----

test("appendSessionEnd: preserves prior content, frontmatter status untouched, second append is additive", () => {
  const dir = tempDir();
  try {
    const name = writeJournal(dir, `${today}-001-claude.md`, "status: active", "# J\n\n## Checkpoint: 12:00:00\nearlier work");
    const p = path.join(dir, name);
    const before = fs.readFileSync(p, "utf-8");
    appendSessionEnd(p, "\n## Session End: 13:00:00\n\n### Summary\ndone\n");
    const after = fs.readFileSync(p, "utf-8");
    assert(after.startsWith(before), "append must not rewrite earlier bytes");
    assert.match(after, /## Checkpoint: 12:00:00/);
    assert.match(after, /## Session End: 13:00:00/);
    assert.match(after, /status: active/);
    assert.doesNotMatch(after, /status: complete/);
    // a second end-append does not corrupt the first
    appendSessionEnd(p, "\n## Session End: 14:00:00\n\n### Summary\nagain\n");
    const after2 = fs.readFileSync(p, "utf-8");
    assert.equal((after2.match(/## Session End:/g) || []).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- continuation predicate + chain ----

test("hasOpenNextActions: reads the Session End region, ignores carry-forward, filters placeholders", () => {
  const ended = "# J\n\n## Carry-Forward from Previous Session\n\n### Next Actions\n1. inherited item\n\n---\n\n## Session End: 15:00:00\n\n### Next Actions\n1. real follow-up\n";
  assert.equal(hasOpenNextActions(ended), true);
  const placeholder = "# J\n\n## Session End: 15:00:00\n\n### Next Actions\n*None specified*\n";
  assert.equal(hasOpenNextActions(placeholder), false);
  // carry-forward has next actions but the Session End region does not
  const cfOnly = "# J\n\n## Carry-Forward from Previous Session\n\n### Next Actions\n1. inherited only\n\n---\n\n## Session End: 15:00:00\n\n### Summary\ndone\n";
  assert.equal(hasOpenNextActions(cfOnly), false);
  // no session end block at all
  assert.equal(hasOpenNextActions("# J\n\n### Next Actions\n1. x"), false);
});

test("shouldLoadPrior: interrupted OR clean-end-with-open-next-actions; not for clean self-contained end or stub", () => {
  const dir = tempDir();
  try {
    const interrupted = readJournalMeta(dir, writeJournal(dir, `${today}-101-claude.md`, "status: active", "# J\n\n## Checkpoint: now\n" + LONG));
    assert.equal(shouldLoadPrior(interrupted), true);

    const openEnd = readJournalMeta(dir, writeJournal(dir, `${today}-102-claude.md`, "status: active", "# J\n\n## Session End: 15:00:00\n\n### Next Actions\n1. keep going\n"));
    assert.equal(shouldLoadPrior(openEnd), true);

    const cleanEnd = readJournalMeta(dir, writeJournal(dir, `${today}-103-claude.md`, "status: active", "# J\n\n## Session End: 15:00:00\n\n### Next Actions\n*None specified*\n\n### Summary\n" + LONG));
    assert.equal(shouldLoadPrior(cleanEnd), false);

    const stub = readJournalMeta(dir, writeJournal(dir, `${today}-104-claude.md`, "status: active", "# Session Journal"));
    assert.equal(shouldLoadPrior(stub), false);
    assert.equal(shouldLoadPrior(null), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("selectPriorJournal: via previous_session link, else filename fallback, else null", () => {
  const dir = tempDir();
  try {
    // older substantive journal that the latest links to
    writeJournal(dir, "2026-05-19-001-claude.md", 'session_id: "2026-05-19-001"\nstatus: complete', "# J\n\n## Session End: 15:00:00\n\n### Summary\n" + LONG);
    // latest, interrupted, links to the older one
    const latest = readJournalMeta(dir, writeJournal(dir, "2026-05-20-001-claude.md", 'session_id: "2026-05-20-001"\nstatus: active\nprevious_session: "2026-05-19-001"', "# J\n\n## Checkpoint: now\n" + LONG));
    const viaLink = selectPriorJournal(dir, latest);
    assert.equal(viaLink.viaPreviousSession, true);
    assert.equal(viaLink.meta.sessionId, "2026-05-19-001");

    // fallback: latest without previous_session, another substantive journal present
    const latestNoLink = readJournalMeta(dir, writeJournal(dir, "2026-05-21-001-claude.md", 'session_id: "2026-05-21-001"\nstatus: active', "# J\n\n## Checkpoint: now\n" + LONG));
    const viaFallback = selectPriorJournal(dir, latestNoLink);
    assert.equal(viaFallback.viaPreviousSession, false);
    assert(viaFallback.meta.file !== latestNoLink.file);

    // none: a single-journal dir
    const solo = tempDir();
    try {
      const only = readJournalMeta(solo, writeJournal(solo, "2026-05-22-001-claude.md", 'session_id: "2026-05-22-001"\nstatus: active', "# J\n\n## Checkpoint: now\n" + LONG));
      assert.equal(selectPriorJournal(solo, only), null);
    } finally {
      fs.rmSync(solo, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("budgetPriorJournal: verbatim under budget; summary then truncation when over budget", () => {
  const dir = tempDir();
  try {
    const small = readJournalMeta(dir, writeJournal(dir, "2026-05-20-001-claude.md", "status: complete", "# J\n\n## Session End: 15:00:00\n\n### Summary\nshort"));
    assert.equal(budgetPriorJournal(small, 800), small.content); // verbatim

    const bigSummaryBody = "## Session End: 15:00:00\n\n### Summary\n" + "concise summary sentence. ".repeat(3) + "\n\n### Final Bridge\n" + "filler ".repeat(2000);
    const bigWithSummary = readJournalMeta(dir, writeJournal(dir, "2026-05-21-001-claude.md", "status: complete", "# J\n\n" + bigSummaryBody));
    const budgeted = budgetPriorJournal(bigWithSummary, 50);
    assert.match(budgeted, /summarized to fit/);

    const bigNoSummary = readJournalMeta(dir, writeJournal(dir, "2026-05-22-001-claude.md", "status: active", "# J\n\n## Checkpoint: now\n" + "loremipsum ".repeat(3000)));
    const truncated = budgetPriorJournal(bigNoSummary, 50);
    assert.match(truncated, /truncated to fit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getLatestJournalMeta: newer interrupted real-work journal beats older completed (PR1 predicate)", () => {
  const dir = tempDir();
  try {
    // older, completed, substantive
    writeJournal(dir, "2026-05-20-001-claude.md", 'session_id: "2026-05-20-001"\nstatus: complete', "# J\n\n## Session End: 15:00:00\n\n### Summary\n" + LONG);
    // newer, interrupted (checkpoint, no end) with real work
    writeJournal(dir, "2026-05-21-001-claude.md", 'session_id: "2026-05-21-001"\nstatus: active', "# J\n\n## Checkpoint: now\n" + LONG);
    const latest = getLatestJournalMeta(dir);
    assert.equal(latest.sessionId, "2026-05-21-001", "newer interrupted real-work journal must be latest");
    assert.equal(latest.isComplete, false);
    assert.equal(shouldLoadPrior(latest), true, "interrupted latest must trigger continuation");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("selectPriorJournal: fallback chooses the next OLDER journal, not a newer sibling", () => {
  const dir = tempDir();
  try {
    writeJournal(dir, "2026-05-18-001-claude.md", 'session_id: "2026-05-18-001"\nstatus: complete', "# J\n\n## Session End: 15:00:00\n\n### Summary\n" + LONG);
    const latest = readJournalMeta(dir, writeJournal(dir, "2026-05-19-001-claude.md", 'session_id: "2026-05-19-001"\nstatus: active', "# J\n\n## Checkpoint: now\n" + LONG));
    // a NEWER substantive sibling exists in the dir
    writeJournal(dir, "2026-05-20-001-claude.md", 'session_id: "2026-05-20-001"\nstatus: active', "# J\n\n## Checkpoint: now\n" + LONG);
    // latest has no previous_session -> fallback path; must pick the OLDER 05-18, not newer 05-20
    const prior = selectPriorJournal(dir, latest);
    assert(prior !== null);
    assert.equal(prior.viaPreviousSession, false);
    assert.equal(prior.meta.sessionId, "2026-05-18-001", "fallback must pick next-older, not newer sibling");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
