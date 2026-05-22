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

The public starter ships with `template/` only. Your profile lives at `profiles/operator/` — created by copying the template and customizing.

## Creating Your Profile

1. **Copy the template:**
   ```bash
   cp -r profiles/template profiles/operator
   ```

2. **Customize `PROFILE.md`:**
   - Set your profile_id, name, callsign (optional)
   - Define your current phase and objectives
   - List your active projects
   - Configure communication preferences
   - Set boot_mode (`lean` is default)

3. **Create session-journals directory (optional):**
   ```bash
   mkdir -p profiles/operator/session-journals/claude
   ```

4. **Boot zeos with your profile:**
   ```
   /zeos
   ```

   When no profile is specified, zeos will look for `profiles/operator/` if it's the only non-template profile present. Otherwise specify explicitly.

## Profile Contents

| File | Purpose | Required |
|------|---------|----------|
| `PROFILE.md` | Identity, phase, preferences, technical context | Yes |
| `session-journals/` | Your session history by agent | Recommended |
| `context/` | Project-specific context packs | Optional |

## Boot Default

When zeos boots, it loads the first non-template profile under `profiles/`. If multiple non-template profiles exist, specify explicitly:

```
"Boot zeos with profile: <name>"
```

---

*See `kernel/BOOT_PROTOCOL.md` for the full profile loading specification.*
