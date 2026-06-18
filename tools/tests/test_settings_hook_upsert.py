"""Tests for tools/settings-hook-upsert.py (stdlib unittest).

Run: python3 -m unittest discover tools/tests -v

Covers the PreCompact hook deep-merge into a Claude Code settings.json:
  - net-new file creation,
  - NOT clobbering an existing hooks block (SessionStart/SessionEnd) or other
    top-level settings keys,
  - idempotent re-run (no duplicate entry),
  - the generated JSON parses.

All I/O is against a temp file; the real ~/.claude/settings.json is never touched.
"""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent.parent
MODULE_PATH = TOOLS_DIR / "settings-hook-upsert.py"

# The module filename has a hyphen, so load it by path rather than import name.
_spec = importlib.util.spec_from_file_location("settings_hook_upsert", MODULE_PATH)
shu = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shu)

COMMAND = "/home/u/projects/zeos/infrastructure/inject/bin/precompact-snap.sh"
MARKER = "precompact-snap.sh"


def precompact_commands(data):
    """All command strings registered under hooks.PreCompact."""
    cmds = []
    for group in data.get("hooks", {}).get("PreCompact", []):
        for h in group.get("hooks", []):
            cmds.append(h.get("command"))
    return cmds


class UpsertPureTransformTest(unittest.TestCase):
    def test_adds_precompact_entry_to_empty(self):
        out = shu.upsert({}, COMMAND, MARKER)
        self.assertEqual(precompact_commands(out), [COMMAND])
        # standard Claude Code shape
        entry = out["hooks"]["PreCompact"][0]
        self.assertEqual(entry["hooks"][0]["type"], "command")
        self.assertEqual(entry["hooks"][0]["command"], COMMAND)

    def test_preserves_existing_session_hooks_and_other_keys(self):
        existing = {
            "permissions": {"defaultMode": "auto"},
            "statusLine": {"type": "command", "command": "x"},
            "hooks": {
                "SessionStart": [
                    {"hooks": [{"type": "command", "command": "/other/sr-hook.sh"}]}
                ],
                "SessionEnd": [
                    {"hooks": [{"type": "command", "command": "/other/sr-hook.sh"}]}
                ],
            },
        }
        out = shu.upsert(existing, COMMAND, MARKER)
        # other top-level keys untouched
        self.assertEqual(out["permissions"], {"defaultMode": "auto"})
        self.assertEqual(out["statusLine"], {"type": "command", "command": "x"})
        # existing hook events untouched
        self.assertEqual(
            out["hooks"]["SessionStart"][0]["hooks"][0]["command"], "/other/sr-hook.sh"
        )
        self.assertEqual(
            out["hooks"]["SessionEnd"][0]["hooks"][0]["command"], "/other/sr-hook.sh"
        )
        # ours added alongside
        self.assertEqual(precompact_commands(out), [COMMAND])

    def test_idempotent_rerun_does_not_duplicate(self):
        out = shu.upsert({}, COMMAND, MARKER)
        out = shu.upsert(out, COMMAND, MARKER)
        out = shu.upsert(out, COMMAND, MARKER)
        self.assertEqual(precompact_commands(out), [COMMAND], "no duplicate on re-run")

    def test_refreshes_our_entry_in_place_when_command_path_changes(self):
        out = shu.upsert({}, COMMAND, MARKER)
        new_cmd = "/new/location/" + MARKER
        out = shu.upsert(out, new_cmd, MARKER)
        # still one entry, now the new command
        self.assertEqual(precompact_commands(out), [new_cmd])

    def test_preserves_a_foreign_precompact_entry_and_adds_ours(self):
        existing = {
            "hooks": {
                "PreCompact": [
                    {"hooks": [{"type": "command", "command": "/foreign/other.sh"}]}
                ]
            }
        }
        out = shu.upsert(existing, COMMAND, MARKER)
        cmds = precompact_commands(out)
        self.assertIn("/foreign/other.sh", cmds)
        self.assertIn(COMMAND, cmds)
        self.assertEqual(len(cmds), 2)

    def test_coerces_malformed_hooks_block_without_crashing(self):
        # hooks present but wrong type -> rebuilt; PreCompact present but wrong type
        out = shu.upsert({"hooks": []}, COMMAND, MARKER)
        self.assertEqual(precompact_commands(out), [COMMAND])
        out2 = shu.upsert({"hooks": {"PreCompact": "nope"}}, COMMAND, MARKER)
        self.assertEqual(precompact_commands(out2), [COMMAND])


class MainFileIoTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.settings = self.dir / "settings.json"

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, path=None):
        return shu.main(["settings-hook-upsert.py", str(path or self.settings), COMMAND, MARKER])

    def test_creates_net_new_file(self):
        self.assertFalse(self.settings.exists())
        rc = self._run()
        self.assertEqual(rc, 0)
        self.assertTrue(self.settings.exists())
        data = json.loads(self.settings.read_text())  # parses
        self.assertEqual(precompact_commands(data), [COMMAND])

    def test_rerun_against_file_is_noop_no_duplicate(self):
        self._run()
        first = self.settings.read_text()
        self._run()
        second = self.settings.read_text()
        self.assertEqual(first, second, "second run is byte-identical (idempotent)")
        data = json.loads(second)
        self.assertEqual(precompact_commands(data), [COMMAND])

    def test_does_not_clobber_existing_settings_on_disk(self):
        self.settings.write_text(
            json.dumps(
                {
                    "theme": "dark",
                    "hooks": {
                        "SessionEnd": [
                            {"hooks": [{"type": "command", "command": "/keep/me.sh"}]}
                        ]
                    },
                }
            )
        )
        rc = self._run()
        self.assertEqual(rc, 0)
        data = json.loads(self.settings.read_text())
        self.assertEqual(data["theme"], "dark")
        self.assertEqual(
            data["hooks"]["SessionEnd"][0]["hooks"][0]["command"], "/keep/me.sh"
        )
        self.assertEqual(precompact_commands(data), [COMMAND])

    def test_refuses_to_overwrite_unparseable_file(self):
        self.settings.write_text("{ this is not json")
        rc = self._run()
        self.assertEqual(rc, 1, "non-zero exit, file left intact")
        self.assertEqual(self.settings.read_text(), "{ this is not json")

    def test_generated_json_parses_and_has_expected_shape(self):
        self._run()
        data = json.loads(self.settings.read_text())
        entry = data["hooks"]["PreCompact"][0]
        self.assertIn("hooks", entry)
        self.assertEqual(entry["hooks"][0], {"type": "command", "command": COMMAND})


if __name__ == "__main__":
    unittest.main()
