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


class SettingsShapeError(Exception):
    """Raised when settings.json has a `hooks` or `hooks.PreCompact` of an
    unexpected type. Coercing those to {}/[] would silently DROP existing hook
    events (SessionStart/SessionEnd) or foreign PreCompact entries, so we refuse
    and leave the file untouched - the same posture as an unparseable file."""


def upsert(data, command, marker):
    """Pure transform: mutate-and-return the settings dict. Separated from I/O
    so tests can assert on the structure directly.

    Refuses (raises SettingsShapeError) rather than coercing when `hooks` is not
    a dict or `hooks.PreCompact` is not a list, because replacing a corrupt shape
    with {}/[] would silently discard sibling hooks the operator already has."""
    if not isinstance(data, dict):
        # A non-object top-level settings document is not something we can safely
        # merge into; treat it like an unexpected shape rather than overwrite it.
        raise SettingsShapeError(
            "settings root is not a JSON object; refusing to overwrite"
        )

    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise SettingsShapeError(
            "hooks is present but not an object; refusing to overwrite "
            "(would drop existing hooks)"
        )

    precompact = hooks.setdefault("PreCompact", [])
    if not isinstance(precompact, list):
        raise SettingsShapeError(
            "hooks.PreCompact is present but not a list; refusing to overwrite "
            "(would drop existing PreCompact entries)"
        )

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

    try:
        data = upsert(data, command, marker)
    except SettingsShapeError as exc:
        # Unexpected hooks/PreCompact shape: refuse and leave the file untouched
        # (the file is not opened for write until upsert succeeds), mirroring the
        # unparseable-JSON refusal above. Non-zero exit so the installer does not
        # claim the hook was wired.
        sys.stderr.write(f"error: {exc} at {path}\n")
        return 1

    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
