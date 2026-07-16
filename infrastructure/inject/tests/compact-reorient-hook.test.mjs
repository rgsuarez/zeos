// Never-block and contract tests for infrastructure/inject/bin/compact-reorient-hook.sh
// The hook must exit 0 on every path, inject the fixed re-orientation text in
// SessionStartCompact mode, and best-effort log (never block) in PostCompact mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, symlinkSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "compact-reorient-hook.sh");

function run(mode, stdin, env = {}) {
  return spawnSync("bash", [HOOK, ...(mode === null ? [] : [mode])], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
}

const VALID_POST = JSON.stringify({
  session_id: "11111111-2222-3333-4444-555555555555",
  transcript_path: "/tmp/x.jsonl",
  cwd: "/tmp",
  hook_event_name: "PostCompact",
  trigger: "auto",
  compact_summary: "a".repeat(1234),
});

test("SessionStartCompact injects the re-orientation text and exits 0", () => {
  const r = run("SessionStartCompact", JSON.stringify({ source: "compact" }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /replaced by a compaction summary/);
  assert.match(r.stdout, /Treat values that exist only in the summary as unverified/);
  assert.match(r.stdout, /handing off at the next clean state boundary/);
});

test("SessionStartCompact never blocks on garbage, empty, or absent stdin", () => {
  for (const stdin of ["{not json", "", undefined]) {
    const r = run("SessionStartCompact", stdin);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /replaced by a compaction summary/);
  }
});

test("PostCompact logs one metadata line (no summary content) and exits 0", () => {
  const root = mkdtempSync(join(tmpdir(), "zeos-compact-hook-"));
  const r = run("PostCompact", VALID_POST, { ZEOS_STATE_ROOT: root });
  assert.equal(r.status, 0);
  const log = join(root, "logs", "compact-events.log");
  assert.ok(existsSync(log), "log file created");
  const line = readFileSync(log, "utf8").trim();
  assert.match(line, /compact session=11111111-2222-3333-4444-555555555555 trigger=auto cwd=\/tmp summary_bytes=1234/);
  assert.ok(!line.includes("aaaa"), "summary content never logged");
});

test("PostCompact exits 0 and logs parse-skip on garbage payload", () => {
  const root = mkdtempSync(join(tmpdir(), "zeos-compact-hook-"));
  const r = run("PostCompact", "{definitely not json", { ZEOS_STATE_ROOT: root });
  assert.equal(r.status, 0);
  const line = readFileSync(join(root, "logs", "compact-events.log"), "utf8");
  assert.match(line, /parse-skip/);
});

test("PostCompact refuses a symlink log target and still exits 0", () => {
  const root = mkdtempSync(join(tmpdir(), "zeos-compact-hook-"));
  mkdirSync(join(root, "logs"), { recursive: true });
  const sentinel = join(root, "sentinel.txt");
  writeFileSync(sentinel, "SENTINEL-UNTOUCHED");
  symlinkSync(sentinel, join(root, "logs", "compact-events.log"));
  const r = run("PostCompact", VALID_POST, { ZEOS_STATE_ROOT: root });
  assert.equal(r.status, 0);
  assert.equal(readFileSync(sentinel, "utf8"), "SENTINEL-UNTOUCHED", "nothing written through the symlink");
});

test("PostCompact refuses a FIFO log target without hanging and exits 0", () => {
  const root = mkdtempSync(join(tmpdir(), "zeos-compact-hook-"));
  mkdirSync(join(root, "logs"), { recursive: true });
  execFileSync("mkfifo", [join(root, "logs", "compact-events.log")]);
  const r = run("PostCompact", VALID_POST, { ZEOS_STATE_ROOT: root });
  assert.equal(r.status, 0, "exited 0 without opening the FIFO (a blind open would hang past the spawn timeout)");
});

test("PostCompact exits 0 with an unwritable state root", () => {
  const base = mkdtempSync(join(tmpdir(), "zeos-compact-hook-"));
  const ro = join(base, "readonly");
  mkdirSync(ro);
  chmodSync(ro, 0o555);
  const r = run("PostCompact", VALID_POST, { ZEOS_STATE_ROOT: join(ro, "zeos") });
  assert.equal(r.status, 0);
  chmodSync(ro, 0o755);
  assert.ok(!existsSync(join(ro, "zeos", "logs", "compact-events.log")), "no log created under the read-only root");
});

test("PostCompact strips control characters: one event can never forge extra log lines", () => {
  const root = mkdtempSync(join(tmpdir(), "zeos-compact-hook-"));
  const hostile = JSON.stringify({
    session_id: "abc\nFORGED line-two session=evil",
    trigger: "auto",
    cwd: "/tmp/x\r\ny",
    hook_event_name: "PostCompact",
    compact_summary: "s",
  });
  const r = run("PostCompact", hostile, { ZEOS_STATE_ROOT: root });
  assert.equal(r.status, 0);
  const lines = readFileSync(join(root, "logs", "compact-events.log"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "exactly one log line");
  assert.ok(!lines[0].includes("FORGED line-two") || lines[0].includes("abcFORGED"), "newline neutralized");
});

test("PostCompact logs summary_bytes as UTF-8 bytes, not code points", () => {
  const root = mkdtempSync(join(tmpdir(), "zeos-compact-hook-"));
  const payload = JSON.stringify({
    session_id: "sid", trigger: "manual", cwd: "/tmp",
    hook_event_name: "PostCompact", compact_summary: "é",
  });
  const r = run("PostCompact", payload, { ZEOS_STATE_ROOT: root });
  assert.equal(r.status, 0);
  assert.match(readFileSync(join(root, "logs", "compact-events.log"), "utf8"), /summary_bytes=2/);
});

test("unknown or missing mode consumes stdin and exits 0 silently", () => {
  for (const mode of ["Bogus", null]) {
    const r = run(mode, VALID_POST);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
});
