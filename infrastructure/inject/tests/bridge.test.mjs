import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBridgeContent,
  normalizeTags,
  normalizeStringList,
  clampImportance,
  stripListMarker,
  firstContentLine,
  titleFromSummary,
  formatListSection,
} from "../dist/lib/bridge.js";

test("buildBridgeContent: renders only populated sections in order", () => {
  const content = buildBridgeContent({
    objective: "Test the bridge",
    openThreads: ["thread A", "thread B"],
    verified: ["item 1"],
    delta: "All good",
  });
  const objIdx = content.indexOf("### Objective");
  const threadsIdx = content.indexOf("### Open Threads");
  const verifiedIdx = content.indexOf("### Verified");
  const deltaIdx = content.indexOf("### Delta");
  assert(objIdx >= 0 && threadsIdx > objIdx && verifiedIdx > threadsIdx && deltaIdx > verifiedIdx);
  assert(!content.includes("### State of the World"));
});

test("buildBridgeContent: empty input returns empty string", () => {
  assert.equal(buildBridgeContent({}), "");
});

test("buildBridgeContent: openThreads renders as checkboxes", () => {
  const content = buildBridgeContent({ openThreads: ["pending one"] });
  assert.match(content, /- \[ \] pending one/);
});

test("normalizeTags: lowercase, kebab, dedupe, cap 12", () => {
  const input = ["Tag Alpha", "tag-alpha", "Bravo Two", " ", "tag-3", "tag-4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12", "t13"];
  const result = normalizeTags(input);
  assert.equal(result.length, 12);
  assert(result.includes("tag-alpha"));
  assert(result.includes("bravo-two"));
});

test("normalizeStringList: handles array, newlines, commas", () => {
  assert.deepEqual(normalizeStringList(["a", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeStringList("- one\n- two\n,three"), ["one", "two", "three"]);
});

test("clampImportance: clamps 1-5, defaults non-numbers to 3", () => {
  assert.equal(clampImportance(0), 1);
  assert.equal(clampImportance(10), 5);
  assert.equal(clampImportance(3), 3);
  assert.equal(clampImportance("not a number"), 3);
  assert.equal(clampImportance(undefined), 3);
  assert.equal(clampImportance(2.7), 3);
});

test("stripListMarker: removes leading markers", () => {
  assert.equal(stripListMarker("- [ ] task"), "task");
  assert.equal(stripListMarker("- item"), "item");
  assert.equal(stripListMarker("* item"), "item");
  assert.equal(stripListMarker("1. item"), "item");
  assert.equal(stripListMarker("plain text"), "plain text");
});

test("firstContentLine: skips empty and heading lines", () => {
  assert.equal(firstContentLine("\n\n# Heading\n\nreal content\n\nmore"), "real content");
  assert.equal(firstContentLine(""), "Session continuity update");
});

test("titleFromSummary: caps at 150 chars, strips markers", () => {
  const long = "- " + "a".repeat(200);
  const title = titleFromSummary(long);
  assert(title.length <= 150);
  assert(!title.startsWith("-"));
});

test("formatListSection: renders bullets, optional checkbox", () => {
  assert.equal(formatListSection(["a", "b"]), "- a\n- b");
  assert.equal(formatListSection(["a"], true), "- [ ] a");
  assert.equal(formatListSection([]), "");
});
