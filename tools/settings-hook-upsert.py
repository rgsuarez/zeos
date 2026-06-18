#!/usr/bin/env python3
"""Idempotently deep-merge a single PreCompact hook command into a Claude Code
settings.json, without clobbering existing user hooks or any other key.

Usage:
    settings-hook-upsert.py <settings.json> <command> <marker>

Behavior:
  - Creates the file (and parent dir) as {} if absent.
  - Touches ONLY hooks.PreCompact. Every other hook event (SessionStart,
    SessionEnd, PreToolUse, ...) and every other top-level settings key is left
    byte-for-byte untouched aside from JSON re-serialization.
  - Idempotent: a matcher-group whose command contains <marker> is treated as
    ours and refreshed in place; otherwise our entry is appended ALONGSIDE any
    existing PreCompact entries. Re-running never duplicates our entry.
  - The hook entry uses the standard Claude Code shape:
        {"hooks": [{"type": "command", "command": <command>}]}

This is extracted as a standalone unit (rather than inlined in install.sh) so it
can be unit-tested directly against a temp settings file.
"""

import json
import sys


def upsert(data, command, marker):
    """Pure transform: mutate-and-return the settings dict. Separated from I/O
    so tests can assert on the structure directly."""
    if not isinstance(data, dict):
        data = {}

    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        hooks = data["hooks"] = {}

    precompact = hooks.setdefault("PreCompact", [])
    if not isinstance(precompact, list):
        precompact = hooks["PreCompact"] = []

    entry = {"hooks": [{"type": "command", "command": command}]}

    def has_marker(group):
        if not isinstance(group, dict):
            return False
        for h in group.get("hooks", []) or []:
            if isinstance(h, dict) and marker in str(h.get("command", "")):
                return True
        return False

    ours_idx = next(
        (i for i, g in enumerate(precompact) if has_marker(g)), None
    )
    if ours_idx is None:
        precompact.append(entry)
    else:
        precompact[ours_idx] = entry

    return data


def main(argv):
    if len(argv) != 4:
        sys.stderr.write(
            "usage: settings-hook-upsert.py <settings.json> <command> <marker>\n"
        )
        return 2
    path, command, marker = argv[1:4]

    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        data = {}
    except Exception:
        # A corrupt settings file is not ours to silently discard; refuse rather
        # than overwrite a file we could not parse.
        sys.stderr.write(
            f"error: could not parse JSON at {path}; refusing to overwrite\n"
        )
        return 1

    data = upsert(data, command, marker)

    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
