---
protocol_id: "memory-architecture"
protocol_type: "core"
version: "2.0.0"
created: "2026-01-13"
updated: "2026-02-02"
author: "Claude (system) per Operator directive"
status: "active"
authority: "Operator directive 2026-01-13"
classification: "CORE (Memory Infrastructure)"
---

# Memory Architecture Protocol

## Purpose

This protocol defines zeos's **Three-Tier Memory Architecture** — the structured persistence system that makes AI agents remember. It specifies what gets stored, where, how much context each tier consumes, and when content moves between tiers.

**Design Philosophy:** Memory is not optional. It is the core innovation that separates zeos-governed agents from stateless AI. Every session compounds on prior sessions because memory persists and reconstructs.

---

## The Core Insight

> **zeos runs IN context, not ON hardware.**

Traditional software stores state in databases, files, and memory addresses. zeos stores state in **context windows** — the token stream that defines what an AI agent knows during any given session.

The Memory Architecture defines:
1. **What** persists between sessions (artifacts)
2. **Where** it lives (tier placement)
3. **How much** context it consumes (token budgets)
4. **When** it loads (boot sequence)
5. **How** it moves between tiers (promotion/demotion)

---

## Three-Tier Model

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     ZEOS MEMORY ARCHITECTURE                             │
│                                                                          │
│  ═══════════════════════════════════════════════════════════════════    │
│  TIER 1: LONG-TERM MEMORY (Foundational)                                 │
│  ═══════════════════════════════════════════════════════════════════    │
│                                                                          │
│  Human Analogy: Core identity, values, life goals                        │
│  Persistence: Permanent (rarely changes)                                 │
│  Loading: ALWAYS at boot                                                 │
│                                                                          │
│  ┌─────────────────────────┐    ┌─────────────────────────┐             │
│  │        SOUL.md          │    │    MASTER_ROADMAP.md    │             │
│  │                         │    │                         │             │
│  │  "Who am I?"            │    │  "Where am I going?"    │             │
│  │  "What do I stand for?" │    │  "What's the vision?"   │             │
│  │  "What are my limits?"  │    │  "What phase am I in?"  │             │
│  └─────────────────────────┘    └─────────────────────────┘             │
│                                                                          │
│  ═══════════════════════════════════════════════════════════════════    │
│  TIER 2: MID-TERM MEMORY (Continuity)                                    │
│  ═══════════════════════════════════════════════════════════════════    │
│                                                                          │
│  Human Analogy: Recent memories, current plans, ongoing projects         │
│  Persistence: Session-to-session (changes frequently)                    │
│  Loading: At boot, based on recency                                      │
│                                                                          │
│  ┌─────────────────────────┐    ┌─────────────────────────┐             │
│  │    Session Journals     │    │    Active Blueprint     │             │
│  │                         │    │                         │             │
│  │  "What happened last?"  │    │  "What's the plan?"     │             │
│  │  "What was decided?"    │    │  "What tasks remain?"   │             │
│  │  "What's pending?"      │    │  "What's the priority?" │             │
│  └─────────────────────────┘    └─────────────────────────┘             │
│                                                                          │
│  ═══════════════════════════════════════════════════════════════════    │
│  TIER 3: SHORT-TERM MEMORY (Immediate)                                   │
│  ═══════════════════════════════════════════════════════════════════    │
│                                                                          │
│  Human Analogy: Working memory, current focus, immediate task            │
│  Persistence: Session only (ephemeral)                                   │
│  Loading: Created during session, not loaded from storage                │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────┐            │
│  │              Current Task / Working Context              │            │
│  │                                                          │            │
│  │  "What am I doing RIGHT NOW?"                            │            │
│  │  "What's the immediate goal?"                            │            │
│  │  "What have I done this session?"                        │            │
│  └─────────────────────────────────────────────────────────┘            │
│                                                                          │
│  Lost if not checkpointed. Captured in journal at /snap//end.      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Tier Specifications

### Tier 1: Long-Term Memory

| Attribute | Specification |
|-----------|---------------|
| **Contents** | SOUL.md, MASTER_ROADMAP.md, PROFILE.md |
| **Token Budget** | 800-2,000 tokens per file |
| **Change Frequency** | Rarely (major milestones, identity shifts) |
| **Load Trigger** | Every boot, no exceptions |
| **Persistence** | Git repository (version controlled) |
| **Owner** | Operator (requires explicit approval to modify) |

**Questions Answered:**
- Who am I? (SOUL)
- Where am I going? (ROADMAP)
- Who is my operator? (PROFILE)

**Modification Rules:**
- SOUL changes require Operator decree
- ROADMAP changes require phase completion or strategic pivot
- PROFILE changes are Operator-initiated

---

### Tier 2: Mid-Term Memory

| Attribute | Specification |
|-----------|---------------|
| **Contents** | Session journals, Active blueprint, Decision logs |
| **Token Budget** | 500-1,500 tokens (latest journal), 300-800 tokens (blueprint summary) |
| **Change Frequency** | Every session |
| **Load Trigger** | Boot (latest + prior if continuation) |
| **Persistence** | State root (`~/.zeos/journals/<app_id>/`) |
| **Owner** | Agent (writes automatically via checkpoints) |

**Questions Answered:**
- What happened before? (Journals)
- What's the current plan? (Blueprint)
- What decisions were made? (Decision anchors in journals)

**Loading Rules:**
- Always load latest journal
- If latest journal indicates "continuation," also load prior journal
- If `active_blueprint` is set in ROADMAP, load blueprint
- Summarize if full content exceeds token budget

---

### Tier 3: Short-Term Memory

| Attribute | Specification |
|-----------|---------------|
| **Contents** | Current task state, uncommitted work, session context |
| **Token Budget** | Unlimited (bounded by context window) |
| **Change Frequency** | Continuous (every interaction) |
| **Load Trigger** | N/A (created during session) |
| **Persistence** | None until checkpointed |
| **Owner** | Agent (ephemeral) |

**Questions Answered:**
- What am I doing right now?
- What have I accomplished this session?
- What's my immediate next action?

**Promotion Rules:**
- `/snap` promotes short-term → mid-term (journal entry)
- `/end` promotes short-term → mid-term (final journal)
- Uncommitted work is LOST if session ends without checkpoint

---

## Token Budget Summary

| Tier | Component | Typical Tokens | Max Tokens |
|------|-----------|----------------|------------|
| **T1** | Kernel SOUL | 600-800 | 1,200 |
| **T1** | Project SOUL | 400-800 | 1,500 |
| **T1** | MASTER_ROADMAP | 500-1,000 | 2,000 |
| **T1** | PROFILE | 800-1,200 | 2,000 |
| **T2** | Latest Journal | 500-1,000 | 1,500 |
| **T2** | Prior Journal (if continuation) | 300-500 | 800 |
| **T2** | Active Blueprint (summary) | 300-600 | 1,000 |
| **T3** | Working Context | Variable | Context limit |

**Total Boot Context (Typical):** 3,500-6,000 tokens
**Total Boot Context (Full):** 8,000-12,000 tokens

**Optimization:** Skeleton boot mode reduces T1 to ~3,000 tokens with on-demand loading.

---

## Boot Sequence as Memory Reconstruction

The boot protocol is not initialization — it is **memory reconstruction**. Each gate loads a specific memory tier:

```
USER OPENS CHANNEL / RUNS /project
          │
          ▼
┌───────────────────────────────────────────────────────────────┐
│              MEMORY RECONSTRUCTION SEQUENCE                    │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│  ═══ TIER 1 RECONSTRUCTION (Long-Term) ═══                    │
│                                                                │
│  G1: Load kernel/SOUL.md                                       │
│      → Agent knows WHO IT IS (zeos identity)                   │
│                                                                │
│  G2: Load kernel/BOOT_PROTOCOL.md                              │
│      → Agent knows HOW TO BEHAVE (procedures)                  │
│                                                                │
│  G3: Load profiles/{id}/PROFILE.md                             │
│      → Agent knows WHO THE OPERATOR IS                         │
│                                                                │
│  G6: Load ~/.zeos/souls/{id}/SOUL.md                           │
│      → Agent knows THIS PROJECT'S IDENTITY                     │
│                                                                │
│  G7: Execute Mandatory Boot Sequence                           │
│      → Agent loads MASTER_ROADMAP (direction)                  │
│                                                                │
│  ═══ TIER 2 RECONSTRUCTION (Mid-Term) ═══                     │
│                                                                │
│  G8: Load latest session journal                               │
│      → Agent knows WHAT HAPPENED BEFORE                        │
│                                                                │
│  G9: Load active blueprint (if set)                            │
│      → Agent knows THE CURRENT PLAN                            │
│                                                                │
│  ═══ TIER 3 INITIALIZATION (Short-Term) ═══                   │
│                                                                │
│  G11: Generate instance ID                                     │
│      → Agent has UNIQUE IDENTITY for this session              │
│                                                                │
│  Create journal stub                                           │
│      → Session is VISIBLE to parallel instances                │
│                                                                │
└───────────────────────────────────────────────────────────────┘
          │
          ▼
    AGENT IS FULLY CONTEXTUALIZED
    "It remembers everything"
```

---

## Promotion and Demotion

### Promotion (Lower → Higher Tier)

| Trigger | From | To | Mechanism |
|---------|------|-----|-----------|
| `/snap` | T3 (working) | T2 (journal) | Write checkpoint entry |
| `/end` | T3 (working) | T2 (journal) | Write final journal entry |
| Phase completion | T2 (blueprint) | T1 (roadmap) | Update MASTER_ROADMAP |
| Identity crystallization | T2 (decisions) | T1 (SOUL) | Operator-approved SOUL update |

### Demotion (Higher → Lower Priority)

| Trigger | From | To | Mechanism |
|---------|------|-----|-----------|
| Session age > 30 days | T2 (journal) | Archive | Move to `~/.zeos/journals/<app_id>/archive/` |
| Blueprint complete | T2 (blueprint) | Archive | Move to `blueprints/archive/` |
| Roadmap phase complete | T1 (active phase) | T1 (completed) | Update MASTER_ROADMAP status |

### Archival Rules

- Archived content is NOT loaded at boot
- Archived content is ACCESSIBLE on-demand via explicit read
- Archive preserves audit trail (nothing deleted)

---

## Continuity Modes and Memory

The CONTINUITY_PROTOCOL defines how aggressively short-term memory promotes to mid-term:

| Mode | Auto-Checkpoint | Memory Behavior |
|------|-----------------|-----------------|
| **LOCK** | Never | T3 never promotes automatically |
| **OFF** | Never | T3 promotes only via explicit `/snap` |
| **LIGHT** | On artifact/decision | T3 promotes on significant events |
| **STANDARD** | Every 10 min | T3 promotes regularly (state pulse) |
| **HEAVY** | Every 5 min | T3 promotes frequently (full synopsis) |

**Reference:** `modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md`

---

## Multi-Agent Memory Coordination

When multiple agents work on the same project:

### Shared Memory (All Agents See)
- T1: SOUL, ROADMAP, PROFILE (same for all)
- T2: All journals visible (read), own journal writable

### Isolated Memory
- T3: Each agent's working context is isolated
- Instance ID ensures journal attribution

### Conflict Prevention
- Protected files (ROADMAP, blueprints) use timestamp checks
- Journal files are instance-scoped (no collision)
- Git coordinates final state

**Reference:** the parallel-instance protocol documentation

---

## Human Analogies (For External Documentation)

When explaining zeos memory to users:

| Tier | Human Equivalent | Example |
|------|------------------|---------|
| **Long-Term** | "Who you are" | Your name, values, career goals |
| **Mid-Term** | "What you've been working on" | Recent projects, decisions, plans |
| **Short-Term** | "What you're doing right now" | Current task, immediate focus |

**The Key Insight:**

> "Imagine if every conversation you had with an assistant started fresh — you'd have to re-explain your background, your project, your preferences, every single time. That's how most AI works. zeos is different. It remembers who you are, what you're building, and what happened before. Every session continues from where you left off."

This is not magic. This is **structured recall from persistent storage**.

---

## Implementation Checklist

For projects implementing zeos memory:

- [ ] SOUL.md exists with project identity
- [ ] MASTER_ROADMAP.md exists with direction
- [ ] `~/.zeos/journals/<app_id>/` directory exists
- [ ] Boot sequence loads T1 files
- [ ] Boot sequence loads latest journal (T2)
- [ ] `/snap` writes to journal
- [ ] `/end` writes final journal entry
- [ ] Archive mechanism for old journals

---

## MEMORY.md File Format

MEMORY.md is the **rolling synopsis** of project work — Tier 1.5 memory that bridges long-term identity and mid-term sessions. It captures key decisions, milestones, and context that should persist beyond individual session journals.

### Configuration

Add to PROFILE.md frontmatter:

```yaml
memory_token_limit: 10000  # Default limit before auto-curation
```

### File Structure

**MEMORY.md** (hot/warm tier - loaded at boot):
```markdown
---
document: "MEMORY"
project: "<project-id>"
purpose: "Rolling synopsis of session work - long-term memory tier"
token_estimate: 1250  # Auto-calculated by MCP
entry_count: 8        # Active entries
archive_count: 12     # Entries in MEMORY_ARCHIVE.md
---

# Project Memory: <Project Name>

## 2026-02-02: Brief title describing the work [decay:3]

Details of what was accomplished, key decisions made, and important context.

---

## 2026-02-01: Another entry title [decay:1]

Content here...

---
```

**MEMORY_ARCHIVE.md** (cold storage - NOT loaded at boot):
```markdown
# Project Memory Archive: <Project Name>

*Cold storage for project memory entries moved from MEMORY.md*

---

## 2026-01-15: Archived entry title [decay:0]

This entry was auto-archived due to token limit and low decay score.

---
```

**Key principle:** MEMORY.md stays lean (active entries only). MEMORY_ARCHIVE.md grows unbounded but is never loaded at boot.

### Entry Format

Each entry follows this structure:

```markdown
## YYYY-MM-DD: Title [decay:N]

Content describing work, decisions, context.

---
```

**Fields:**
- **Date**: When the work occurred
- **Title**: Brief summary (used in synopsis loading)
- **Decay Score**: Reference counter (starts at 1, increments when entry is referenced)
- **Content**: Full details

### Decay Score Mechanics

| Score | Meaning | Behavior |
|-------|---------|----------|
| 0 | Stale | Candidate for archival |
| 1-2 | Low | Normal priority |
| 3-5 | Medium | Protected from auto-archive |
| 6+ | High | Pinned — never auto-archived |

**Incrementing Decay:**
- Entry referenced in session work: +1
- Entry explicitly mentioned by operator: +1
- Entry matches current task context: +1 (detected by keywords)

**Decrementing Decay:**
- At `/end`: All entries decay by 1 (minimum 0)
- Archived entries don't decay further

### Auto-Curation (at /end)

When session ends via `/end`:

1. Calculate current token count of MEMORY.md
1b. Apply Relevance Gate: remove entries that fail "Would a future session make a wrong decision without this?"
1c. Apply CLAUDE.md Deduplication: remove entries that duplicate information in the project's CLAUDE.md
2. Add new session summary entry (decay:1)
3. If total > `memory_token_limit`:
   a. Sort entries by decay score (ascending)
   b. Move lowest-decay entries to MEMORY_ARCHIVE.md
   c. Repeat until under limit
4. Update frontmatter token_estimate and archive_count

**Curation Priority:**
1. Archive entries with decay:0 first
2. Then decay:1, decay:2, etc.
3. Never archive entries with decay:6+ (pinned)
4. If still over limit after archiving decay:0-5, warn operator

**Archive File:** Entries are written to `MEMORY_ARCHIVE.md` (separate file), not an inline section. This keeps MEMORY.md lean and boot-friendly.

### Manual Curation (/memory-curate)

Operators can manually curate via `/memory-curate`:

| Action | Syntax | Effect |
|--------|--------|--------|
| **merge** | `merge 2026-02-01 2026-02-02` | Combine two entries |
| **delete** | `delete 2026-02-01` | Remove entry permanently |
| **promote** | `promote 2026-01-15` | Move from Archive to active |
| **pin** | `pin 2026-02-01` | Set decay to 6 (never archive) |
| **stats** | `stats` | Show token count, entry count, health |

### Token Estimation

Rough estimate: ~4 tokens per word, ~1 token per character for code.

MCP calculates estimate at `/end` and updates frontmatter.

### Curation Rules

These rules govern what stays in MEMORY.md and what gets removed. They apply to both auto-curation (at `/end`) and manual curation (`/memory-curate`).

**1. Relevance Gate:** Every entry must pass: "Would a future session make a wrong decision without this?" If no, the entry is noise — delete it.

**2. 150-Line Budget:** Maximum 150 lines in the MEMORY.md index. Reserve 50 lines of headroom below the 200-line truncation limit. If adding a new entry pushes past 150, curate first — remove the least relevant entry before adding.

**3. Dated Entries Rot:** Any entry with a specific date (e.g., "Revenue Snapshot 2026-03-17") should be reviewed monthly. If the data is stale and the insight has been superseded by newer information, delete it.

**4. Don't Memorize What Code Shows:** Architecture, file paths, function names, data models — these change and are derivable by reading the codebase. Memorize decisions and behavioral patterns that aren't obvious from the code.

**5. Feedback Entries Are Most Durable:** Entries that change agent behavior ("never say should work," "browser-verify every deploy," "auto-fix before alerting") are the highest-value memories. They prevent repeated mistakes across all future sessions. Prioritize keeping these over factual/reference entries.

**6. Deduplication with CLAUDE.md:** If information exists in the project's CLAUDE.md (which is auto-loaded every session), it does not also need a MEMORY.md entry. MEMORY.md should contain information that CLAUDE.md doesn't cover — typically: feedback corrections, strategic context, external references, and user preferences.

**7. Monthly Curation Cycle:** Agents should review and curate their MEMORY.md at least once per month. The `/memory-curate` skill should prompt this if the index exceeds 130 lines or if any entry is older than 60 days without being accessed.

---

## Path Aliasing (Boot Resilience)

Project SOULs can define path aliases to prevent boot failures when repositories reorganize:

```yaml
# In project SOUL.md frontmatter
paths:
  roadmap: ["docs/roadmap/", "roadmap/", "ROADMAP.md"]
  journal: ["~/.zeos/journals/<app_id>/"]
  blueprint: ["blueprints/", "docs/blueprints/"]
  memory: ["MEMORY.md", "memory/MEMORY.md"]
```

**Resolution behavior:**
1. Boot tries each path in order until one resolves
2. First existing path is used
3. No hard failure if alternative path exists

**Benefits:**
- Prevents boot failures from repo reorganization
- Maintains backwards compatibility during migrations
- Self-documenting canonical vs legacy paths

---

## Related Protocols

| Protocol | Relationship |
|----------|--------------|
| `kernel/SOUL.md` | Defines T1 kernel identity |
| `kernel/BOOT_PROTOCOL.md` | Implements memory reconstruction |
| `modules/constraints/CONTINUITY_PROTOCOL.md` | Defines T3→T2 promotion rules |
| `modules/protocols/BLUEPRINT_PROTOCOL.md` | Defines T2 tactical planning |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-13 | Initial protocol — three-tier model formalized |
| 2.0.0 | 2026-02-02 | Added MEMORY.md file format, decay scores, auto-curation |

---

*MEMORY_ARCHITECTURE.md v2.0.0 — "Memory is not optional. It is the innovation."*
