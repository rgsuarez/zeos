import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ZEOS_JOURNALS_ROOT,
  expandPath,
  resolveJournalPath,
  verifyJournalWritten,
} from "../dist/path-resolver.js";

test("resolveJournalPath: repo-backed app resolves to zeos-side journal root", () => {
  const app = {
    app_id: "example-app",
    local_path: "example-app/",
    journal_location: "{repo}/session-journals/",
    repo: { url: "https://github.com/example-org/example-app" },
  };
  const result = resolveJournalPath(app);
  assert.equal(result, `${ZEOS_JOURNALS_ROOT}/example-app/`);
});

test("resolveJournalPath: zeos-apps-only app resolves to zeos-side journal root", () => {
  const app = {
    app_id: "zeos-dev",
    local_path: "zeos-dev/",
    journal_location: "{repo}/session-journals/",
  };
  const result = resolveJournalPath(app);
  assert.equal(result, `${ZEOS_JOURNALS_ROOT}/zeos-dev/`);
});

test("resolveJournalPath: repo.url undefined resolves to zeos-side journal root", () => {
  const app = {
    app_id: "internal-tool",
    local_path: "internal-tool/",
    journal_location: "{repo}/session-journals/",
    repo: { branch: "main" },
  };
  const result = resolveJournalPath(app);
  assert.equal(result, `${ZEOS_JOURNALS_ROOT}/internal-tool/`);
});

test("resolveJournalPath: absolute literal path is ignored in favor of zeos-side journal root", () => {
  const app = {
    app_id: "external",
    local_path: "external/",
    journal_location: "/var/log/zeos/external/",
  };
  const result = resolveJournalPath(app);
  assert.equal(result, `${ZEOS_JOURNALS_ROOT}/external/`);
});

test("resolveJournalPath: home-relative literal path is ignored in favor of zeos-side journal root", () => {
  const app = {
    app_id: "external",
    local_path: "external/",
    journal_location: "~/somewhere/else/",
  };
  const result = resolveJournalPath(app);
  assert.equal(result, `${ZEOS_JOURNALS_ROOT}/external/`);
});

test("resolveJournalPath: bare relative literal path is ignored in favor of zeos-side journal root", () => {
  const app = {
    app_id: "external",
    local_path: "external/",
    journal_location: "external/journals/",
  };
  const result = resolveJournalPath(app);
  assert.equal(result, `${ZEOS_JOURNALS_ROOT}/external/`);
});

test("expandPath: ~/ is expanded to homedir", () => {
  assert.equal(expandPath("~/foo/bar"), path.join(os.homedir(), "foo/bar"));
});

test("expandPath: absolute path passes through unchanged", () => {
  assert.equal(expandPath("/var/log/x"), "/var/log/x");
});

test("verifyJournalWritten: succeeds for existing file", () => {
  const tmp = path.join(os.tmpdir(), `inject-test-${Date.now()}.md`);
  fs.writeFileSync(tmp, "test");
  try {
    assert.doesNotThrow(() => verifyJournalWritten(tmp));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("verifyJournalWritten: throws for missing file", () => {
  const missing = path.join(os.tmpdir(), `inject-test-missing-${Date.now()}.md`);
  assert.throws(
    () => verifyJournalWritten(missing),
    /verification failed/i,
  );
});

// Runtime-built secret-shaped string, never a static token literal.
function secretShapedLine() {
  const value = ["a", "b", "c"].join("").padEnd(32, "x");
  return `api_key="${value}"`;
}

test("verifyJournalWritten: a clean appended chunk passes the readback gate", () => {
  const tmp = path.join(os.tmpdir(), `inject-test-clean-${Date.now()}.md`);
  const chunk = "## Session End\nordinary recap, no secrets.\n";
  fs.writeFileSync(tmp, chunk);
  try {
    assert.doesNotThrow(() => verifyJournalWritten(tmp, chunk));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("verifyJournalWritten: a secret-shaped APPENDED CHUNK fails the readback gate", () => {
  const tmp = path.join(os.tmpdir(), `inject-test-leak-${Date.now()}.md`);
  const chunk = `## Session End\nleaked ${secretShapedLine()}\n`;
  fs.writeFileSync(tmp, chunk);
  try {
    assert.throws(
      () => verifyJournalWritten(tmp, chunk),
      /unredacted secret-shaped/i,
    );
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("verifyJournalWritten: a pre-existing legacy secret OUTSIDE the appended chunk does NOT brick the write (footgun fix)", () => {
  // The journal already carries a legacy secret-shaped string written by an
  // older build before the redaction gate existed. A new, clean append must
  // still succeed: the verification is scoped to the appended chunk, never a
  // whole-file re-scan that a single legacy false-positive could permanently
  // brick (every future snap/end on that journal would throw otherwise).
  const tmp = path.join(os.tmpdir(), `inject-test-legacy-${Date.now()}.md`);
  const legacyBody = `## Old Session\nlegacy ${secretShapedLine()}\n`;
  const cleanChunk = "\n## Session End\nclean recap, no secrets.\n";
  fs.writeFileSync(tmp, legacyBody + cleanChunk);
  try {
    assert.doesNotThrow(
      () => verifyJournalWritten(tmp, cleanChunk),
      "a clean append succeeds despite a pre-existing legacy secret elsewhere in the file",
    );
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("verifyJournalWritten: a torn/partial append (chunk not at the tail) fails", () => {
  const tmp = path.join(os.tmpdir(), `inject-test-torn-${Date.now()}.md`);
  // The on-disk tail does not match the chunk we claim to have appended.
  fs.writeFileSync(tmp, "## Session End\nonly half of the chunk landed");
  try {
    assert.throws(
      () => verifyJournalWritten(tmp, "## Session End\nthe full chunk that should be at the tail\n"),
      /torn or partial append/i,
    );
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("verifyJournalWritten: an appended chunk carrying only redaction MARKERS still passes", () => {
  const tmp = path.join(os.tmpdir(), `inject-test-marker-${Date.now()}.md`);
  // An already-redacted marker must not be re-flagged (idempotent redaction).
  const chunk = '## Session End\napi_key="[REDACTED:ENV_SECRET]"\n';
  fs.writeFileSync(tmp, chunk);
  try {
    assert.doesNotThrow(() => verifyJournalWritten(tmp, chunk));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("resolveJournalPath: clone_path does not affect zeos-side journal root", () => {
  const app = {
    app_id: "zero-echelon",
    local_path: "zero-echelon/",
    journal_location: "{repo}/session-journals/",
    repo: {
      url: "https://github.com/example-org/example-website",
      clone_path: "~/projects/example-website/",
    },
  };
  assert.equal(resolveJournalPath(app), `${ZEOS_JOURNALS_ROOT}/zero-echelon/`);
});

test("resolveJournalPath: clone_path without trailing slash does not affect zeos-side journal root", () => {
  const app = {
    app_id: "zero-echelon",
    local_path: "zero-echelon/",
    journal_location: "{repo}/session-journals/",
    repo: {
      url: "https://github.com/example-org/example-website",
      clone_path: "~/projects/example-website",
    },
  };
  assert.equal(resolveJournalPath(app), `${ZEOS_JOURNALS_ROOT}/zero-echelon/`);
});

test("resolveJournalPath: example-game resolves to zeos-side journal root", () => {
  const app = {
    app_id: "example-game",
    local_path: "example-game/",
    journal_location: "{repo}/session-journals/",
    repo: {
      url: "https://github.com/example-org/example-game-reborn",
      clone_path: "~/projects/example-game-reborn/",
    },
  };
  assert.equal(resolveJournalPath(app), `${ZEOS_JOURNALS_ROOT}/example-game/`);
});

test("resolveJournalPath: example-board resolves to zeos-side journal root", () => {
  const app = {
    app_id: "example-board",
    local_path: "example-board-tree/",
    journal_location: "{repo}/session-journals/",
    repo: {
      url: "https://github.com/example-org/example-utility",
      clone_path: "~/projects/example-utility/",
    },
  };
  assert.equal(resolveJournalPath(app), `${ZEOS_JOURNALS_ROOT}/example-board/`);
});

test("resolveJournalPath: app_id is the only journal routing key", () => {
  const app = {
    app_id: "foo",
    local_path: "foo/",
    journal_location: "{repo}/session-journals/",
    repo: {
      url: "https://github.com/x/foo",
      clone_path: "~/somewhere/else/",
    },
  };
  assert.equal(resolveJournalPath(app), `${ZEOS_JOURNALS_ROOT}/foo/`);
});

test("resolveJournalPath: example-app fallback uses zeos-side journal root", () => {
  const app = {
    app_id: "example-app",
    local_path: "example-app/",
    journal_location: "{repo}/session-journals/",
    repo: { url: "https://github.com/example-org/example-app" },
  };
  assert.equal(resolveJournalPath(app), `${ZEOS_JOURNALS_ROOT}/example-app/`);
});

test("resolveJournalPath: zeos-apps-only fallback uses zeos-side journal root", () => {
  const app = {
    app_id: "example-tracker",
    local_path: "example-tracker/",
    journal_location: "{repo}/session-journals/",
  };
  assert.equal(resolveJournalPath(app), `${ZEOS_JOURNALS_ROOT}/example-tracker/`);
});

test("regression: repo-backed registry entry routes to state-side journals", () => {
  // v1.2.0+ keeps journals under the state root (~/.zeos), not in project
  // repos, the zeos repo, or zeos-apps. Assert against the canonical constant
  // so the test stays correct under any ZEOS_STATE_ROOT override.
  const app = {
    app_id: "example-app",
    local_path: "example-app/",
    journal_location: "{repo}/session-journals/",
    repo: { url: "https://github.com/example-org/example-app", branch: "main" },
  };
  const result = resolveJournalPath(app);
  assert.equal(result.includes("zeos-apps"), false);
  assert.equal(result.includes("projects/zeos/journals"), false);
  assert.equal(result, `${ZEOS_JOURNALS_ROOT}/example-app/`);
});
