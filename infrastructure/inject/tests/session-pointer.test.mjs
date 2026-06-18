import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  SESSION_POINTER_TTL_MINUTES,
  resolvePointerDir,
  isSafeSessionId,
  currentSessionIdFromEnv,
  writeSessionPointer,
  resolveSessionPointer,
  gcStalePointers,
  deleteSessionPointer,
  containedRealJournalPath,
} from "../dist/lib/session-pointer.js";

// resolvePointerDir() reads ZEOS_STATE_ROOT live, so a per-test temp state root
// fully isolates pointer I/O from the real ~/.zeos. Each test sets the env to a
// fresh mkdtemp dir; the original is restored afterward.
function withTempState(fn) {
  const prev = process.env.ZEOS_STATE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeos-pointer-test-"));
  process.env.ZEOS_STATE_ROOT = root;
  try {
    return fn(root);
  } finally {
    if (prev === undefined) delete process.env.ZEOS_STATE_ROOT;
    else process.env.ZEOS_STATE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A real journal file the pointer can point at; resolution requires it to exist.
function seedJournal(root, name = "2026-06-18-001-claude.md") {
  const dir = path.join(root, "journals", "demo-app");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "---\nstatus: active\n---\n\n# J\n");
  return p;
}

const SID = "1c40c7e5-8d6f-4326-9218-fc65548b5cb3"; // UUID-shaped, like a real session id

// ---- session id validation (path-safety) ----

test("isSafeSessionId: UUIDs and plain tokens pass; traversal/empty/space/long reject", () => {
  assert.equal(isSafeSessionId(SID), true);
  assert.equal(isSafeSessionId("abc123"), true);
  assert.equal(isSafeSessionId(""), false);
  assert.equal(isSafeSessionId("../etc/passwd"), false);
  assert.equal(isSafeSessionId("a/b"), false);
  assert.equal(isSafeSessionId("a b"), false);
  assert.equal(isSafeSessionId("a".repeat(129)), false);
  assert.equal(isSafeSessionId(undefined), false);
  assert.equal(isSafeSessionId(42), false);
});

test("currentSessionIdFromEnv: returns a valid id, null when absent or unsafe", () => {
  assert.equal(currentSessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: SID }), SID);
  assert.equal(currentSessionIdFromEnv({}), null);
  assert.equal(currentSessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: "../x" }), null);
});

// ---- round-trip: write -> resolve ----

test("writeSessionPointer + resolveSessionPointer: round-trips the active journal", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    const written = writeSessionPointer({
      sessionId: SID,
      appId: "demo-app",
      agent: "claude",
      journalPath: journal,
    });
    assert.ok(written, "pointer write returned a path");
    assert.equal(written, path.join(resolvePointerDir(), `${SID}.json`));

    const resolved = resolveSessionPointer(SID);
    assert.ok(resolved, "pointer resolves");
    assert.equal(resolved.session_id, SID);
    assert.equal(resolved.app_id, "demo-app");
    assert.equal(resolved.agent, "claude");
    assert.equal(resolved.journal_path, journal);
    assert.equal(resolved.schema, 1);
  });
});

test("writeSessionPointer: rewrite for same session is idempotent (overwrites, no dup files)", () => {
  withTempState((root) => {
    const j1 = seedJournal(root, "2026-06-18-001-claude.md");
    const j2 = seedJournal(root, "2026-06-18-002-claude.md");
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: j1 });
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: j2 });
    const files = fs.readdirSync(resolvePointerDir()).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, "exactly one pointer per session");
    assert.equal(resolveSessionPointer(SID).journal_path, j2, "latest write wins");
  });
});

test("writeSessionPointer: rejects unsafe id, missing fields, and relative journal path", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    assert.equal(
      writeSessionPointer({ sessionId: "../x", appId: "a", agent: "c", journalPath: journal }),
      null,
    );
    assert.equal(
      writeSessionPointer({ sessionId: SID, appId: "", agent: "c", journalPath: journal }),
      null,
    );
    assert.equal(
      writeSessionPointer({ sessionId: SID, appId: "a", agent: "c", journalPath: "relative/path.md" }),
      null,
    );
  });
});

// ---- no-op cases: absent, mismatched id, malformed, vanished journal ----

test("resolveSessionPointer: absent pointer returns null (no-op)", () => {
  withTempState(() => {
    assert.equal(resolveSessionPointer(SID), null);
  });
});

test("resolveSessionPointer: a DIFFERENT session id never resolves another session's pointer", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: journal });
    const other = "ffffffff-0000-0000-0000-000000000000";
    assert.equal(resolveSessionPointer(other), null, "no cross-session leakage");
  });
});

test("resolveSessionPointer: malformed pointer returns null and is left in place", () => {
  withTempState(() => {
    const dir = resolvePointerDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${SID}.json`);
    fs.writeFileSync(p, "{ not json");
    assert.equal(resolveSessionPointer(SID), null);
    assert.equal(fs.existsSync(p), true, "malformed pointer not deleted (could be a concurrent write)");
  });
});

test("resolveSessionPointer: vanished journal -> null (never recreates a journal)", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: journal });
    fs.rmSync(journal, { force: true });
    assert.equal(resolveSessionPointer(SID), null);
  });
});

// ---- TTL / staleness ----

test("resolveSessionPointer: a pointer older than the TTL is treated stale and GC'd", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    // Stamp the pointer well in the past.
    const old = new Date(Date.now() - (SESSION_POINTER_TTL_MINUTES + 60) * 60_000);
    const written = writeSessionPointer({
      sessionId: SID,
      appId: "demo-app",
      agent: "claude",
      journalPath: journal,
      now: old,
    });
    assert.ok(written);
    assert.equal(resolveSessionPointer(SID), null, "stale pointer does not resolve");
    assert.equal(fs.existsSync(written), false, "stale pointer is GC'd on resolve");
  });
});

test("resolveSessionPointer: fresh pointer within TTL resolves; custom ttl honored", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    const tenMinAgo = new Date(Date.now() - 10 * 60_000);
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: journal, now: tenMinAgo });
    assert.ok(resolveSessionPointer(SID, { ttlMinutes: 60 }), "within a 60m ttl");
    assert.equal(resolveSessionPointer(SID, { ttlMinutes: 5 }), null, "outside a 5m ttl");
  });
});

test("resolveSessionPointer: a slightly-future pointer (minor clock skew) is not treated stale", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    // Within the small future-skew tolerance: plausible real clock skew.
    const nearFuture = new Date(Date.now() + 60_000);
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: journal, now: nearFuture });
    assert.ok(resolveSessionPointer(SID), "minor future skew resolves rather than no-ops");
  });
});

test("resolveSessionPointer: a FAR-future pointer (forged timestamp) is treated stale, not perpetually fresh", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    // A tampered far-future updated_at would otherwise never age out via the TTL
    // (age is negative). It must be rejected as invalid/stale instead.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60_000); // +1 year
    const written = writeSessionPointer({
      sessionId: SID,
      appId: "demo-app",
      agent: "claude",
      journalPath: journal,
      now: farFuture,
    });
    assert.ok(written, "write itself still succeeds (containment, not timestamp, gates the write)");
    assert.equal(resolveSessionPointer(SID), null, "far-future pointer does not resolve");
  });
});

// ---- GC sweep ----

test("gcStalePointers: removes stale and malformed pointers, keeps fresh ones", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    const fresh = "11111111-1111-1111-1111-111111111111";
    const stale = "22222222-2222-2222-2222-222222222222";
    writeSessionPointer({ sessionId: fresh, appId: "demo-app", agent: "claude", journalPath: journal });
    writeSessionPointer({
      sessionId: stale,
      appId: "demo-app",
      agent: "claude",
      journalPath: journal,
      now: new Date(Date.now() - (SESSION_POINTER_TTL_MINUTES + 120) * 60_000),
    });
    // a malformed pointer file
    fs.writeFileSync(path.join(resolvePointerDir(), "junk.json"), "nope");

    const removed = gcStalePointers();
    assert.equal(removed, 2, "stale + malformed removed");
    const left = fs.readdirSync(resolvePointerDir()).filter((f) => f.endsWith(".json"));
    assert.deepEqual(left, [`${fresh}.json`], "only the fresh pointer survives");
  });
});

test("gcStalePointers: absent pointer dir returns 0 (never throws)", () => {
  withTempState(() => {
    assert.equal(gcStalePointers(), 0);
  });
});

// ---- deletion (e.g. on /end) ----

test("deleteSessionPointer: removes the session's pointer; unsafe id is a no-op", () => {
  withTempState((root) => {
    const journal = seedJournal(root);
    const written = writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: journal });
    assert.ok(fs.existsSync(written));
    deleteSessionPointer("../x"); // unsafe -> no-op, no throw
    assert.equal(fs.existsSync(written), true);
    deleteSessionPointer(SID);
    assert.equal(fs.existsSync(written), false);
  });
});

// ---- journal-path containment (P1 safety: never write the wrong journal) ----
//
// Seed a real journal first so the journals root (<state>/journals) exists and
// realpath can resolve it; then exercise the escape vectors.

test("containedRealJournalPath: a legit journal under the journals root is accepted", () => {
  withTempState((root) => {
    const journal = seedJournal(root); // <root>/journals/demo-app/<file>.md
    const real = containedRealJournalPath(journal);
    assert.ok(real, "in-root journal is contained");
    assert.equal(real, fs.realpathSync(journal));
  });
});

test("containedRealJournalPath: an absolute path OUTSIDE the journals root is rejected", () => {
  withTempState((root) => {
    seedJournal(root); // materialize the journals root
    // A real file outside the journals tree (mimics MEMORY.md / a transcript).
    const outside = path.join(root, "memory", "demo-app", "MEMORY.md");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "# memory\n");
    assert.equal(containedRealJournalPath(outside), null, "outside-root path rejected");
    // /tmp-style absolute outside the state root entirely.
    const tmpFile = fs.mkdtempSync(path.join(os.tmpdir(), "zeos-outside-")) + "/x.md";
    fs.writeFileSync(tmpFile, "x");
    assert.equal(containedRealJournalPath(tmpFile), null, "unrelated absolute path rejected");
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  });
});

test("containedRealJournalPath: a journal that is a SYMLINK escaping the root is rejected", () => {
  withTempState((root) => {
    const journalDir = path.join(root, "journals", "demo-app");
    fs.mkdirSync(journalDir, { recursive: true });
    // A real target OUTSIDE the journals root.
    const escapeTarget = path.join(root, "escape-target.md");
    fs.writeFileSync(escapeTarget, "# not a journal\n");
    // A symlink INSIDE the journals dir pointing at the outside target.
    const link = path.join(journalDir, "2026-06-18-001-claude.md");
    fs.symlinkSync(escapeTarget, link);
    // The path looks in-root, but realpath resolves the symlink to outside.
    assert.equal(containedRealJournalPath(link), null, "symlink escaping the root rejected");
  });
});

test("writeSessionPointer: rejects a journal path outside the journals root (no pointer written)", () => {
  withTempState((root) => {
    seedJournal(root); // materialize the root
    const outside = path.join(root, "memory", "demo-app", "MEMORY.md");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "# memory\n");
    const written = writeSessionPointer({
      sessionId: SID,
      appId: "demo-app",
      agent: "claude",
      journalPath: outside,
    });
    assert.equal(written, null, "write rejected for out-of-root journal");
    const ptrs = fs.existsSync(resolvePointerDir())
      ? fs.readdirSync(resolvePointerDir()).filter((f) => f.endsWith(".json"))
      : [];
    assert.deepEqual(ptrs, [], "no pointer persisted for a rejected journal");
  });
});

test("resolveSessionPointer: a tampered pointer whose journal_path is OUTSIDE the root no-ops", () => {
  withTempState((root) => {
    const journal = seedJournal(root); // materialize root; legit journal for shape
    // A real out-of-root file we will point the tampered pointer at.
    const outside = path.join(root, "memory", "demo-app", "MEMORY.md");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    const sentinel = "# memory sentinel\n";
    fs.writeFileSync(outside, sentinel);
    // Hand-write a valid-shaped pointer that points OUTSIDE the journals root,
    // simulating a tampered ~/.zeos/.active/<id>.json on disk.
    const dir = resolvePointerDir();
    fs.mkdirSync(dir, { recursive: true });
    const tampered = {
      schema: 1,
      session_id: SID,
      app_id: "demo-app",
      agent: "claude",
      journal_path: outside,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify(tampered) + "\n");
    assert.equal(resolveSessionPointer(SID), null, "tampered out-of-root pointer no-ops on resolve");
    // The out-of-root file must be untouched (resolution never directed a write).
    assert.equal(fs.readFileSync(outside, "utf-8"), sentinel, "out-of-root file untouched");
    // Sanity: a legit in-root pointer for the same shape still resolves.
    writeSessionPointer({ sessionId: SID, appId: "demo-app", agent: "claude", journalPath: journal });
    assert.ok(resolveSessionPointer(SID), "legit in-root journal still resolves");
  });
});

test("resolveSessionPointer: a tampered pointer whose journal is a SYMLINK escaping the root no-ops", () => {
  withTempState((root) => {
    const journalDir = path.join(root, "journals", "demo-app");
    fs.mkdirSync(journalDir, { recursive: true });
    const escapeTarget = path.join(root, "escape-target.md");
    const sentinel = "# escape sentinel\n";
    fs.writeFileSync(escapeTarget, sentinel);
    const link = path.join(journalDir, "2026-06-18-001-claude.md");
    fs.symlinkSync(escapeTarget, link);
    // The write gate would reject this symlink, so hand-write a valid-shaped
    // pointer that references the in-dir symlink path (looks contained on its
    // face, resolves OUT) to prove the RESOLVE side independently rejects it -
    // i.e. it does not trust the on-disk pointer.
    const dir = resolvePointerDir();
    fs.mkdirSync(dir, { recursive: true });
    const tampered = {
      schema: 1,
      session_id: SID,
      app_id: "demo-app",
      agent: "claude",
      journal_path: link,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify(tampered) + "\n");
    assert.equal(resolveSessionPointer(SID), null, "symlink-escaping pointer no-ops on resolve");
    assert.equal(fs.readFileSync(escapeTarget, "utf-8"), sentinel, "symlink target untouched");
  });
});
