---
document: "ZEOS_PROTOCOL_SPEC"
version: "1.0.0"
status: "released"
created: "2026-02-10"
authors: ["my-org"]
license: "Apache-2.0"
---

# zeos Protocol Specification v1.0.0

> Memory infrastructure for AI agents.

zeos is a governance and persistence protocol for AI agents. It runs IN context, not ON hardware. When an agent boots with zeos, it becomes a zeos-governed agent — operating under kernel law with persistent, compounding memory.

---

## 1. Boot Protocol

An agent initializes by loading context in strict sequence. Each gate must be satisfied before proceeding.

| Gate | Content | Required |
|------|---------|----------|
| G1 | **SOUL** — Agent/project identity, principles, constraints | MANDATORY |
| G2 | **Boot Protocol** — This sequence definition | MANDATORY |
| G3 | **Profile** — Operator preferences and configuration | MANDATORY |
| G4 | **Shell Protocol** — Command vocabulary | MANDATORY |
| G5 | **Continuity Protocol** — Session persistence rules | MANDATORY |
| G6 | **Project SOUL** — Project-specific identity (if loading project) | FATAL on fail |
| G7 | **Memory** — MEMORY.md synopsis + recent session journals | Non-fatal |
| G8 | **Blueprint** — Active tactical plan (if set) | Non-fatal |

**Post-boot validation:** The agent must be able to answer: (1) What is my identity? (2) Who is the operator? (3) What commands are available? (4) What happened in the last session?

**Boot modes:**
- **Lean** (default, ~6K tokens): Skeleton kernel files for fast context loading
- **Full** (~35K tokens): Complete protocol files for governance-intensive work

---

## 2. Three-Tier Memory Model

Memory is organized in three tiers analogous to human cognition:

| Tier | Content | Persistence | Question Answered |
|------|---------|-------------|-------------------|
| **T1: Long-Term** | SOUL, MEMORY.md | Permanent / rolling synopsis | "Who am I? What do I know?" |
| **T2: Mid-Term** | Session journals, blueprints | Session-scoped, summarized | "What happened before?" |
| **T3: Short-Term** | Working state | Ephemeral, checkpointed | "What am I doing now?" |

### Memory Entries

Each MEMORY.md entry carries a **decay score** (0-6):

| Score | Behavior |
|-------|----------|
| 0 | Auto-archive candidate |
| 1-2 | Low priority, archive within 1-2 sessions |
| 3 | Default for new entries (survives ~3 sessions) |
| 4-5 | High priority, SOUL promotion candidate |
| 6 | **Pinned** — immune to auto-archive |

**Curation rules:**
- Each session decrements all non-pinned decay scores by 1
- When MEMORY.md exceeds token budget, lowest-decay entries archive first
- Pinned entries (decay ≥ 6) never auto-archive
- Archived entries move to MEMORY_ARCHIVE.md (cold storage)
- Default token budget: 10,000 tokens (configurable per profile)

### Continuity Digest

Generated at session end, stored at top of MEMORY.md:

```
## Continuity Digest
### Last 3 Sessions — one-line summaries
### Open Threads — unresolved items
### Decisions/Constraints — key decisions from this session
### Next Actions — ordered handoff steps
```

---

## 3. Session Lifecycle

Sessions follow a deterministic state machine: **create → snap → end**.

### Create (on project load)
- Generate journal stub: `{YYYY-MM-DD}-{NNN}-{agent}.md`
- Compound key `{project_id}::{agent}` isolates parallel agents
- Check for parallel instances (other active journals from today)

### Snap (checkpoint)
- Append checkpoint to journal with timestamp and delta
- Extract entities (decisions, references) for knowledge graph
- Continuity modes control auto-checkpoint frequency:
  - STANDARD: every 10 minutes
  - HEAVY: every 5 minutes
  - OFF/LIGHT: manual only

### End (session close)
- Mark journal status as `complete`
- Append final entry: summary + delta + next_actions
- Create MEMORY.md entry (decay: 3)
- Generate continuity digest from last 3 sessions
- Auto-curate if over token budget
- Output restartable handoff block

**Invariant:** A session that ends without durable state is a system failure.

---

## 4. Governance Hierarchy

The supremacy hierarchy is non-invertible. Conflicts resolve top-down:

```
KERNEL (SOUL.md, Boot Protocol) — immutable law
    ↓ supersedes
MODULES (constraints, protocols) — binding rules
    ↓ supersedes
PROFILE (operator preferences) — customization
    ↓ supersedes
SESSION (ephemeral work) — temporary state
```

### Kernel Law (Hard-Coded Principles)

1. **Operator Authority** — Humans decide. Agents advise and execute.
2. **Truth Over Theater** — Never claim unverified capabilities.
3. **Dissent Preserved** — Minority opinions surface explicitly.
4. **Systems Over Tasks** — Build infrastructure, not chores.
5. **Persistence Is Continuous** — The system stays alive by default.
6. **Handoff Is Survival** — Session without durable state = failure.

### Values Hierarchy (Conflict Resolution Order)

Safety > Security > Operator Authority > Truth > Persistence > Capability Growth > Efficiency

---

## 5. Security Constraints

These override ALL other considerations.

**Credential exclusion zones** — credentials NEVER appear in:
- Session journals
- Handoff blocks
- Boot payloads
- Chat output
- Committed files

**Pre-scan rule:** All writes are scanned for credential patterns (API keys, tokens, passwords, secrets, private keys). Matches are redacted before persistence.

**Violation response:** Assume compromise → stop → notify operator → remediate → add prevention.

---

## 6. Entity Model

Knowledge graph entities for structured memory storage:

| Entity | Maps To | Persistence |
|--------|---------|-------------|
| **Soul** | Project/agent identity, principles, constraints | T1: permanent |
| **Decision** | Architectural choice with rationale + alternatives | T1-T2: high decay |
| **Memory** | Knowledge entry with decay score | T2: curated |
| **Journal** | Session checkpoint (delta, summary, next_actions) | T2: episodic |
| **Agent** | Multi-agent registry entry (role, team, state) | T3: runtime |

Entities are stored as episodes in a temporal knowledge graph. The graph engine auto-extracts relationships between entities and supports hybrid search (semantic + keyword + graph traversal).

---

## 7. Multi-Agent Coordination

Multiple agents can operate on the same project simultaneously.

**Isolation:** Compound key `{project_id}::{agent}` prevents journal collisions.
**Coordination:** Overseer relay provides team dispatch, heartbeats, and task ACKs.
**Rotation:** Phoenix Mode enables zero-downtime agent handover with digest transfer.

---

*zeos Protocol Spec v1.0.0 — "Your agents remember."*
