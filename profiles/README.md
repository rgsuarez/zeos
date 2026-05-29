# zeos Profiles

This directory contains operator-specific configurations for zeos. Each profile customizes the zeos experience for a specific operator without modifying the universal Kernel.

## The Supremacy Clause

```
KERNEL > PROFILE

If a profile conflicts with Kernel documents (SOUL.md, ZEOS_ARCH_SPEC.md),
the Kernel wins. Profiles can be MORE restrictive than the Kernel,
but never LESS restrictive.
```

## Directory Structure

```
profiles/
├── README.md           # This file
└── template/           # Template for new operators
    └── PROFILE.md
```

The public starter ships with `template/` only. As of v1.2.0 your profile is operator state: it lives at `~/.zeos/profiles/<name>/` (outside any repo, env `ZEOS_STATE_ROOT`), created by copying the template and customizing.

## Creating Your Profile

1. **Copy the template into the state root:**
   ```bash
   mkdir -p ~/.zeos/profiles
   cp -r profiles/template ~/.zeos/profiles/operator
   ```

2. **Customize `PROFILE.md`:**
   - Set your profile_id, name, callsign (optional)
   - Define your current phase and objectives
   - List your active projects
   - Configure communication preferences
   - Set boot_mode (`lean` is default)

3. **Boot zeos with your profile:**
   ```
   /zeos
   ```

   When no profile is specified, zeos looks for the first profile under `~/.zeos/profiles/`. Otherwise specify explicitly.

Session journals are NOT stored under the profile. They live per-project at `~/.zeos/journals/<app_id>/`, written by `/snap` and `/end`.

## Profile Contents

| File | Purpose | Required |
|------|---------|----------|
| `PROFILE.md` | Identity, phase, preferences, technical context | Yes |
| `context/` | Project-specific context packs | Optional |

## Boot Default

When zeos boots, it loads the first non-template profile under `profiles/`. If multiple non-template profiles exist, specify explicitly:

```
"Boot zeos with profile: <name>"
```

---

*See `kernel/BOOT_PROTOCOL.md` for the full profile loading specification.*
