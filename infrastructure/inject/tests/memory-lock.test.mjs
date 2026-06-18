import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  acquireMemoryLock,
  releaseMemoryLock,
  LOCK_STALE_MS,
} from "../dist/lib/memory-lock.js";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-lock-"));
}

// A non-blocking, counted sleep so contention tests never wait on the clock.
function countingSleep() {
  const calls = { count: 0 };
  return [(_ms) => { calls.count += 1; }, calls];
}

// ── acquire: success / release ─────────────────────────────────────────────

test("acquireMemoryLock: acquires on a free path and creates the .lock", () => {
  const dir = mkTmpDir();
  try {
    const memoryPath = path.join(dir, "MEMORY.md");
    const [sleep] = countingSleep();
    assert.equal(acquireMemoryLock(memoryPath, { sleepMs: sleep }), true);
    assert.ok(fs.existsSync(`${memoryPath}.lock`), "lock file exists while held");
    releaseMemoryLock(memoryPath);
    assert.equal(fs.existsSync(`${memoryPath}.lock`), false, "lock file removed on release");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── contention: a FRESH held lock blocks a second acquirer ─────────────────

test("acquireMemoryLock: contention against a fresh held lock fails after retries", () => {
  const dir = mkTmpDir();
  try {
    const memoryPath = path.join(dir, "MEMORY.md");
    // Simulate another live holder: a fresh lock file with a current timestamp.
    fs.writeFileSync(`${memoryPath}.lock`, `99999\n${new Date().toISOString()}`, { flag: "wx" });

    const [sleep, calls] = countingSleep();
    const acquired = acquireMemoryLock(memoryPath, { sleepMs: sleep, random: () => 0 });
    assert.equal(acquired, false, "cannot acquire while a fresh lock is held");
    assert.ok(calls.count >= 1, "retried with backoff against the fresh lock");
    // The other holder's lock is left intact (we never steal a fresh lock).
    assert.ok(fs.existsSync(`${memoryPath}.lock`), "fresh foreign lock is not removed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── staleness: an OLD lock is reclaimed immediately ────────────────────────

test("acquireMemoryLock: a stale lock is reclaimed and acquisition succeeds", () => {
  const dir = mkTmpDir();
  try {
    const memoryPath = path.join(dir, "MEMORY.md");
    // A lock older than the stale threshold is orphaned and reclaimable.
    const staleTime = new Date(Date.now() - LOCK_STALE_MS - 5_000).toISOString();
    fs.writeFileSync(`${memoryPath}.lock`, `1234\n${staleTime}`, { flag: "wx" });

    const [sleep, calls] = countingSleep();
    const acquired = acquireMemoryLock(memoryPath, { sleepMs: sleep });
    assert.equal(acquired, true, "stale lock reclaimed, acquisition succeeds");
    assert.equal(calls.count, 0, "no backoff sleep needed; stale lock reclaimed immediately");
    releaseMemoryLock(memoryPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── mutation under lock: a held lock serializes a read-modify-write ────────

test("acquireMemoryLock: holding the lock guards a read-modify-write against a second acquirer", () => {
  const dir = mkTmpDir();
  try {
    const memoryPath = path.join(dir, "MEMORY.md");
    fs.writeFileSync(memoryPath, "v0\n");

    // First holder acquires and performs a read-modify-write.
    const [sleepA] = countingSleep();
    assert.equal(acquireMemoryLock(memoryPath, { sleepMs: sleepA }), true);

    // While A holds the lock, a second acquirer must be refused (no lost update).
    const [sleepB, callsB] = countingSleep();
    assert.equal(
      acquireMemoryLock(memoryPath, { sleepMs: sleepB, random: () => 0 }),
      false,
      "second acquirer refused while the first holds the lock"
    );
    assert.ok(callsB.count >= 1, "second acquirer retried before giving up");

    // A completes its write and releases.
    const current = fs.readFileSync(memoryPath, "utf-8");
    fs.writeFileSync(memoryPath, current + "v1\n");
    releaseMemoryLock(memoryPath);

    // Now a fresh acquirer succeeds and sees A's committed write.
    const [sleepC] = countingSleep();
    assert.equal(acquireMemoryLock(memoryPath, { sleepMs: sleepC }), true);
    assert.equal(fs.readFileSync(memoryPath, "utf-8"), "v0\nv1\n", "A's write is intact");
    releaseMemoryLock(memoryPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseMemoryLock: releasing an already-free path is a safe no-op", () => {
  const dir = mkTmpDir();
  try {
    const memoryPath = path.join(dir, "MEMORY.md");
    assert.doesNotThrow(() => releaseMemoryLock(memoryPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- corrupt lock: an unparseable timestamp is treated as STALE -----------

test("acquireMemoryLock: a lock with a garbage (unparseable) timestamp is reclaimed as stale", () => {
  const dir = mkTmpDir();
  try {
    const memoryPath = path.join(dir, "MEMORY.md");
    // A corrupt lock whose second line is not a parseable date yields NaN.
    // `NaN > LOCK_STALE_MS` is false, so the pre-fix code would treat this as a
    // FRESH lock and deadlock forever. The fix treats NaN as STALE/reclaimable.
    fs.writeFileSync(`${memoryPath}.lock`, `4242\nnot-a-timestamp`, { flag: "wx" });

    const [sleep, calls] = countingSleep();
    const acquired = acquireMemoryLock(memoryPath, { sleepMs: sleep });
    assert.equal(acquired, true, "corrupt-timestamp lock reclaimed, acquisition succeeds");
    assert.equal(calls.count, 0, "no backoff sleep; corrupt lock reclaimed immediately as stale");
    releaseMemoryLock(memoryPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireMemoryLock: a lock missing the timestamp line entirely is reclaimed as stale", () => {
  const dir = mkTmpDir();
  try {
    const memoryPath = path.join(dir, "MEMORY.md");
    // Only a pid, no second line at all: split("\n")[1] is undefined -> NaN.
    fs.writeFileSync(`${memoryPath}.lock`, `4242`, { flag: "wx" });

    const [sleep] = countingSleep();
    assert.equal(
      acquireMemoryLock(memoryPath, { sleepMs: sleep }),
      true,
      "lock with no timestamp line is reclaimed as stale"
    );
    releaseMemoryLock(memoryPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
