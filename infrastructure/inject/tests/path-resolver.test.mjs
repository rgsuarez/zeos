import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ZEOS_APPS_ROOT,
  expandPath,
  resolveJournalPath,
  verifyJournalWritten,
} from "../dist/path-resolver.js";

test("resolveJournalPath: repo-backed app resolves {repo} to ~/projects/<app_id>/", () => {
  const app = {
    app_id: "awsaudit",
    local_path: "awsaudit/",
    journal_location: "{repo}/session-journals/",
    repo: { url: "https://github.com/zeroechelon/awsaudit" },
  };
  const result = resolveJournalPath(app);
  assert.equal(result, "~/projects/awsaudit/session-journals/");
});

test("resolveJournalPath: zeos-apps-only app (no repo) resolves to ZEOS_APPS_ROOT/<local_path>/", () => {
  const app = {
    app_id: "zeos-dev",
    local_path: "zeos-dev/",
    journal_location: "{repo}/session-journals/",
  };
  const result = resolveJournalPath(app);
  assert.equal(result, `${ZEOS_APPS_ROOT}/zeos-dev/session-journals/`);
});

test("resolveJournalPath: zeos-apps-only app with repo.url undefined falls back to ZEOS_APPS_ROOT", () => {
  const app = {
    app_id: "internal-tool",
    local_path: "internal-tool/",
    journal_location: "{repo}/session-journals/",
    repo: { branch: "main" },
  };
  const result = resolveJournalPath(app);
  assert.equal(result, `${ZEOS_APPS_ROOT}/internal-tool/session-journals/`);
});

test("resolveJournalPath: absolute literal path is preserved when no placeholder present", () => {
  const app = {
    app_id: "external",
    local_path: "external/",
    journal_location: "/var/log/zeos/external/",
  };
  const result = resolveJournalPath(app);
  assert.equal(result, "/var/log/zeos/external/");
});

test("resolveJournalPath: home-relative literal path is preserved", () => {
  const app = {
    app_id: "external",
    local_path: "external/",
    journal_location: "~/somewhere/else/",
  };
  const result = resolveJournalPath(app);
  assert.equal(result, "~/somewhere/else/");
});

test("resolveJournalPath: bare relative literal path is anchored to ZEOS_APPS_ROOT", () => {
  const app = {
    app_id: "external",
    local_path: "external/",
    journal_location: "external/journals/",
  };
  const result = resolveJournalPath(app);
  assert.equal(result, `${ZEOS_APPS_ROOT}/external/journals/`);
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

test("resolveJournalPath: clone_path overrides app_id-based convention", () => {
  const app = {
    app_id: "zero-echelon",
    local_path: "zero-echelon/",
    journal_location: "{repo}/session-journals/",
    repo: {
      url: "https://github.com/rgsuarez/zeroechelon-website",
      clone_path: "~/projects/zeroechelon-website/",
    },
  };
  assert.equal(resolveJournalPath(app), "~/projects/zeroechelon-website/session-journals/");
});

test("resolveJournalPath: clone_path normalizes missing trailing slash", () => {
  const app = {
    app_id: "zero-echelon",
    local_path: "zero-echelon/",
    journal_location: "{repo}/session-journals/",
    repo: {
      url: "https://github.com/rgsuarez/zeroechelon-website",
      clone_path: "~/projects/zeroechelon-website",
    },
  };
  assert.equal(resolveJournalPath(app), "~/projects/zeroechelon-website/session-journals/");
});

test("resolveJournalPath: swords-of-chaos resolves to swords-of-chaos-reborn", () => {
  const app = {
    app_id: "swords-of-chaos",
    local_path: "swords-of-chaos/",
    journal_location: "{repo}/session-journals/",
    repo: {
      url: "https://github.com/rgsuarez/swords-of-chaos-reborn",
      clone_path: "~/projects/swords-of-chaos-reborn/",
    },
  };
  assert.equal(resolveJournalPath(app), "~/projects/swords-of-chaos-reborn/session-journals/");
});

test("resolveJournalPath: ai-boardroom resolves to aib", () => {
  const app = {
    app_id: "ai-boardroom",
    local_path: "boardroom/",
    journal_location: "{repo}/session-journals/",
    repo: {
      url: "https://github.com/zeroechelon/aib",
      clone_path: "~/projects/aib/",
    },
  };
  assert.equal(resolveJournalPath(app), "~/projects/aib/session-journals/");
});

test("resolveJournalPath: clone_path takes precedence over repo.url even when app_id matches", () => {
  const app = {
    app_id: "foo",
    local_path: "foo/",
    journal_location: "{repo}/session-journals/",
    repo: {
      url: "https://github.com/x/foo",
      clone_path: "~/somewhere/else/",
    },
  };
  assert.equal(resolveJournalPath(app), "~/somewhere/else/session-journals/");
});

test("resolveJournalPath: awsaudit fallback (repo.url, no clone_path) still works", () => {
  const app = {
    app_id: "awsaudit",
    local_path: "awsaudit/",
    journal_location: "{repo}/session-journals/",
    repo: { url: "https://github.com/zeroechelon/awsaudit" },
  };
  assert.equal(resolveJournalPath(app), "~/projects/awsaudit/session-journals/");
});

test("resolveJournalPath: zeos-apps-only fallback (no repo) still works", () => {
  const app = {
    app_id: "emeet-tracker",
    local_path: "emeet-tracker/",
    journal_location: "{repo}/session-journals/",
  };
  assert.equal(resolveJournalPath(app), `${ZEOS_APPS_ROOT}/emeet-tracker/session-journals/`);
});

test("regression: awsaudit-style registry entry no longer routes to zeos-apps", () => {
  // Mirrors the bug reported by codex-copilot on 2026-04-28:
  // pre-fix: zeos-apps/awsaudit/session-journals/  ← wrong
  // post-fix: ~/projects/awsaudit/session-journals/  ← correct
  const app = {
    app_id: "awsaudit",
    local_path: "awsaudit/",
    journal_location: "{repo}/session-journals/",
    repo: { url: "https://github.com/zeroechelon/awsaudit", branch: "main" },
  };
  const result = resolveJournalPath(app);
  assert.equal(result.includes("zeos-apps"), false);
  assert.match(result, /^~\/projects\/awsaudit\/session-journals\/$/);
});
