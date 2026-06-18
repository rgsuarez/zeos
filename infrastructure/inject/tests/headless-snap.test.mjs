import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  parseSnapArgs,
  buildAutoCheckpointEntry,
  runHeadlessSnap,
} from "../dist/lib/headless-snap.js";
import { writeSessionPointer, resolvePointerDir } from "../dist/lib/session-pointer.js";
import { redactSensitiveText, formatRedactionNotice } from "../dist/lib/redact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.join(__dirname, "..", "dist", "index.js");

// Run the built binary as a one-shot CLI (as the PreCompact hook does) and
// return its captured stderr + exit code. Strip the host's real
// CLAUDE_CODE_SESSION_ID so only the explicit --session controls resolution,
// and scope ZEOS_STATE_ROOT to the temp state dir.
function runSnapCli(args, stateRoot) {
  const env = { ...process.env, ZEOS_STATE_ROOT: stateRoot };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    env,
    encoding: "utf-8",
    timeout: 15_000,
  });
  return r;
}

// Build a token-shaped string at runtime so this source file holds no static
// secret-shaped literal (same technique as redact.test.mjs).
function fakeToken() {
  return ["a", "b", "c"].join("").padEnd(40, "x");
}

function withTempState(fn) {
  const prev = process.env.ZEOS_STATE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeos-headless-test-"));
  process.env.ZEOS_STATE_ROOT = root;
  try {
    return fn(root);
  } finally {
    if (prev === undefined) delete process.env.ZEOS_STATE_ROOT;
    else process.env.ZEOS_STATE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function seedJournal(root, name = "2026-06-18-001-claude.md") {
  const dir = path.join(root, "journals", "demo-app");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "---\nstatus: active\n---\n\n# Session Journal: 2026-06-18-001\n\nReal work body.\n");
  return p;
}

const SID = "1c40c7e5-8d6f-4326-9218-fc65548b5cb3";

// ---- arg parsing ----

test("parseSnapArgs: reads --session and --handoff; env fills an unset session", () => {
  const a = parseSnapArgs(["--session", SID, "--handoff", "checkpoint text"], {});
  assert.equal(a.sessionId, SID);
  assert.equal(a.handoff, "checkpoint text");

  const b = parseSnapArgs(["--handoff", "x"], { CLAUDE_CODE_SESSION_ID: SID });
  assert.equal(b.sessionId, SID, "env fallback fills session when flag absent");

  const c = parseSnapArgs(["--session", SID], { CLAUDE_CODE_SESSION_ID: "other" });
  assert.equal(c.sessionId, SID, "flag wins over env");

  const d = parseSnapArgs(["--unknown", "v", "--handoff", "h"], {});
  assert.equal(d.handoff, "h", "unknown flags ignored, not fatal");
  assert.equal(d.sessionId, null);
});

test("buildAutoCheckpointEntry: carries the auto-capture marker and bridge body", () => {
  const entry = buildAutoCheckpointEntry({
    timestamp: "2026-06-18T12:00:00.000Z",
    redactedHandoff: { text: "[AUTO] PreCompact checkpoint 2026-06-18T12:00:00.000Z" },
    redactionNotice: "",
  });
  assert.match(entry, /## Checkpoint: 2026-06-18T12:00:00\.000Z/);
  assert.match(entry, /\*\*Auto-capture:\*\* PreCompact/);
  assert.match(entry, /\[AUTO\] PreCompact checkpoint/);
  assert.match(entry, /\n---\n$/);
});

// ---- runHeadlessSnap: the three-case floor ----

test("runHeadlessSnap: writes a checkpoint to the resolved pointer's journal", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: journal });

    const before = fs.readFileSync(journal, "utf-8");
    const res = runHeadlessSnap(["--session", SID, "--handoff", "[AUTO] PreCompact checkpoint"], {});
    assert.equal(res.status, "written");
    assert.equal(res.journalPath, journal);

    const after = fs.readFileSync(journal, "utf-8");
    assert.ok(after.startsWith(before), "append-only: prior content preserved");
    assert.match(after, /## Checkpoint:/);
    assert.match(after, /\*\*Auto-capture:\*\* PreCompact/);
    assert.match(after, /\[AUTO\] PreCompact checkpoint/);
  });
});

test("runHeadlessSnap: NO-OPS when no pointer resolves (non-zeos session); writes nothing", () => {
  withTempState((root) => {
    // No pointer written for SID.
    const res = runHeadlessSnap(["--session", SID, "--handoff", "x"], {});
    assert.equal(res.status, "noop");
    assert.equal(res.reason, "no-active-pointer");
    // The pointer dir may exist (GC ran) but holds no journal write anywhere.
    const dir = resolvePointerDir();
    const ptrs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    assert.deepEqual(ptrs, [], "no journal and no pointer created");
  });
});

test("runHeadlessSnap: NO-OPS when no session id is available at all", () => {
  withTempState(() => {
    // Pass an explicit env WITHOUT CLAUDE_CODE_SESSION_ID so the test does not
    // accidentally pick up the real session id of the process running the suite.
    const res = runHeadlessSnap(["--handoff", "x"], { env: {} });
    assert.equal(res.status, "noop");
    assert.equal(res.reason, "no-session-id");
  });
});

test("runHeadlessSnap: redacts secret-shaped bytes in the auto handoff before persisting", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: journal });

    const token = fakeToken();
    const handoff = `[AUTO] checkpoint with token=${token}`;
    // Sanity: the raw handoff really does contain a redactable secret.
    assert.equal(redactSensitiveText(handoff).count, 1);

    const res = runHeadlessSnap(["--session", SID, "--handoff", handoff], {});
    assert.equal(res.status, "written");
    assert.equal(res.redactions, 1);

    const after = fs.readFileSync(journal, "utf-8");
    assert.ok(!after.includes(token), "raw secret never reaches disk");
    assert.match(after, /\[REDACTED:ENV_SECRET\]/);
  });
});

test("runHeadlessSnap: a vanished journal (pointer stale-by-deletion) no-ops, no recreate", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: journal });
    fs.rmSync(journal, { force: true });
    const res = runHeadlessSnap(["--session", SID, "--handoff", "x"], {});
    assert.equal(res.status, "noop");
    assert.equal(fs.existsSync(journal), false, "journal not recreated");
  });
});

test("runHeadlessSnap: best-effort git snapshot is appended when provided", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: journal });
    const res = runHeadlessSnap(["--session", SID, "--handoff", "h"], {
      gitSnapshot: "### Git Snapshot\n- branch: feat/pr4-auto-capture",
    });
    assert.equal(res.status, "written");
    const after = fs.readFileSync(journal, "utf-8");
    assert.match(after, /### Git Snapshot/);
    assert.match(after, /feat\/pr4-auto-capture/);
  });
});

// ---- real subprocess: proves argv dispatch + that the MCP server does NOT start ----

test("CLI `index.js snap`: dispatches the verb, writes to a temp journal, exits 0 without starting the server", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: journal });

    const r = runSnapCli(
      ["snap", "--session", SID, "--handoff", "[AUTO] PreCompact checkpoint via CLI"],
      root,
    );
    assert.equal(r.status, 0, "CLI exits 0");
    // The server's "running on stdio" line must NOT appear (verb short-circuits).
    assert.ok(!/running on stdio/.test(r.stderr), "MCP server did not start for the CLI verb");
    assert.match(r.stderr, /auto-snap: wrote checkpoint/);

    const after = fs.readFileSync(journal, "utf-8");
    assert.match(after, /\[AUTO\] PreCompact checkpoint via CLI/);
  });
});

test("CLI `index.js snap`: no pointer -> no-op, exits 0 (never blocks compaction)", () => {
  withTempState((root) => {
    // No pointer for SID; a non-zeos session firing PreCompact.
    const r = runSnapCli(["snap", "--session", SID, "--handoff", "x"], root);
    assert.equal(r.status, 0, "no-op still exits 0");
    assert.match(r.stderr, /auto-snap: no-op/);
    assert.ok(!/running on stdio/.test(r.stderr));
  });
});
