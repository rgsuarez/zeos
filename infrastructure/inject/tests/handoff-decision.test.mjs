import test from "node:test";
import assert from "node:assert/strict";
import { decideSnap, decideEndSession } from "../dist/lib/handoff.js";
import { RECONSTRUCTED_PLACEHOLDER_PREFIX } from "../dist/lib/bridge.js";

// =============================================================================
// Decision-logic (unit) tests for the extracted zeos_snap / zeos_end_session
// reject / recover / derive decision. These cover the DECISION only, not the
// request handler, CallTool dispatch, or stdio transport (that wire-level gap
// is acknowledged and deferred). Behavior must match the prior inline handler
// logic exactly; this suite pins the empty-call reject that the recovery layer
// structurally cannot rescue.
// =============================================================================

function envelopeOf(decision) {
  assert.equal(decision.kind, "reject");
  return JSON.parse(decision.envelope);
}

// ---- zeos_end_session ----

test("end: empty args reject ZEOS_MISSING_REQUIRED, never persist (the pinned regression)", () => {
  for (const input of [{}, undefined]) {
    const d = decideEndSession(input);
    assert.equal(d.kind, "reject");
    assert.notEqual(d.kind, "persist");
    assert.equal(d.code, "ZEOS_MISSING_REQUIRED");
    const env = envelopeOf(d);
    assert.equal(env.error_code, "ZEOS_MISSING_REQUIRED");
    assert.ok(env.missing_fields.includes("project"));
    assert.ok(env.missing_fields.includes("summary"));
    assert.ok(env.missing_fields.includes("nextActions"));
    // Sharpened hint references only existing fields, never a future handoff field.
    assert.doesNotMatch(env.hint, /handoff/i);
    assert.match(env.hint, /XML/);
  }
});

test("end: full legacy args persist with no recovery (happy path)", () => {
  const d = decideEndSession({ project: "p", summary: "did x", nextActions: "do y", delta: "bridge notes" });
  assert.equal(d.kind, "persist");
  assert.equal(d.project, "p");
  assert.equal(d.summary, "did x");
  assert.equal(d.nextActions, "do y");
  assert.ok(d.finalBridge.includes("bridge notes"));
  assert.equal(d.recovered, false);
  assert.deepEqual(d.sanitizedFields, []);
  assert.deepEqual(d.recoveryMissing, []);
});

test("end: missing nextActions (not recovered) rejects, naming only nextActions", () => {
  const d = decideEndSession({ project: "p", summary: "did x", delta: "bridge" });
  const env = envelopeOf(d);
  assert.deepEqual(env.missing_fields, ["nextActions"]);
});

test("end: leaked tool-grammar triggers recovery, strips tag, preserves content, persists", () => {
  const d = decideEndSession({ project: "p", summary: "wrapped</summary>", nextActions: "go", delta: "bridge" });
  assert.equal(d.kind, "persist");
  assert.equal(d.recovered, true);
  assert.ok(d.sanitizedFields.includes("summary"));
  assert.ok(d.summary.includes("wrapped"));
  assert.ok(!d.summary.includes("</summary>"));
});

test("end: recovery prepends 'recovered' tag and caps importance at 2", () => {
  const d = decideEndSession({ project: "p", summary: "x</summary>", nextActions: "go", delta: "b", importance: 5, tags: ["alpha"] });
  assert.equal(d.kind, "persist");
  assert.equal(d.recovered, true);
  assert.equal(d.tags[0], "recovered");
  assert.ok(d.tags.includes("alpha"));
  assert.ok(d.importance <= 2);
});

test("end: recovered with an empty required field fills an honest placeholder (degraded persist)", () => {
  // summary leaks a tag (so recovered=true); nextActions absent => placeholder-filled, not rejected.
  const d = decideEndSession({ project: "p", summary: "note</summary>", delta: "bridge" });
  assert.equal(d.kind, "persist");
  assert.equal(d.recovered, true);
  assert.ok(d.recoveryMissing.includes("nextActions"));
  assert.ok(d.nextActions.startsWith(RECONSTRUCTED_PLACEHOLDER_PREFIX));
});

test("end: clean non-allowlisted angle content does NOT trigger recovery (no over-fire)", () => {
  const d = decideEndSession({ project: "p", summary: "use <branch> and <oldbase> naming", nextActions: "go", delta: "bridge" });
  assert.equal(d.kind, "persist");
  assert.equal(d.recovered, false);
  assert.deepEqual(d.sanitizedFields, []);
  assert.ok(d.summary.includes("<branch>"));
});

// ---- zeos_snap ----

test("snap: empty args reject ZEOS_MISSING_REQUIRED", () => {
  for (const input of [{}, undefined]) {
    const d = decideSnap(input);
    assert.equal(d.kind, "reject");
    assert.equal(d.code, "ZEOS_MISSING_REQUIRED");
    const env = envelopeOf(d);
    assert.ok(env.missing_fields.includes("project"));
    assert.doesNotMatch(env.hint, /handoff/i);
  }
});

test("snap: project + delta persists (happy path)", () => {
  const d = decideSnap({ project: "p", delta: "progress", note: "n" });
  assert.equal(d.kind, "persist");
  assert.equal(d.project, "p");
  assert.ok(d.bridge.includes("progress"));
  assert.equal(d.note, "n");
  assert.equal(d.recovered, false);
});

test("snap: project only (no bridge content) rejects, naming bridge content", () => {
  const d = decideSnap({ project: "p" });
  const env = envelopeOf(d);
  assert.ok(env.missing_fields.some(m => m.includes("bridge content")));
});

test("snap: leaked tool-grammar triggers recovery, strips tag, prepends 'recovered'", () => {
  const d = decideSnap({ project: "p", delta: "notes</delta>", tags: ["x"] });
  assert.equal(d.kind, "persist");
  assert.equal(d.recovered, true);
  assert.ok(d.sanitizedFields.includes("delta"));
  assert.equal(d.tags[0], "recovered");
  assert.ok(d.bridge.includes("notes"));
  assert.ok(!d.bridge.includes("</delta>"));
});

test("snap: recovered with empty bridge after strip fills an honest placeholder", () => {
  const d = decideSnap({ project: "p", delta: "</delta>" });
  assert.equal(d.kind, "persist");
  assert.equal(d.recovered, true);
  assert.ok(d.recoveryMissing.includes("bridge"));
  assert.ok(d.bridge.startsWith(RECONSTRUCTED_PLACEHOLDER_PREFIX));
});
