---
module_id: "continuity-protocol-lean"
version: "3.2.0"
lean_version_of: "modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md"
full_protocol_uri: "zeos://protocols/continuity"
token_limit: "≤500 tokens"
---

# Continuity Protocol — Skeleton v3.2.0

**Purpose:** Continuous, automatic persistence that keeps zeos in Alive State without requiring explicit operator checkpoints.

**Core Principle:** Persistence is continuous, not ceremonial.

**Full Protocol:** [zeos://protocols/continuity](../../modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md) (3,600+ tokens)

---

## Modes

| Mode | Behavior | User |
|------|----------|------|
| LOCK | Zero writes | Sensitive |
| OFF | Manual only | Privacy |
| LIGHT | Artifacts/decisions | Executives |
| STANDARD | + state pulse (10m) | **Default** |
| HEAVY | + synopsis (5m) | Builders |

---

## Auto-Checkpoint (STANDARD/HEAVY)

**⛔ Mandatory protection against work loss**

**Triggers:** Time (10 min), activity (5+ changes), artifact complete, context warning (80%)

**Why:** Users forget. Sessions end abruptly. System protects automatically.

## Parallel Instances

**Instance ID:** the bare agent name (e.g., `claude`, `gemini`, `codex`); the `instance` frontmatter mirrors `agent` with no hash suffix

**Journal Stub:** Created immediately on `/project` load, enables early detection

**Protected Files:** MASTER_ROADMAP, blueprints, REGISTRY — timestamp check before modification

---

## The Bridge Rule

Every checkpoint answers: "What does a future session need to know that it can't derive from code, git, CLAUDE.md, or MEMORY.md?" No file lists. No command logs. Git has that. Capture state changes, open threads, and context that would be lost.

## Hard Constraints

Always enforced: No credentials in output, Kernel Supremacy, Audit Integrity, Blueprint Enforcement, Repo Boundary Logging

---

**Full specification:** [zeos://protocols/continuity](../../modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md)

*Continuity Protocol Skeleton — "Persistence is continuous, not ceremonial."*
