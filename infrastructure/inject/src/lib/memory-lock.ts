import * as fs from "node:fs";

/**
 * Filesystem advisory lock for MEMORY.md / MEMORY_ARCHIVE.md read-modify-write
 * cycles.
 *
 * The lock is a sibling `<memoryPath>.lock` created with O_CREAT|O_EXCL
 * (`{flag:"wx"}`) so creation is atomic: exactly one holder wins. A held lock
 * carries the holder pid and an ISO timestamp; a lock older than the stale
 * threshold is treated as orphaned and reclaimed. The lock guards the WHOLE
 * cycle (read -> mutate -> write both files) so a stale read cannot clobber a
 * concurrent writer (the lost-update class).
 *
 * Extracted from index.ts so the contention/staleness paths are unit-testable.
 * The blocking backoff is injectable (`sleepMs`) so tests exercise the retry
 * loop without real wall-clock sleeps; the default blocks synchronously via
 * Atomics.wait (no shell, no child process).
 */

export const LOCK_STALE_MS = 30_000; // 30s, auto-reclaim orphaned locks
export const LOCK_RETRY_MAX = 5;
export const LOCK_RETRY_BASE_MS = 500;

/**
 * Default synchronous blocking sleep. Uses Atomics.wait on a throwaway
 * SharedArrayBuffer, the standard shell-free synchronous sleep in Node. No
 * user input is involved and no subprocess is spawned.
 */
function defaultSleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

export interface MemoryLockOptions {
  /** Injectable blocking backoff (ms). Defaults to a real `sleep`. */
  sleepMs?: (ms: number) => void;
  /** Injectable jitter source in [0,1). Defaults to Math.random. */
  random?: () => number;
}

/**
 * Try to acquire the lock, retrying with jitter while a FRESH lock is held and
 * reclaiming a STALE one immediately. Returns true on acquisition, false if it
 * could not be acquired within LOCK_RETRY_MAX attempts.
 */
export function acquireMemoryLock(memoryPath: string, opts: MemoryLockOptions = {}): boolean {
  const sleepMs = opts.sleepMs ?? defaultSleepMs;
  const random = opts.random ?? Math.random;
  const lockPath = memoryPath + ".lock";

  for (let attempt = 0; attempt < LOCK_RETRY_MAX; attempt++) {
    try {
      // O_CREAT|O_EXCL: atomic create, fails with EEXIST if the lock exists.
      fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: "wx" });
      return true;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        // Lock held: reclaim if stale, otherwise wait with jitter and retry.
        try {
          const lockContent = fs.readFileSync(lockPath, "utf-8");
          const lockTime = new Date(lockContent.split("\n")[1]).getTime();
          // A missing/garbage timestamp parses to NaN. `NaN > LOCK_STALE_MS` is
          // false, which would wrongly treat an unreadable lock as FRESH and
          // never reclaim it (a permanent deadlock on a corrupt lock file).
          // Fail-safe: an unparseable timestamp is treated as STALE/reclaimable,
          // matching the "unreadable = stale" contract of the catch below.
          if (Number.isNaN(lockTime) || Date.now() - lockTime > LOCK_STALE_MS) {
            fs.unlinkSync(lockPath); // remove stale/corrupt lock
            continue; // retry immediately
          }
        } catch {
          /* lock file unreadable: treat as stale */
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
          continue;
        }
        const jitter = LOCK_RETRY_BASE_MS + Math.floor(random() * 500);
        sleepMs(jitter);
        continue;
      }
      throw e; // unexpected error
    }
  }
  return false; // could not acquire after retries
}

export function releaseMemoryLock(memoryPath: string): void {
  const lockPath = memoryPath + ".lock";
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already released */
  }
}
