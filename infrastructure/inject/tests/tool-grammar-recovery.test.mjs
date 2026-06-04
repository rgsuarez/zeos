import test from "node:test";
import assert from "node:assert/strict";
import {
  stripToolGrammarTags,
  sanitizeArgsToolGrammar,
  shouldRecover,
  formatRecoveryNotice,
  reconstructedPlaceholder,
  RECONSTRUCTED_PLACEHOLDER_PREFIX,
  detectToolGrammarLeak,
  clampImportance,
} from "../dist/lib/bridge.js";

// =============================================================================
// stripToolGrammarTags: lossless tag-token removal
// Invariant: only allowlisted tool-grammar tag tokens are removed; every other
// byte (prose, non-allowlisted angle content, whitespace) is preserved.
// =============================================================================

test("strip: lone leading </summary> removed, surrounding text intact", () => {
  const r = stripToolGrammarTags("real summary text</summary>more text");
  assert.equal(r.text, "real summary textmore text");
  assert.ok(r.removed >= 1);
});

test("strip: trailing </invoke> removed, prose intact", () => {
  const r = stripToolGrammarTags("the handoff prose\n</invoke>");
  assert.equal(r.text, "the handoff prose\n");
});

test("strip: balanced <objective>..</objective> removed, inner text kept", () => {
  const r = stripToolGrammarTags("<objective>ship the fix</objective>");
  assert.equal(r.text, "ship the fix");
  assert.equal(r.removed, 2);
});

test("strip: unclosed head <summary removes only the token, keeps following prose", () => {
  const r = stripToolGrammarTags("<summary the rest is prose with no close");
  assert.equal(r.text, " the rest is prose with no close");
  assert.equal(r.removed, 1);
});

test("strip: unknown tag <oldbase> is NOT removed (tag and content preserved)", () => {
  const r = stripToolGrammarTags("keep <oldbase>content here");
  assert.equal(r.text, "keep <oldbase>content here");
  assert.equal(r.removed, 0);
});

test("strip: non-allowlisted angle content is untouched", () => {
  for (const s of [
    "git push origin <branch>",
    '<a href="x">link</a>',
    "compare a < b and x -> y",
    "deploy <pending>",
    "<custom>not in allowlist</custom>",
  ]) {
    assert.equal(stripToolGrammarTags(s).text, s, `should be unchanged: ${s}`);
    assert.equal(stripToolGrammarTags(s).removed, 0);
  }
});

test("strip: open tag with attributes is removed wholesale", () => {
  const r = stripToolGrammarTags('<verified foo="bar">checked</verified>');
  assert.equal(r.text, "checked");
});

test("strip: case-insensitive", () => {
  const r = stripToolGrammarTags("<State>x</STATE>");
  assert.equal(r.text, "x");
});

test("strip: tags inside fenced code ARE stripped (chosen policy), surrounding text kept", () => {
  const r = stripToolGrammarTags("```\n<summary>ex</summary>\n```");
  assert.equal(r.text, "```\nex\n```");
  // and the invariant holds on the result
  assert.equal(detectToolGrammarLeak({ f: r.text }), null);
});

test("strip: no allowlisted tags -> output identical, removed 0", () => {
  const s = "just plain prose with no tool grammar at all";
  const r = stripToolGrammarTags(s);
  assert.equal(r.text, s);
  assert.equal(r.removed, 0);
});

test("strip: empty / no-bracket inputs are safe", () => {
  assert.deepEqual(stripToolGrammarTags(""), { text: "", removed: 0 });
  assert.deepEqual(stripToolGrammarTags("plain"), { text: "plain", removed: 0 });
});

test("strip: idempotent", () => {
  for (const s of [
    "a</summary>b<objective>c</objective>d",
    "<summary unclosed tail",
    "<sum<summary>mary>",
    "</invoke>",
  ]) {
    const once = stripToolGrammarTags(s).text;
    const twice = stripToolGrammarTags(once).text;
    assert.equal(twice, once, `not idempotent for: ${s}`);
  }
});

// =============================================================================
// Core safety invariant: detector cannot fire on sanitized output, including
// interleaved / pathological inputs that a single pass would miss.
// =============================================================================

test("invariant: detectToolGrammarLeak(strip(x)) === null for adversarial inputs", () => {
  const inputs = [
    "real text</summary>\n<objective>x</objective>\n<nextActions>y</nextActions>\n</invoke>",
    "<sum<summary>mary>",
    "<SUMMARY>",
    "<summary/>",
    "< summary>",
    "<summary><summary>",
    "</invoke>",
    "<summary",
    "</summary",
    "</bridge><summary",
    "prose <delta>tail with no close",
    "x</next_tactical_move>\n<parameter name=\"nextActions\">1. y",
  ];
  for (const x of inputs) {
    const cleaned = stripToolGrammarTags(x).text;
    assert.equal(detectToolGrammarLeak({ f: cleaned }), null, `invariant broken for: ${JSON.stringify(x)}`);
  }
});

// =============================================================================
// Linear-time / no-truncation: a multi-MB input with many tags completes and
// loses NO content beyond the tag tokens themselves (no cap, no truncation).
// =============================================================================

test("strip: large input is not truncated and completes without blowup", () => {
  const N = 150000;                       // ~2.25 MB of input
  const input = "PROSE</summary>".repeat(N);
  const start = Date.now();
  const r = stripToolGrammarTags(input);
  const elapsed = Date.now() - start;
  assert.equal(r.text, "PROSE".repeat(N));            // every PROSE byte preserved
  assert.equal(r.text.length, input.length - "</summary>".length * N); // exact, no truncation
  assert.equal(r.removed, N);
  assert.ok(elapsed < 3000, `strip took ${elapsed}ms, expected linear/fast`);
});

// =============================================================================
// shouldRecover: recovery-routing predicate (strings + arrays, open + close)
// =============================================================================

test("shouldRecover: leading </summary> triggers", () => {
  assert.equal(shouldRecover({ summary: "text</summary>more" }).triggered, true);
});

test("shouldRecover: open-only known tags (no close) trigger", () => {
  assert.equal(shouldRecover({ summary: "prose <delta>stuff" }).triggered, true);
  assert.equal(shouldRecover({ summary: "prose <objective>goal here" }).triggered, true);
  assert.equal(shouldRecover({ summary: "prose <delta with no closing bracket" }).triggered, true);
});

test("shouldRecover: tag inside an array element triggers and names the field", () => {
  const r = shouldRecover({ open_threads: ["normal entry", "x</verified>y", "another"] });
  assert.equal(r.triggered, true);
  assert.ok(r.fields.includes("open_threads"));
});

test("shouldRecover: clean payload does NOT trigger", () => {
  const r = shouldRecover({
    summary: "Shipped the fix. See deploy <pending>.",
    note: '<a href="x">docs</a>',
    delta: "<custom>fine</custom>",
    open_threads: ["one", "two"],
  });
  assert.equal(r.triggered, false);
  assert.deepEqual(r.fields, []);
});

test("shouldRecover: empty / undefined args do NOT trigger", () => {
  assert.equal(shouldRecover({}).triggered, false);
  assert.equal(shouldRecover(undefined).triggered, false);
});

// =============================================================================
// sanitizeArgsToolGrammar: applies strip across string fields + array elements
// =============================================================================

test("sanitizeArgsToolGrammar: strips strings and array elements, lists changed fields", () => {
  const { args, fields } = sanitizeArgsToolGrammar({
    project: "ops-tech",
    summary: "done</summary><nextActions>next</nextActions>",
    open_threads: ["clean", "leak</verified>here"],
    importance: 4,
  });
  assert.equal(args.project, "ops-tech");
  assert.equal(args.summary.includes("</summary>"), false);
  assert.equal(args.summary.includes("nextActions>"), false);
  assert.equal(args.open_threads[0], "clean");
  assert.equal(args.open_threads[1], "leakhere");
  assert.equal(args.importance, 4); // non-string passes through
  assert.ok(fields.includes("summary"));
  assert.ok(fields.includes("open_threads"));
  assert.equal(fields.includes("project"), false);
});

test("sanitizeArgsToolGrammar: clean args produce no changed fields", () => {
  const { fields } = sanitizeArgsToolGrammar({ project: "p", summary: "plain", tags: ["a", "b"] });
  assert.deepEqual(fields, []);
});

test("sanitizeArgsToolGrammar: recurses into nested arrays (no leaked tag survives)", () => {
  const { args, fields } = sanitizeArgsToolGrammar({
    open_threads: [["clean", "leak</summary>here"], "top"],
  });
  assert.equal(args.open_threads[0][1], "leakhere");
  assert.equal(args.open_threads[0][0], "clean");
  assert.equal(args.open_threads[1], "top");
  assert.ok(fields.includes("open_threads"));
});

// =============================================================================
// formatRecoveryNotice + reconstructedPlaceholder
// =============================================================================

test("formatRecoveryNotice: names sanitized and missing fields; empty -> empty", () => {
  const notice = formatRecoveryNotice(["summary", "open_threads"], ["nextActions"]);
  assert.ok(notice.includes("Recovered Handoff"));
  assert.ok(notice.includes("summary"));
  assert.ok(notice.includes("open_threads"));
  assert.ok(notice.includes("nextActions"));
  assert.equal(formatRecoveryNotice([], []), "");
});

test("reconstructedPlaceholder: begins with the machine-distinguishable prefix", () => {
  const p = reconstructedPlaceholder("nextActions");
  assert.ok(p.startsWith(RECONSTRUCTED_PLACEHOLDER_PREFIX));
  assert.ok(p.includes("nextActions"));
});

test("clampImportance: non-integer coerces to default (importance path stays safe)", () => {
  assert.equal(clampImportance("banana"), 3);
});

// ---- Phase 2: handoff is a recovery token ----

test("handoff: strip trailing </handoff> removed, prose intact", () => {
  const r = stripToolGrammarTags("done</handoff>");
  assert.equal(r.text, "done");
  assert.ok(r.removed >= 1);
});

test("handoff: balanced <handoff>..</handoff> removed, inner text kept", () => {
  const r = stripToolGrammarTags("<handoff>x</handoff>");
  assert.equal(r.text, "x");
  assert.ok(r.removed >= 2);
});

test("handoff: shouldRecover triggers on a leaked handoff tag and names the field", () => {
  const { triggered, fields } = shouldRecover({ handoff: "x</handoff>" });
  assert.equal(triggered, true);
  assert.ok(fields.includes("handoff"));
});

test("handoff: a similar non-allowlisted tag <handoffx> is NOT stripped (invariant preserved)", () => {
  const r = stripToolGrammarTags("keep <handoffx>y</handoffx> intact");
  assert.equal(r.removed, 0);
  assert.equal(r.text, "keep <handoffx>y</handoffx> intact");
});
