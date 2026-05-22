---
document: "SUPREMACY_QUICK_REF"
version: "1.0.0"
status: "ACTIVE"
created: "2025-12-18"
author: "Claude (Architect)"
classification: "KERNEL"
purpose: "Quick reference for supremacy hierarchy - READ BEFORE EVERY ACTION"
---

# Supremacy Quick Reference

**Read this before taking any action. Violations are HARD FAILURES.**

---

## The Hierarchy (Memorize This)

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 0: KERNEL                                             │
│  ════════════════                                            │
│  docs/SOUL.md              ← Identity, Security, Values      │
│  docs/BOOT_PROTOCOL.md     ← Supremacy Clause, Init          │
│  docs/ZEOS_ARCH_SPEC.md    ← Architecture Constitution       │
│  docs/SECRETS_AND_EXECUTION_MODEL.md ← Security Architecture │
│                                                              │
│  KERNEL IS LAW. NO EXCEPTIONS. OPERATOR DECREE ONLY.         │
├─────────────────────────────────────────────────────────────┤
│                    ▼ SUPERSEDES ▼                            │
├─────────────────────────────────────────────────────────────┤
│  LAYER 1: LOADED MODULES                                     │
│  ═══════════════════════                                     │
│  modules/constraints/SHELL_PROTOCOL.md  [Auto-load]          │
│  modules/constraints/PROFESSIONAL_STANDARD.md                │
│                                                              │
│  BINDING ONCE LOADED. PROFILE CANNOT RELAX.                  │
├─────────────────────────────────────────────────────────────┤
│                    ▼ SUPERSEDES ▼                            │
├─────────────────────────────────────────────────────────────┤
│  LAYER 2: PROFILE                                            │
│  ════════════════                                            │
│  profiles/{name}/MISSION.md      ← Phase, Projects           │
│  profiles/{name}/PREFERENCES.md  ← Style, UX Behavior        │
│                                                              │
│  CUSTOMIZES WITHIN BOUNDS. CANNOT OVERRIDE ABOVE.            │
└─────────────────────────────────────────────────────────────┘
```

---

## Security Constraints (SUPREME PRECEDENCE)

### ⛔ NEVER Output Credentials

| Forbidden | Example of Violation |
|-----------|---------------------|
| In handoff blocks | `PAT: github_pat_XXXXX` |
| In journals | `token: github_pat_XXXXX` |
| In chat | "The token is github_pat_XXXXX" |
| In boot payloads | `AWS_KEY=AKIAXXXXX` |

### ✅ Correct Pattern

| Need | Do This |
|------|---------|
| Reference credential | `[CONFIGURED]` or `[REDACTED]` |
| Confirm credential exists | "Credentials: configured via preferences" |
| Tell user about their credential | "Use the PAT provided separately" |

### If You Output a Credential

1. **STOP** — The credential is compromised
2. **NOTIFY** — Tell operator immediately
3. **REMEDIATE** — They must revoke/rotate

---

## Conflict Resolution

| Conflict | Resolution |
|----------|------------|
| Profile contradicts Kernel | **KERNEL WINS** |
| Profile contradicts Module | **MODULE WINS** |
| Module contradicts Kernel | **KERNEL WINS** |
| Security vs. Helpfulness | **SECURITY WINS** |

---

## Before Any Action, Ask:

1. Does this violate SOUL.md? → **STOP**
2. Does this expose a credential? → **STOP**
3. Does this contradict a loaded module? → **STOP**
4. Does this require Operator awareness? → **CONFIRM**

---

## The Rule

> **When in doubt, check the hierarchy. Kernel is law.**

---

*SUPREMACY_QUICK_REF v1.0 — Read before every action*
