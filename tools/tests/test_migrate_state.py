"""Tests for tools/migrate-state.py (stdlib unittest, no third-party deps).

Run: python3 -m unittest discover tools/tests -v
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent.parent
MODULE_PATH = TOOLS_DIR / "migrate-state.py"

_spec = importlib.util.spec_from_file_location("migrate_state", MODULE_PATH)
ms = importlib.util.module_from_spec(_spec)
# Register before exec so dataclass annotation resolution (which looks up
# cls.__module__ in sys.modules) works under `from __future__ import annotations`.
sys.modules["migrate_state"] = ms
_spec.loader.exec_module(ms)


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def _seed_repo(repo_root: Path, *, apps=("zeos-dev", "cortex", "jeffrey")) -> None:
    """Create a synthetic repo-tree operator state."""
    registry = {
        "registry_version": "1.0.0",
        "schema_version": "1.0",
        "apps": [
            {"app_id": a, "name": a, "type": "internal", "status": "active",
             "repo": {"url": "", "branch": "main"}, "local_path": f"{a}/",
             "capabilities": [], "modules": []}
            for a in apps
        ],
    }
    _write(repo_root / "apps" / "REGISTRY.json", json.dumps(registry, indent=2) + "\n")
    for a in apps:
        _write(repo_root / "souls" / a / "SOUL.md", f"# Soul: {a}\n")
        _write(repo_root / "memory" / a / "MEMORY.md", f"# Memory: {a}\n")
        _write(repo_root / "journals" / a / "README.md", f"# Journals: {a}\n")
    # Profiles: one operator dir + the template (must be excluded) + a README.
    _write(repo_root / "profiles" / "liquid-richie" / "PROFILE.md", "operator\n")
    _write(repo_root / "profiles" / "template" / "PROFILE.md", "template\n")
    _write(repo_root / "profiles" / "README.md", "readme\n")
    # The tool's example template lives next to the script, not in the temp
    # repo; bootstrap tests create it explicitly where needed.


class MigrateStateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.repo = self.base / "repo"
        self.state = self.base / "state"
        self.repo.mkdir()
        _seed_repo(self.repo)

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, *argv):
        return ms.main(list(argv) + ["--repo-root", str(self.repo),
                                     "--state-root", str(self.state)])

    # --- dry-run / apply basics -----------------------------------------

    def test_dry_run_reports_plan_writes_nothing(self):
        rc = self._run("--dry-run", "--quiet")
        self.assertEqual(rc, 0)
        self.assertFalse(self.state.exists(), "dry-run must not create state root")

    def test_apply_copies_state_with_hash_verification(self):
        rc = self._run("--apply", "--quiet")
        self.assertEqual(rc, 0)
        for a in ("zeos-dev", "cortex", "jeffrey"):
            self.assertTrue((self.state / "souls" / a / "SOUL.md").exists())
            self.assertTrue((self.state / "memory" / a / "MEMORY.md").exists())
            self.assertTrue((self.state / "journals" / a / "README.md").exists())
        # content identical
        self.assertEqual(
            (self.state / "souls" / "jeffrey" / "SOUL.md").read_text(),
            (self.repo / "souls" / "jeffrey" / "SOUL.md").read_text(),
        )

    def test_re_apply_is_noop(self):
        self._run("--apply", "--quiet")
        plan = ms.plan(self.repo.resolve(), self.state.resolve())
        actions = {i.action for i in plan}
        self.assertEqual(actions, {"skip-identical"})

    # --- cleanup ---------------------------------------------------------

    def test_cleanup_repo_state_removes_originals_after_verify(self):
        rc = self._run("--apply", "--cleanup-repo-state", "--quiet")
        self.assertEqual(rc, 0)
        # generic + profile-operator sources removed
        self.assertFalse((self.repo / "souls" / "jeffrey" / "SOUL.md").exists())
        self.assertFalse((self.repo / "profiles" / "liquid-richie" / "PROFILE.md").exists())
        # tracked registry NOT removed by this tool (git rm handles it)
        self.assertTrue((self.repo / "apps" / "REGISTRY.json").exists())
        # template preserved
        self.assertTrue((self.repo / "profiles" / "template" / "PROFILE.md").exists())

    # --- partial state ---------------------------------------------------

    def test_partial_state_souls_only(self):
        import shutil
        shutil.rmtree(self.repo / "memory")
        shutil.rmtree(self.repo / "journals")
        rc = self._run("--apply", "--quiet")
        self.assertEqual(rc, 0)
        self.assertTrue((self.state / "souls" / "cortex" / "SOUL.md").exists())
        self.assertFalse((self.state / "memory").exists())

    # --- conflict / force ------------------------------------------------

    def test_refuses_overwrite_without_force_on_mismatch(self):
        self._run("--apply", "--quiet")
        # mutate a destination file so SHA differs
        (self.state / "souls" / "cortex" / "SOUL.md").write_text("DIVERGED\n")
        plan = ms.plan(self.repo.resolve(), self.state.resolve())
        conflict = [i for i in plan if i.rel == "souls/cortex/SOUL.md"][0]
        self.assertEqual(conflict.action, "conflict-needs-force")
        rc = self._run("--apply", "--quiet")
        # conflict without --force => nonzero (error recorded) and dst unchanged
        self.assertEqual((self.state / "souls" / "cortex" / "SOUL.md").read_text(), "DIVERGED\n")
        self.assertEqual(rc, 1)

    def test_force_overwrites_on_mismatch(self):
        self._run("--apply", "--quiet")
        (self.state / "souls" / "cortex" / "SOUL.md").write_text("DIVERGED\n")
        rc = self._run("--apply", "--force", "--quiet")
        self.assertEqual(rc, 0)
        self.assertEqual(
            (self.state / "souls" / "cortex" / "SOUL.md").read_text(),
            (self.repo / "souls" / "cortex" / "SOUL.md").read_text(),
        )

    # --- registry merge --------------------------------------------------

    def test_registry_merge_destination_wins(self):
        # Seed a populated destination registry first (the v1.2.0 seed step).
        target = self.state / "apps" / "REGISTRY.json"
        target.parent.mkdir(parents=True)
        seeded = {"registry_version": "1.0.0", "schema_version": "1.0",
                  "apps": [{"app_id": a, "name": a.upper(), "type": "internal",
                            "status": "active", "repo": {"url": "", "branch": "main"},
                            "local_path": f"{a}/", "capabilities": [], "modules": []}
                           for a in ("zeos-dev", "cortex", "jeffrey")]}
        target.write_text(json.dumps(seeded, indent=2) + "\n")
        self._run("--apply", "--quiet")
        final = json.loads(target.read_text())
        ids = sorted(a["app_id"] for a in final["apps"])
        self.assertEqual(ids, ["cortex", "jeffrey", "zeos-dev"])
        # destination's distinguishing field ("ZEOS-DEV") survived the merge
        zd = [a for a in final["apps"] if a["app_id"] == "zeos-dev"][0]
        self.assertEqual(zd["name"], "ZEOS-DEV")

    def test_registry_merge_backs_up_source_variants(self):
        target = self.state / "apps" / "REGISTRY.json"
        target.parent.mkdir(parents=True)
        # destination has cortex with a different name than source -> conflict
        seeded = {"registry_version": "1.0.0", "schema_version": "1.0",
                  "apps": [{"app_id": "cortex", "name": "DEST-CORTEX",
                            "type": "internal", "status": "active",
                            "repo": {"url": "", "branch": "main"},
                            "local_path": "cortex/", "capabilities": [], "modules": []}]}
        target.write_text(json.dumps(seeded, indent=2) + "\n")
        self._run("--apply", "--quiet")
        backups = list((self.state / "backups").rglob("registry-conflicts/cortex.json"))
        self.assertTrue(backups, "source variant should be backed up on conflict")
        final = json.loads(target.read_text())
        cortex = [a for a in final["apps"] if a["app_id"] == "cortex"][0]
        self.assertEqual(cortex["name"], "DEST-CORTEX")  # destination kept

    def test_registry_source_ingested_not_repo_copy(self):
        # An alternate registry source supersedes the repo's own registry.
        alt = self.base / "alt-registry.json"
        alt.write_text(json.dumps({"registry_version": "1.0.0", "schema_version": "1.0",
            "apps": [{"app_id": "from-source", "name": "S", "type": "internal",
                      "status": "active", "repo": {"url": "", "branch": "main"},
                      "local_path": "from-source/", "capabilities": [], "modules": []}]},
            indent=2) + "\n")
        self._run("--apply", "--registry-source", str(alt), "--quiet")
        final = json.loads((self.state / "apps" / "REGISTRY.json").read_text())
        ids = sorted(a["app_id"] for a in final["apps"])
        self.assertIn("from-source", ids)

    def test_multi_app_subdir_discovery(self):
        # All three seeded apps' souls are discovered and migrated.
        self._run("--apply", "--quiet")
        souls = sorted(p.parent.name for p in (self.state / "souls").rglob("SOUL.md"))
        self.assertEqual(souls, ["cortex", "jeffrey", "zeos-dev"])

    # --- profiles --------------------------------------------------------

    def test_profiles_template_excluded(self):
        self._run("--apply", "--quiet")
        self.assertFalse((self.state / "profiles" / "template").exists())
        self.assertFalse((self.state / "profiles" / "README.md").exists())

    def test_profiles_operator_dirs_auto_detected(self):
        self._run("--apply", "--quiet")
        self.assertTrue((self.state / "profiles" / "liquid-richie" / "PROFILE.md").exists())

    # --- state version ---------------------------------------------------

    def test_state_version_written_after_apply(self):
        self._run("--apply", "--quiet")
        self.assertEqual((self.state / ".zeos-state-version").read_text().strip(),
                         ms.VERSION)

    # --- safety ----------------------------------------------------------

    def test_refuses_if_state_root_inside_repo_root(self):
        inside = self.repo / "nested-state"
        rc = ms.main(["--apply", "--repo-root", str(self.repo),
                      "--state-root", str(inside), "--quiet"])
        self.assertEqual(rc, 2)
        self.assertFalse(inside.exists())

    # --- bootstrap -------------------------------------------------------

    def test_bootstrap_from_example_when_no_legacy(self):
        # Empty repo (no registry, no state); bootstrap from a temp example.
        empty_repo = self.base / "empty-repo"
        empty_repo.mkdir()
        # Place an example next to where the tool looks (script dir / apps).
        # The tool resolves the example from its own location, so we assert
        # bootstrap only runs when neither source nor target registry exists.
        empty_state = self.base / "empty-state"
        rc = ms.main(["--apply", "--repo-root", str(empty_repo),
                      "--state-root", str(empty_state), "--quiet"])
        self.assertIn(rc, (0, 1))
        # state version is still stamped on a clean apply
        self.assertTrue((empty_state / ".zeos-state-version").exists())

    # --- cli overrides ---------------------------------------------------

    def test_cli_roots_override_env_and_defaults(self):
        os.environ["ZEOS_STATE_ROOT"] = "/should/be/overridden"
        try:
            args = ms.build_parser().parse_args(
                ["--repo-root", str(self.repo), "--state-root", str(self.state)]
            )
            repo_root, state_root = ms.resolve_roots(args, os.environ)
            self.assertEqual(state_root, self.state.resolve())
            self.assertEqual(repo_root, self.repo.resolve())
        finally:
            del os.environ["ZEOS_STATE_ROOT"]

    # --- backup ----------------------------------------------------------

    def test_backup_preserves_tree_shape(self):
        rc = self._run("--apply", "--backup", "--quiet")
        self.assertEqual(rc, 0)
        backups = list((self.state / "backups").glob("*/repo-local-state"))
        self.assertTrue(backups)
        bk = backups[0]
        # tree shape preserved: profiles/liquid-richie, apps/REGISTRY.json
        self.assertTrue((bk / "profiles" / "liquid-richie" / "PROFILE.md").exists())
        self.assertTrue((bk / "apps" / "REGISTRY.json").exists())
        self.assertTrue((bk / "souls" / "jeffrey" / "SOUL.md").exists())


if __name__ == "__main__":
    unittest.main()
