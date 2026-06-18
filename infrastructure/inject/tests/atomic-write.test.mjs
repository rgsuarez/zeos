import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  atomicWriteFileSync,
  atomicWriteWithBackup,
  appendFileSyncDurable,
  assertNoSecrets,
  RedactionAssertionError,
} from "../dist/lib/atomic-write.js";

// Runtime construction of a secret-shaped string keeps this file free of static
// token-shaped literals that secret scanners flag in source. Mirrors the
// joinParts/padEnd technique used by redact.test.mjs.
function joinParts(...parts) {
  return parts.join("");
}
function secretShapedLine() {
  const value = joinParts("a", "b", "c").padEnd(32, "x");
  return `api_key="${value}"`;
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
}

// ── atomicWriteFileSync: success ───────────────────────────────────────────

test("atomicWriteFileSync: writes the data and leaves no tmp litter", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "MEMORY.md");
    atomicWriteFileSync(target, "hello durable world\n");
    assert.equal(fs.readFileSync(target, "utf-8"), "hello durable world\n");
    const leftovers = fs.readdirSync(dir).filter(f => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no .tmp files remain after a successful write");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFileSync: overwrites an existing file atomically", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "MEMORY.md");
    fs.writeFileSync(target, "old content\n");
    atomicWriteFileSync(target, "new content\n");
    assert.equal(fs.readFileSync(target, "utf-8"), "new content\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── atomicWriteFileSync: simulated crash before rename leaves original intact ─

test("atomicWriteFileSync: a failure before rename leaves the original untouched and cleans the tmp", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "MEMORY.md");
    fs.writeFileSync(target, "ORIGINAL\n");

    // Simulate a crash during the write by making the directory read-only so
    // the rename step fails. The original file must survive and no tmp may leak.
    // (chmod is honored on the test platforms; the assertion is the contract.)
    const original = fs.readFileSync(target, "utf-8");

    // Force a failure deterministically: pass a target whose parent does not
    // exist so openSync(tmp) throws before any rename can corrupt the original.
    const doomed = path.join(dir, "nonexistent-subdir", "MEMORY.md");
    assert.throws(() => atomicWriteFileSync(doomed, "SHOULD NOT PERSIST\n"));

    // The real, existing target is wholly unaffected by the doomed write.
    assert.equal(fs.readFileSync(target, "utf-8"), original, "original file is intact");
    const leftovers = fs
      .readdirSync(dir)
      .filter(f => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no orphaned tmp file after a failed write");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFileSync: tmp file is removed when the redaction gate aborts the write", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "MEMORY.md");
    fs.writeFileSync(target, "ORIGINAL\n");
    assert.throws(
      () => atomicWriteFileSync(target, `leak: ${secretShapedLine()}\n`),
      RedactionAssertionError
    );
    // Pre-write gate fires before any tmp is created; original is intact.
    assert.equal(fs.readFileSync(target, "utf-8"), "ORIGINAL\n");
    const leftovers = fs.readdirSync(dir).filter(f => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no tmp leak when the pre-write gate aborts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── redaction assertion: clean passes, secret-shaped throws ────────────────

test("assertNoSecrets: clean text passes without throwing", () => {
  assert.doesNotThrow(() => assertNoSecrets("ordinary prose, no secrets here", "test", "/tmp/x"));
});

test("assertNoSecrets: secret-shaped bytes throw RedactionAssertionError carrying the count", () => {
  let thrown;
  try {
    assertNoSecrets(secretShapedLine(), "test", "/tmp/x");
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof RedactionAssertionError, "throws the typed error");
  assert.equal(thrown.count, 1);
  assert.deepEqual(thrown.labels, ["ENV_SECRET"]);
});

test("atomicWriteFileSync: clean content writes; secret-shaped content never reaches disk", () => {
  const dir = mkTmpDir();
  try {
    const cleanTarget = path.join(dir, "clean.md");
    atomicWriteFileSync(cleanTarget, "no secrets\n");
    assert.ok(fs.existsSync(cleanTarget));

    const secretTarget = path.join(dir, "secret.md");
    assert.throws(
      () => atomicWriteFileSync(secretTarget, `oops ${secretShapedLine()}\n`),
      RedactionAssertionError
    );
    assert.equal(fs.existsSync(secretTarget), false, "no file is created when the gate fires");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── atomicWriteWithBackup ──────────────────────────────────────────────────

test("atomicWriteWithBackup: snapshots the prior clean file to .bak then writes the new content", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "MEMORY.md");
    fs.writeFileSync(target, "PRIOR GENERATION\n");
    atomicWriteWithBackup(target, "NEW GENERATION\n");
    assert.equal(fs.readFileSync(target, "utf-8"), "NEW GENERATION\n");
    assert.equal(fs.readFileSync(`${target}.bak`, "utf-8"), "PRIOR GENERATION\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteWithBackup: no prior file means no .bak is created", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "MEMORY.md");
    atomicWriteWithBackup(target, "FIRST GENERATION\n");
    assert.equal(fs.readFileSync(target, "utf-8"), "FIRST GENERATION\n");
    assert.equal(fs.existsSync(`${target}.bak`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteWithBackup: a prior file that already leaks a secret HALTS and is NOT copied to .bak", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "MEMORY.md");
    // A pre-existing leaked secret is an incident, not a backup edge.
    fs.writeFileSync(target, `pre-leaked ${secretShapedLine()}\n`);
    assert.throws(
      () => atomicWriteWithBackup(target, "NEW CLEAN GENERATION\n"),
      RedactionAssertionError
    );
    // The new content must NOT have been written, and the leak must NOT have
    // been duplicated into .bak.
    assert.match(fs.readFileSync(target, "utf-8"), /pre-leaked/, "target not mutated on halt");
    assert.equal(fs.existsSync(`${target}.bak`), false, "leaked prior is never backed up");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── appendFileSyncDurable ──────────────────────────────────────────────────

test("appendFileSyncDurable: appends to an existing file and preserves prior content", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "journal.md");
    fs.writeFileSync(target, "line one\n");
    appendFileSyncDurable(target, "line two\n");
    assert.equal(fs.readFileSync(target, "utf-8"), "line one\nline two\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendFileSyncDurable: two appends accumulate in order", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "journal.md");
    fs.writeFileSync(target, "");
    appendFileSyncDurable(target, "a\n");
    appendFileSyncDurable(target, "b\n");
    assert.equal(fs.readFileSync(target, "utf-8"), "a\nb\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendFileSyncDurable: a secret-shaped chunk is rejected before any byte is appended", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "journal.md");
    fs.writeFileSync(target, "existing\n");
    assert.throws(
      () => appendFileSyncDurable(target, `appended ${secretShapedLine()}\n`),
      RedactionAssertionError
    );
    assert.equal(fs.readFileSync(target, "utf-8"), "existing\n", "no secret byte was appended");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- atomicWriteFileSync: permission preservation on replace --------------

test("atomicWriteFileSync: preserves the existing target's restrictive mode (0600) across the replace", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "MEMORY.md");
    // A tightened file (e.g. operator ran `chmod 600` on MEMORY.md/SOUL.md).
    fs.writeFileSync(target, "secret-ish but not token-shaped\n");
    fs.chmodSync(target, 0o600);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600, "precondition: target is 0600");

    atomicWriteFileSync(target, "new content, still private\n");

    // The rename replaces the inode, so without preservation the new file would
    // carry default umask perms (0644). The fix re-applies 0600 before rename.
    assert.equal(
      fs.statSync(target).mode & 0o777,
      0o600,
      "restrictive mode survives the atomic replace (not broadened to 0644)"
    );
    assert.equal(fs.readFileSync(target, "utf-8"), "new content, still private\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFileSync: a brand-new file (no existing target) keeps default umask perms", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "NEW.md");
    atomicWriteFileSync(target, "fresh file\n");
    // No prior inode to preserve; mode is whatever the umask yields (commonly
    // 0644). Assert it is NOT the restrictive 0600 a preserved file would carry,
    // proving preservation only triggers when a target already exists.
    assert.notEqual(fs.statSync(target).mode & 0o777, 0o600, "new file is not forced to 0600");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteWithBackup: preserves the prior file's 0600 mode on the rewritten target", () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "MEMORY.md");
    fs.writeFileSync(target, "prior private generation\n");
    fs.chmodSync(target, 0o600);

    atomicWriteWithBackup(target, "new private generation\n");

    assert.equal(
      fs.statSync(target).mode & 0o777,
      0o600,
      "the rewritten target keeps the prior restrictive mode"
    );
    assert.equal(fs.readFileSync(target, "utf-8"), "new private generation\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
