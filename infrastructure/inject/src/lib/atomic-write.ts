import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { redactSensitiveText } from "./redact.js";

/**
 * Crash-safe durable file writes for full-rewrite persistence (MEMORY.md,
 * MEMORY_ARCHIVE.md, SOUL.md).
 *
 * Durability model (the four steps a torn write must survive):
 *   1. Write the bytes to a sibling temp file `<path>.<rand>.tmp`.
 *   2. fsync the temp file descriptor so the bytes are on stable storage
 *      before they are named.
 *   3. rename(tmp -> final). rename is atomic within a filesystem: a reader
 *      sees either the whole old file or the whole new file, never a partial.
 *   4. fsync the PARENT DIRECTORY so the rename itself (a directory-entry
 *      mutation) is durable. Without this, a crash after rename can lose the
 *      directory update and resurrect the old name, defeating step 3.
 *
 * On ANY failure the temp file is removed so a crashed write leaves no
 * orphaned `.tmp` litter and never the original file in a half-state.
 *
 * Pre-write redaction is asserted by the caller-facing wrappers below, never
 * silently inside the low-level write: the contract is that secret-shaped
 * bytes must be caught and surfaced before they are persisted, not after.
 */

/** Raised when content fails the secret-shape gate before or after a write. */
export class RedactionAssertionError extends Error {
  readonly count: number;
  readonly labels: string[];
  constructor(stage: string, count: number, labels: string[], target: string) {
    const labelSuffix = labels.length > 0 ? ` (${labels.join(", ")})` : "";
    super(
      `Redaction assertion failed (${stage}): ${count} secret-shaped value(s)` +
        `${labelSuffix} would reach disk at ${target}. Write aborted.`
    );
    this.name = "RedactionAssertionError";
    this.count = count;
    this.labels = labels;
  }
}

/**
 * Assert text carries no secret-shaped bytes, throwing RedactionAssertionError
 * if it does. Used as the pre-write, pre-rename, and post-rename gate.
 */
export function assertNoSecrets(text: string, stage: string, target: string): void {
  const result = redactSensitiveText(text);
  if (result.count > 0) {
    throw new RedactionAssertionError(stage, result.count, result.labels, target);
  }
}

function fsyncParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  // Opening a directory for fsync is POSIX. On platforms that reject O_RDONLY
  // on a directory we degrade gracefully: the rename already happened, and the
  // missing dir-fsync only weakens crash durability, it does not corrupt.
  let dirFd: number | null = null;
  try {
    dirFd = fs.openSync(dir, "r");
    fs.fsyncSync(dirFd);
  } catch {
    /* directory fsync unsupported on this platform; rename still applied */
  } finally {
    if (dirFd !== null) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* fd already gone */
      }
    }
  }
}

/**
 * Atomically and durably write `data` to `targetPath`.
 *
 * Optionally asserts the content carries no secret-shaped bytes BEFORE the
 * write and the tmp contents BEFORE the rename, and re-asserts the readback
 * AFTER fsync. Pass `assertRedaction: false` only for content classes that are
 * not free-text (none today; the default is on).
 */
export function atomicWriteFileSync(
  targetPath: string,
  data: string,
  opts: { assertRedaction?: boolean } = {}
): void {
  const assertRedaction = opts.assertRedaction !== false;

  // (1) Pre-write gate: never let secret-shaped bytes leave memory for disk.
  if (assertRedaction) assertNoSecrets(data, "pre-write", targetPath);

  const tmpPath = `${targetPath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd); // (2) bytes durable before they are named
    fs.closeSync(fd);
    fd = null;

    // (2b) Pre-rename gate: re-read the tmp file and assert what is about to
    // become the live file is clean. Guards against an encoding/IO surprise
    // between the in-memory string and the on-disk bytes.
    if (assertRedaction) {
      const onDisk = fs.readFileSync(tmpPath, "utf-8");
      assertNoSecrets(onDisk, "pre-rename", targetPath);
    }

    fs.renameSync(tmpPath, targetPath); // (3) atomic swap
    fsyncParentDir(targetPath); // (4) make the rename itself durable
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* fd already gone */
      }
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort tmp cleanup; surface the original error */
    }
    throw err;
  }

  // (3) Post-rename readback gate: the final on-disk file is the source of
  // truth; prove it is clean as the last line of defense.
  if (assertRedaction) {
    const written = fs.readFileSync(targetPath, "utf-8");
    assertNoSecrets(written, "post-rename", targetPath);
  }
}

/**
 * Atomic durable write for MEMORY.md with a single-generation `.bak` snapshot.
 *
 * The backup is taken from the PRIOR file only after asserting the prior file
 * itself passes redaction. A prior file that FAILS redaction is an incident (a
 * secret already on disk), not a backup edge: we refuse to duplicate it into
 * `.bak` and surface a loud error so the leak is handled, not propagated.
 *
 * The new `data` is then written through `atomicWriteFileSync`, which applies
 * the full three-point redaction gate and the crash-safe write.
 */
export function atomicWriteWithBackup(
  targetPath: string,
  data: string,
  opts: { assertRedaction?: boolean } = {}
): void {
  const assertRedaction = opts.assertRedaction !== false;

  if (fs.existsSync(targetPath)) {
    const prior = fs.readFileSync(targetPath, "utf-8");
    if (assertRedaction) {
      // A pre-existing leaked secret must HALT before we mutate or back it up.
      assertNoSecrets(prior, "pre-existing-target", targetPath);
    }
    // Snapshot the clean prior generation durably before the swap.
    atomicWriteFileSync(`${targetPath}.bak`, prior, { assertRedaction });
  }

  atomicWriteFileSync(targetPath, data, { assertRedaction });
}

/**
 * Durable append for append-only files (session journals).
 *
 * Append-only state must STAY append-only (temp+rename would rewrite the whole
 * file and break the journal contract), so durability here is append + fsync:
 * the new bytes are forced to stable storage so a crash cannot leave a torn
 * tail. Redaction is asserted on the appended chunk BEFORE it is written, since
 * on an append-only file a post-write throw is too late: the secret is already
 * on disk.
 */
export function appendFileSyncDurable(
  targetPath: string,
  chunk: string,
  opts: { assertRedaction?: boolean } = {}
): void {
  const assertRedaction = opts.assertRedaction !== false;

  // Pre-append gate: the chunk is the only new content; assert it is clean
  // before any byte reaches the append-only file.
  if (assertRedaction) assertNoSecrets(chunk, "pre-append", targetPath);

  let fd: number | null = null;
  try {
    fd = fs.openSync(targetPath, "a");
    fs.writeFileSync(fd, chunk);
    fs.fsyncSync(fd); // force the appended tail to stable storage
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* fd already gone */
      }
    }
  }
}
