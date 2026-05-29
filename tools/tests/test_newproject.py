"""Tests for tools/newproject.py v1.2.0 state-root behavior (stdlib unittest).

Run: python3 -m unittest discover tools/tests -v
"""

import importlib
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent.parent


def _load_newproject(state_root: Path):
    """(Re)load newproject.py with ZEOS_STATE_ROOT pointed at state_root.

    The module computes its path constants at import time from the env, so we
    set the env then load/reload to pick up the temp state root.
    """
    os.environ["ZEOS_STATE_ROOT"] = str(state_root)
    if str(TOOLS_DIR) not in sys.path:
        sys.path.insert(0, str(TOOLS_DIR))
    if "newproject" in sys.modules:
        return importlib.reload(sys.modules["newproject"])
    return importlib.import_module("newproject")


class NewProjectStateRootTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.state = self.base / "state"
        self.proj = self.base / "proj"
        self.np = _load_newproject(self.state)

    def tearDown(self):
        os.environ.pop("ZEOS_STATE_ROOT", None)
        self._tmp.cleanup()

    def test_scaffold_writes_to_zeos_state_root(self):
        self.np.scaffold_zeos_side("alpha", "Alpha", "internal", self.proj)
        self.assertTrue((self.state / "souls" / "alpha" / "SOUL.md").exists())
        self.assertTrue((self.state / "memory" / "alpha" / "MEMORY.md").exists())
        self.assertTrue((self.state / "journals" / "alpha" / "README.md").exists())
        self.assertTrue((self.state / "roadmaps" / "alpha" / "MASTER_ROADMAP.md").exists())

    def test_no_overwrite_on_existing_soul(self):
        soul = self.state / "souls" / "alpha" / "SOUL.md"
        soul.parent.mkdir(parents=True)
        soul.write_text("OPERATOR EDITED\n")
        self.np.scaffold_zeos_side("alpha", "Alpha", "internal", self.proj)
        self.assertEqual(soul.read_text(), "OPERATOR EDITED\n")

    def test_no_overwrite_on_existing_roadmap(self):
        rm = self.state / "roadmaps" / "alpha" / "MASTER_ROADMAP.md"
        rm.parent.mkdir(parents=True)
        rm.write_text("OPERATOR ROADMAP\n")
        self.np.scaffold_roadmap("alpha", "Alpha", "internal")
        self.assertEqual(rm.read_text(), "OPERATOR ROADMAP\n")

    def test_roadmap_template_has_all_ten_sections(self):
        self.np.scaffold_roadmap("alpha", "Alpha", "internal")
        body = (self.state / "roadmaps" / "alpha" / "MASTER_ROADMAP.md").read_text()
        # The 10 required content elements from the Cortex finding.
        self.assertIn("project: alpha", body)             # app_id
        self.assertIn("# Master Roadmap: Alpha", body)     # name
        self.assertIn('status: "draft"', body)             # document status
        self.assertIn("created:", body)                    # created timestamp
        self.assertIn("last_updated:", body)               # last-updated timestamp
        self.assertIn("## North Star / Desired End State", body)
        self.assertIn("## Intent", body)                   # the "why"
        self.assertIn("## Roadmap Phases", body)
        self.assertIn("## Current Milestone", body)
        self.assertIn("## Out of Scope / Not Yet", body)
        self.assertIn("## Decision Log", body)
        self.assertIn("## Change Discipline", body)

    def test_no_project_repo_roadmap_writes(self):
        # The roadmap is state-side only; nothing roadmap-shaped lands in the
        # project repo (only CLAUDE.md belongs there).
        self.np.scaffold_zeos_side("alpha", "Alpha", "internal", self.proj)
        self.np.scaffold_project_claude_md(self.proj, "alpha", "Alpha", "internal")
        self.assertTrue((self.proj / "CLAUDE.md").exists())
        self.assertFalse((self.proj / "MASTER_ROADMAP.md").exists())
        self.assertFalse((self.proj / "docs" / "MASTER_ROADMAP.md").exists())

    def test_no_commit_flag_is_compatibility_noop(self):
        ok, detail = self.np.git_commit_registry("alpha")
        self.assertFalse(ok)
        self.assertIn("operator-local", detail)

    def test_registry_entry_appended_to_state_root(self):
        reg = self.np.load_registry()           # bootstraps empty on fresh root
        entry = self.np.build_entry("alpha", "Alpha", "internal", "", self.proj)
        reg.setdefault("apps", []).append(entry)
        self.np.save_registry(reg)
        target = self.state / "apps" / "REGISTRY.json"
        self.assertTrue(target.exists())
        import json
        got = json.loads(target.read_text())
        self.assertEqual([a["app_id"] for a in got["apps"]], ["alpha"])


if __name__ == "__main__":
    unittest.main()
