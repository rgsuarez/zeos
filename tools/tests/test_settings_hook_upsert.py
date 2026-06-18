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

    def test_refuses_corrupt_hooks_or_precompact_shape_instead_of_coercing(self):
        # A non-dict `hooks` or a non-list `PreCompact` must NOT be silently
        # replaced (that would drop sibling SessionStart/SessionEnd). The pure
        # transform raises so the I/O layer can refuse and leave the file intact.
        with self.assertRaises(shu.SettingsShapeError):
            shu.upsert({"hooks": []}, COMMAND, MARKER)
        with self.assertRaises(shu.SettingsShapeError):
            shu.upsert({"hooks": {"PreCompact": "nope"}}, COMMAND, MARKER)
        # A non-object settings root is likewise refused, not overwritten.
        with self.assertRaises(shu.SettingsShapeError):
            shu.upsert(["not", "a", "dict"], COMMAND, MARKER)

    def test_refusal_does_not_drop_sibling_hooks(self):
        # Prove the dropped-data risk is real: the corrupt input carries a
        # SessionEnd we must not lose. The transform refuses (raises) rather than
        # returning a dict that silently discards SessionEnd.
        corrupt = {
            "hooks": {
                "SessionEnd": [
                    {"hooks": [{"type": "command", "command": "/keep/me.sh"}]}
                ],
                "PreCompact": "corrupt-not-a-list",
            }
        }
        with self.assertRaises(shu.SettingsShapeError):
            shu.upsert(corrupt, COMMAND, MARKER)


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

    def test_refuses_corrupt_hooks_shape_file_left_byte_unchanged(self):
        # `hooks` present but a non-dict: parseable JSON, but coercing it would
        # drop SessionStart/SessionEnd. The tool must leave the file byte-for-byte
        # unchanged and exit non-zero (auto-capture off, nothing clobbered).
        original = json.dumps(
            {
                "theme": "dark",
                "hooks": ["this", "is", "not", "a", "dict"],
            }
        )
        self.settings.write_text(original)
        rc = self._run()
        self.assertEqual(rc, 1, "non-zero exit on corrupt hooks shape")
        self.assertEqual(
            self.settings.read_text(), original, "file left byte-for-byte unchanged"
        )

    def test_refuses_corrupt_precompact_shape_preserving_session_hooks(self):
        # `hooks.PreCompact` is a non-list while real SessionStart/SessionEnd
        # exist alongside. The tool must refuse and leave those siblings intact.
        original = json.dumps(
            {
                "hooks": {
                    "SessionStart": [
                        {"hooks": [{"type": "command", "command": "/keep/start.sh"}]}
                    ],
                    "SessionEnd": [
                        {"hooks": [{"type": "command", "command": "/keep/end.sh"}]}
                    ],
                    "PreCompact": "corrupt-not-a-list",
                }
            }
        )
        self.settings.write_text(original)
        rc = self._run()
        self.assertEqual(rc, 1, "non-zero exit on corrupt PreCompact shape")
        self.assertEqual(
            self.settings.read_text(), original, "file untouched; SessionStart/End survive"
        )
        # And confirm the surviving file still carries the session hooks.
        data = json.loads(self.settings.read_text())
        self.assertEqual(
            data["hooks"]["SessionStart"][0]["hooks"][0]["command"], "/keep/start.sh"
        )
        self.assertEqual(
            data["hooks"]["SessionEnd"][0]["hooks"][0]["command"], "/keep/end.sh"
        )

    def test_generated_json_parses_and_has_expected_shape(self):
        self._run()
        data = json.loads(self.settings.read_text())
        entry = data["hooks"]["PreCompact"][0]
        self.assertIn("hooks", entry)
        self.assertEqual(entry["hooks"][0], {"type": "command", "command": COMMAND})


if __name__ == "__main__":
    unittest.main()
