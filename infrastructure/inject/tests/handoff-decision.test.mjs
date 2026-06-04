import test from "node:test";
import assert from "node:assert/strict";
import { decideSnap, decideEndSession, deriveNextActions, HANDOFF_NEXT_ACTIONS_FALLBACK } from "../dist/lib/handoff.js";
import { RECONSTRUCTED_PLACEHOLDER_PREFIX, firstContentLine } from "../dist/lib/bridge.js";
import { redactSensitiveText } from "../dist/lib/redact.js";

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
    // Hint now leads with the preferred { project, handoff } shape.
    assert.match(env.hint, /handoff/i);
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
    assert.match(env.hint, /handoff/i);
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

// ---- Phase 2: single-narrative handoff field ----

test("handoff/end: happy with heading -> finalBridge is the whole blob, summary concise, nextActions extracted (no duplication)", () => {
  const handoff = "Shipped X. Decided Y.\n## Next Actions\n- ship Z";
  const d = decideEndSession({ project: "p", handoff });
  assert.equal(d.kind, "persist");
  assert.equal(d.finalBridge, handoff);                 // full blob stored once
  assert.equal(d.summary, firstContentLine(handoff));   // concise derived summary
  assert.notEqual(d.summary, d.finalBridge);            // not a second full copy
  assert.ok(d.summary.length < handoff.length);
  assert.match(d.nextActions, /ship Z/);
  assert.notEqual(d.nextActions, handoff);              // extracted section, not the blob
  assert.equal(d.recovered, false);
});

test("handoff/end: no next-actions heading -> nextActions is the concise pointer, never the blob", () => {
  const handoff = "Prose handoff with no explicit next section.";
  const d = decideEndSession({ project: "p", handoff });
  assert.equal(d.kind, "persist");
  assert.equal(d.finalBridge, handoff);
  assert.equal(d.nextActions, HANDOFF_NEXT_ACTIONS_FALLBACK);
  assert.notEqual(d.nextActions, d.finalBridge);        // no duplicate persistence
});

test("handoff/end: blank/whitespace handoff with no legacy content -> reject", () => {
  const d = decideEndSession({ project: "p", handoff: "   " });
  assert.equal(d.kind, "reject");
  assert.equal(d.code, "ZEOS_MISSING_REQUIRED");
});

test("handoff/end: handoff wins over legacy content; first-class scalars still apply", () => {
  const handoff = "Full handoff blob.";
  const d = decideEndSession({
    project: "p", handoff,
    summary: "LEGACY-SUMMARY", delta: "LEGACY-DELTA", nextActions: "LEGACY-NA",
    title: "T", importance: 5, tags: ["alpha"],
  });
  assert.equal(d.kind, "persist");
  assert.equal(d.finalBridge, handoff);
  assert.ok(!d.summary.includes("LEGACY-SUMMARY"));
  assert.ok(!d.finalBridge.includes("LEGACY-DELTA"));
  assert.ok(!d.nextActions.includes("LEGACY-NA"));
  assert.equal(d.title, "T");
  assert.equal(d.importance, 5);
  assert.ok(d.tags.includes("alpha"));
});

test("handoff/end: legacy-only call (no handoff) is unchanged", () => {
  const d = decideEndSession({ project: "p", summary: "s", nextActions: "n", delta: "bridge notes" });
  assert.equal(d.kind, "persist");
  assert.equal(d.summary, "s");
  assert.equal(d.nextActions, "n");
  assert.ok(d.finalBridge.includes("bridge notes"));
  assert.equal(d.recovered, false);
});

test("handoff/end: leaked <handoff> envelope recovers (requires handoff in allowlist)", () => {
  const d = decideEndSession({ project: "p", handoff: "work <handoff>done</handoff> more" });
  assert.equal(d.kind, "persist");
  assert.equal(d.recovered, true);
  assert.ok(d.sanitizedFields.includes("handoff"));
  assert.ok(d.finalBridge.includes("work"));
  assert.ok(d.finalBridge.includes("done"));
  assert.ok(!d.finalBridge.includes("<handoff>"));
  assert.ok(!d.finalBridge.includes("</handoff>"));
  assert.equal(d.tags[0], "recovered");
  assert.ok(d.importance <= 2);
});

test("handoff/snap: bridge is the whole blob; handoff wins; note still applies", () => {
  const handoff = "Snapshot prose.";
  const d = decideSnap({ project: "p", handoff, delta: "LEGACY-DELTA", note: "n" });
  assert.equal(d.kind, "persist");
  assert.equal(d.bridge, handoff);
  assert.ok(!d.bridge.includes("LEGACY-DELTA"));
  assert.equal(d.note, "n");
  assert.equal(d.recovered, false);
});

test("handoff/snap: blank handoff with no legacy content -> reject", () => {
  const d = decideSnap({ project: "p", handoff: "  " });
  assert.equal(d.kind, "reject");
});

test("handoff/snap: leaked <handoff> envelope recovers", () => {
  const d = decideSnap({ project: "p", handoff: "note <handoff>x</handoff>" });
  assert.equal(d.kind, "persist");
  assert.equal(d.recovered, true);
  assert.ok(d.sanitizedFields.includes("handoff"));
  assert.ok(!d.bridge.includes("</handoff>"));
  assert.equal(d.tags[0], "recovered");
});

test("deriveNextActions: extracts the section under a next-actions heading (not the whole blob)", () => {
  const blob = "Summary line.\n## Next Actions\n- do A\n- do B";
  const out = deriveNextActions(blob);
  assert.match(out, /do A/);
  assert.match(out, /do B/);
  assert.notEqual(out, blob);
  assert.ok(!out.includes("Summary line"));
});

test("deriveNextActions: no heading -> concise pointer, never the blob", () => {
  const blob = "Just prose, no heading.";
  assert.equal(deriveNextActions(blob), HANDOFF_NEXT_ACTIONS_FALLBACK);
  assert.notEqual(deriveNextActions(blob), blob);
});

test("handoff redaction: derived fields route through redactSensitiveText (routing + unit pin)", () => {
  const secret = "token=AAAAAAAAAAAAAAAAAAAAAAAA"; // zero-entropy fixture matching ENV_SECRET
  const d = decideEndSession({ project: "p", handoff: `context\n## Next Actions\n${secret}` });
  assert.equal(d.kind, "persist");
  assert.ok(d.finalBridge.includes(secret));   // decision does NOT redact; the handler does
  const r = redactSensitiveText(secret);        // direct unit pin on the handler's redactor
  assert.ok(r.count > 0);
  assert.ok(!r.text.includes("AAAAAAAAAAAAAAAAAAAAAAAA"));
});

test("hint/end: missing-required reject leads with the preferred { project, handoff } shape", () => {
  const d = decideEndSession({});
  assert.equal(d.kind, "reject");
  const env = JSON.parse(d.envelope);
  assert.match(env.hint, /project, handoff/);
  assert.match(env.hint, /[Pp]referred/);
  assert.ok(Object.prototype.hasOwnProperty.call(env.expected_shape, "handoff"));
});

test("hint/snap: missing-required reject leads with the preferred { project, handoff } shape", () => {
  const d = decideSnap({});
  assert.equal(d.kind, "reject");
  const env = JSON.parse(d.envelope);
  assert.match(env.hint, /project, handoff/);
  assert.match(env.hint, /[Pp]referred/);
  assert.ok(Object.prototype.hasOwnProperty.call(env.expected_shape, "handoff"));
});
