import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { getGitSnapshot } from "../dist/lib/git-snapshot.js";

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeos-git-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("getGitSnapshot: returns snapshot for valid repo", () => {
  const dir = tempRepo();
  try {
    const result = getGitSnapshot(dir);
    assert.match(result, /### Git Snapshot/);
    assert.match(result, /Branch:/);
    assert.match(result, /HEAD:/);
  } finally {
    cleanup(dir);
  }
});

test("getGitSnapshot: empty for non-repo path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeos-nonrepo-test-"));
  try {
    const result = getGitSnapshot(dir);
    assert.equal(result, "");
  } finally {
    cleanup(dir);
  }
});

test("getGitSnapshot: empty for nonexistent path", () => {
  const result = getGitSnapshot("/nonexistent/path/xyz");
  assert.equal(result, "");
});
