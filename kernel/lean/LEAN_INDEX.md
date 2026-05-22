# Skeleton Boot Index

## Overview

This directory contains **lean protocol files** — lightweight summaries of full zeos protocols. When `boot_mode: lean` is enabled in your profile, these files load at boot instead of full protocols.

**Token reduction:** ~83% (35,936 → 6,043 tokens)

**Functionality:** Zero loss. Agent reads full protocols on-demand when detail is needed.

---

## Skeleton Files

### SOUL_CORE.md (563 tokens)
**Replaces:** kernel/SOUL.md (2,221 tokens)
**Contains:** North star, kernel laws (names only), security hierarchy, values
**Full protocol:** Read kernel/SOUL.md when philosophical depth needed

### BOOT_PROTOCOL_SKELETON.md (861 tokens)
**Replaces:** kernel/BOOT_PROTOCOL.md (9,029 tokens)
**Contains:** Boot sequence outline, gate names, validation checklist
**Full protocol:** Read kernel/BOOT_PROTOCOL.md for detailed boot mechanics

### SHELL_PROTOCOL_SKELETON.md (567 tokens)
**Replaces:** modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md (15,807 tokens)
**Contains:** Command list with one-line descriptions, execution rules
**Full protocol:** Read modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md for command specifications

### CONTINUITY_PROTOCOL_SKELETON.md (473 tokens)
**Replaces:** modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md (6,914 tokens)
**Contains:** Continuity mode names, checkpoint concept, auto-checkpoint triggers
**Full protocol:** Read modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md for detailed persistence rules

---

## How Skeleton Boot Works

**At boot (boot_mode: lean):**
1. Load 4 lean files above (~2,500 tokens)
2. Load PROFILE.md (~2,000 tokens)
3. Load project-specific files (~1,500 tokens)
4. **Total: ~6,043 tokens** (vs 35,936 full)

**During session:**
- Agent uses lean for navigation (command names, concept awareness)
- When detail needed, agent reads full protocol directly
- Example: "Explain /snap flags" → Reads full SHELL_PROTOCOL.md

**Result:** Reduced initial load, full functionality preserved.

---

## Enabling Skeleton Boot

Add to your PROFILE.md frontmatter:

```yaml
---
profile_id: "yourname"
operator: "Your Name"
boot_mode: lean
---
```

Then restart: `/end` and start new session.

---

## When to Use

**Use lean boot when:**
- Working on projects with minimal protocol lookups
- Want faster boot times
- Context budget is tight
- Session quality maintained (verified)

**Use full boot when:**
- Learning zeos (need all details upfront)
- Session heavily references protocols
- Prefer everything preloaded

**Default:** Full boot (backward compatible)

---

*Skeleton Boot v1.0 — Smart index, full capability*
