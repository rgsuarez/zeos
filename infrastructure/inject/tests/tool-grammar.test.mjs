import test from "node:test";
import assert from "node:assert/strict";
import {
  detectToolGrammarLeak,
  buildErrorEnvelope,
  buildToolGrammarLeakResponse,
} from "../dist/lib/bridge.js";

// =============================================================================
// detectToolGrammarLeak: string fields
// Invariant: only known tool-grammar tokens trigger; arbitrary inline angle
// content passes through. Field name reported when a leak is found.
// =============================================================================

test("detectToolGrammarLeak: null for plain-string inputs across expected handler fields", () => {
  const result = detectToolGrammarLeak({
    project: "ops-tech",
    delta: "Plain bridge content.",
    summary: "Session summary in prose.",
    nextActions: "Run X then Y.",
    objective: "Ship the cron job.",
    state: "On feature branch, tests green.",
    next_tactical_move: "Open the PR.",
    note: "Just a note.",
    title: "Session title",
  });
  assert.equal(result, null);
});

test("detectToolGrammarLeak: opening tag at start of delta", () => {
  const result = detectToolGrammarLeak({ delta: "<summary>foo</summary>" });
  assert.ok(result);
  assert.equal(result.field, "delta");
  assert.equal(result.pattern_index, 0);
  assert.ok(result.sample.startsWith("<summary>"));
});

test("detectToolGrammarLeak: close-tag leakage (</invoke>) anywhere in summary", () => {
  const result = detectToolGrammarLeak({
    summary: "Plain prose with a tail.\n</invoke>\n)",
  });
  assert.ok(result);
  assert.equal(result.field, "summary");
  assert.equal(result.pattern_index, 1);
});

test("detectToolGrammarLeak: opening <delta> at start of any field", () => {
  const result = detectToolGrammarLeak({ note: "<delta>x</delta>" });
  assert.ok(result);
  assert.equal(result.field, "note");
  assert.equal(result.pattern_index, 0);
});

test("detectToolGrammarLeak: opening <bridge> at start", () => {
  const result = detectToolGrammarLeak({ state: "<bridge>any content</bridge>" });
  assert.ok(result);
  assert.equal(result.field, "state");
});

test("detectToolGrammarLeak: truncates sample to 80 chars", () => {
  const long = "<summary>" + "x".repeat(500) + "</summary>";
  const result = detectToolGrammarLeak({ delta: long });
  assert.ok(result);
  assert.ok(result.sample.length <= 80);
});

// =============================================================================
// detectToolGrammarLeak: array fields
// Invariant: arrays of strings are scanned element by element; the offending
// field name is reported as "<key>[<index>]".
// =============================================================================

test("detectToolGrammarLeak: leak inside an array element reports field with index", () => {
  const result = detectToolGrammarLeak({
    open_threads: ["normal entry", "<delta>x</delta>", "another normal"],
  });
  assert.ok(result);
  assert.equal(result.field, "open_threads[1]");
  assert.equal(result.pattern_index, 0);
});

test("detectToolGrammarLeak: null when array contains only plain strings", () => {
  const result = detectToolGrammarLeak({
    open_threads: ["one", "two", "three"],
    verified: ["check A", "check B"],
    assumed: ["premise X"],
  });
  assert.equal(result, null);
});

test("detectToolGrammarLeak: skips non-string array elements without throwing", () => {
  const result = detectToolGrammarLeak({
    open_threads: ["normal", 42, null, true, "<summary>leak</summary>"],
  });
  assert.ok(result);
  assert.equal(result.field, "open_threads[4]");
});

// =============================================================================
// detectToolGrammarLeak: allowlist enforcement (negative cases per redline 4)
// Invariant: only the named tool-grammar tokens (summary, delta, nextActions,
// next_tactical_move, bridge, invoke) trigger. Everything else passes through.
// =============================================================================

test("detectToolGrammarLeak: does NOT flag inline angle content like 'deploy <pending>'", () => {
  const result = detectToolGrammarLeak({
    state: "deploy <pending>",
    objective: "Ship <something> by Friday",
  });
  assert.equal(result, null);
});

test("detectToolGrammarLeak: does NOT flag legitimate HTML anchor tags", () => {
  const result = detectToolGrammarLeak({
    note: "<a href='x'>see docs</a>",
  });
  assert.equal(result, null);
});

test("detectToolGrammarLeak: does NOT flag unrelated tag envelopes outside the allowlist", () => {
  const result = detectToolGrammarLeak({
    delta: "<custom>this is not in the allowlist</custom>",
    summary: "<other>still passes</other>",
  });
  assert.equal(result, null);
});

// =============================================================================
// detectToolGrammarLeak: edge cases
// Invariant: degrades gracefully on missing/empty/non-string inputs.
// =============================================================================

test("detectToolGrammarLeak: null for undefined args", () => {
  assert.equal(detectToolGrammarLeak(undefined), null);
});

test("detectToolGrammarLeak: null for empty args object", () => {
  assert.equal(detectToolGrammarLeak({}), null);
});

test("detectToolGrammarLeak: null for empty string and empty array values", () => {
  const result = detectToolGrammarLeak({
    project: "",
    delta: "",
    open_threads: [],
    tags: [],
  });
  assert.equal(result, null);
});

test("detectToolGrammarLeak: ignores null and undefined field values", () => {
  const result = detectToolGrammarLeak({
    project: null,
    delta: undefined,
    tags: ["a", "b"],
  });
  assert.equal(result, null);
});

// =============================================================================
// buildErrorEnvelope
// Invariant: returns valid JSON; required keys always present; optional keys
// only appear when supplied; structure round-trips through JSON.parse.
// =============================================================================

test("buildErrorEnvelope: JSON-parseable with required keys", () => {
  const out = buildErrorEnvelope({
    error_code: "TEST_CODE",
    error: "test message",
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.error_code, "TEST_CODE");
  assert.equal(parsed.error, "test message");
});

test("buildErrorEnvelope: propagates optional keys when supplied", () => {
  const out = buildErrorEnvelope({
    error_code: "TEST",
    error: "msg",
    hint: "do X",
    offending_field: "delta",
    offending_sample: "<x>",
    missing_fields: ["foo", "bar"],
    expected_shape: { foo: "string", bar: "number" },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hint, "do X");
  assert.equal(parsed.offending_field, "delta");
  assert.equal(parsed.offending_sample, "<x>");
  assert.deepEqual(parsed.missing_fields, ["foo", "bar"]);
  assert.deepEqual(parsed.expected_shape, { foo: "string", bar: "number" });
});

test("buildErrorEnvelope: omits unset optional keys from the JSON output", () => {
  const out = buildErrorEnvelope({
    error_code: "MIN",
    error: "minimal",
  });
  const parsed = JSON.parse(out);
  assert.equal("hint" in parsed, false);
  assert.equal("offending_field" in parsed, false);
  assert.equal("missing_fields" in parsed, false);
});

// =============================================================================
// buildToolGrammarLeakResponse
// Invariant: error_code is the fleet-groupable "ZEOS_TOOL_GRAMMAR_LEAK";
// leak.field and leak.sample propagate to offending_field / offending_sample;
// expected_shape is included so the agent has the contract in the rejection.
// =============================================================================

test("buildToolGrammarLeakResponse: error_code is ZEOS_TOOL_GRAMMAR_LEAK", () => {
  const out = buildToolGrammarLeakResponse({
    field: "delta",
    sample: "<summary>x</summary>",
    pattern_index: 0,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.error_code, "ZEOS_TOOL_GRAMMAR_LEAK");
});

test("buildToolGrammarLeakResponse: propagates leak.field and leak.sample", () => {
  const out = buildToolGrammarLeakResponse({
    field: "open_threads[2]",
    sample: "<delta>tail</delta>",
    pattern_index: 1,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.offending_field, "open_threads[2]");
  assert.equal(parsed.offending_sample, "<delta>tail</delta>");
});

test("buildToolGrammarLeakResponse: includes hint and expected_shape", () => {
  const out = buildToolGrammarLeakResponse({
    field: "summary",
    sample: "<nextActions>",
    pattern_index: 0,
  });
  const parsed = JSON.parse(out);
  assert.ok(parsed.hint && parsed.hint.length > 0);
  assert.ok(parsed.expected_shape && typeof parsed.expected_shape === "object");
  assert.equal(parsed.expected_shape.project, "string (required)");
});
