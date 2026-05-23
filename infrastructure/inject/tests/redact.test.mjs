import test from "node:test";
import assert from "node:assert/strict";
import {
  redactSensitiveText,
  mergeRedactions,
  formatRedactionNotice,
  SECRET_PATTERNS,
} from "../dist/lib/redact.js";

// Runtime construction of dummy token-shaped strings keeps this file free of
// static token-shaped literals that secret scanners flag in source.
function joinParts(...parts) {
  return parts.join("");
}

test("redact ENV_SECRET: api_key assignment redacts the value, preserves the key", () => {
  const value = joinParts("a", "b", "c").padEnd(30, "x");
  const { text, count, labels } = redactSensitiveText(`api_key="${value}"`);
  assert.equal(count, 1);
  assert.deepEqual(labels, ["ENV_SECRET"]);
  assert.match(text, /api_key="\[REDACTED:ENV_SECRET\]"/);
});

test("redact ENV_SECRET: token=value (no quotes) is redacted", () => {
  const value = joinParts("p", "q", "r").padEnd(24, "z");
  const { text, count, labels } = redactSensitiveText(`token=${value}`);
  assert.equal(count, 1);
  assert.deepEqual(labels, ["ENV_SECRET"]);
  assert.match(text, /token=\[REDACTED:ENV_SECRET\]/);
});

test("redact ENV_SECRET: password and access_key variants match", () => {
  const passwordValue = "p".padEnd(22, "w");
  const accessValue = "k".padEnd(22, "n");
  const { count, labels } = redactSensitiveText(
    `password: "${passwordValue}"\naccess_key="${accessValue}"`
  );
  assert.equal(count, 2);
  assert.deepEqual(labels, ["ENV_SECRET"]);
});

test("redact ENV_SECRET: short values do NOT match (length floor)", () => {
  const { count } = redactSensitiveText('api_key="too-short"');
  assert.equal(count, 0);
});

test("redact BEARER: Bearer plus 16+ char opaque token is redacted", () => {
  const opaque = "o".padEnd(40, "p");
  const { text, count, labels } = redactSensitiveText(`Authorization: Bearer ${opaque}`);
  assert.equal(count, 1);
  assert.deepEqual(labels, ["BEARER_TOKEN"]);
  assert.match(text, /Authorization: Bearer \[REDACTED:BEARER\]/);
});

test("redact BEARER: short Bearer prose does NOT match", () => {
  const { count } = redactSensitiveText("Bearer of bad news");
  assert.equal(count, 0);
});

test("redact PRIVATE_KEY: PEM block is redacted", () => {
  const pem = [
    joinParts("-----BEGIN ", "PRIVATE KEY-----"),
    "ABC",
    joinParts("-----END ", "PRIVATE KEY-----"),
  ].join("\n");
  const { text, count, labels } = redactSensitiveText(pem);
  assert.equal(count, 1);
  assert.deepEqual(labels, ["PRIVATE_KEY"]);
  assert.match(text, /\[REDACTED:PRIVATE_KEY\]/);
});

test("redact: ignores normal prose with no secrets", () => {
  const { count } = redactSensitiveText("This is normal prose. The token endpoint returns 200.");
  assert.equal(count, 0);
});

test("redact: ignores short commit-SHA-like strings", () => {
  const { count } = redactSensitiveText("Commit 9853447 fixed the issue. See sha be041c1.");
  assert.equal(count, 0);
});

test("redact: idempotent on already-redacted text", () => {
  const value = joinParts("a", "b").padEnd(28, "y");
  const once = redactSensitiveText(`api_key="${value}"`);
  assert(once.count >= 1, "first pass redacts");
  const twice = redactSensitiveText(once.text);
  assert.equal(twice.count, 0, "second pass on already-redacted output must not re-redact");
});

test("redact: idempotent on redaction-marker-shaped prose", () => {
  const input = `Previous redaction: [REDACTED:ENV_SECRET] still here.`;
  const result = redactSensitiveText(input);
  assert.equal(result.count, 0, "must not re-redact the marker itself");
});

test("mergeRedactions: sums counts, dedupes labels, sorts", () => {
  const a = { text: "ignored", count: 2, labels: ["ENV_SECRET", "BEARER_TOKEN"] };
  const b = { text: "ignored", count: 3, labels: ["BEARER_TOKEN", "PRIVATE_KEY"] };
  const merged = mergeRedactions(a, b);
  assert.equal(merged.count, 5);
  assert.deepEqual(merged.labels, ["BEARER_TOKEN", "ENV_SECRET", "PRIVATE_KEY"]);
});

test("formatRedactionNotice: empty for zero count", () => {
  assert.equal(formatRedactionNotice({ text: "", count: 0, labels: [] }), "");
});

test("formatRedactionNotice: renders count and labels", () => {
  const notice = formatRedactionNotice({ text: "", count: 2, labels: ["ENV_SECRET", "BEARER_TOKEN"] });
  assert.match(notice, /2 sensitive value\(s\) redacted/);
  assert.match(notice, /ENV_SECRET/);
  assert.match(notice, /BEARER_TOKEN/);
});

test("SECRET_PATTERNS: includes the three generic labels and nothing else", () => {
  const labels = SECRET_PATTERNS.map(p => p.label).sort();
  assert.deepEqual(labels, ["BEARER_TOKEN", "ENV_SECRET", "PRIVATE_KEY"]);
});
