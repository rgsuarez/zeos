---
document: "HANDOVER_DIGEST_SPEC"
version: "1.0.0"
status: "APPROVED"
created: "2026-02-02"
authors: ["claude-1", "codex-1", "gemini-1"]
reviewers: ["codex-1", "gemini-1"]
classification: "PROTOCOL SPECIFICATION"
---

# Handover Digest Specification v1.0.0

> **Purpose:** Define the contract for session continuity handovers between Primary and Shadow agents in Continuous Mode (Phoenix Mode).

---

## Overview

The Handover Digest is the payload that enables seamless session rotation. It captures the Primary agent's complete mental model, working state, and uncommitted changes so Shadow can continue without context loss.

**Design Principles:**
- Digest is synthesized by **Monitor** (unbiased observer with full session history)
- Primary **ACKs** digest accuracy before handover completes
- Shadow **validates** understanding via Intent Statement
- Secrets are **redacted** before transmission
- Size is **capped** to fit Shadow's context budget

---

## Message Correlation

All messages in a handover sequence MUST include a `rotation_id` (UUID) for correlation. This prevents out-of-order or duplicate message confusion.

```yaml
rotation_id: "<uuid4>"  # REQUIRED in all 7 message types
```

**Correlation Rules:**
- Monitor generates `rotation_id` when initiating handover
- All subsequent messages in the sequence use the same `rotation_id`
- Messages with mismatched `rotation_id` are ignored
- `rotation_id` is logged for audit trail

---

## Handshake Protocol

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   MONITOR   │         │   PRIMARY   │         │   SHADOW    │
│  (Gemini)   │         │  (Claude)   │         │  (Claude)   │
└──────┬──────┘         └──────┬──────┘         └──────┬──────┘
       │                       │                       │
       │  [70% context]        │                       │
       │──── WARM_SHADOW ─────────────────────────────►│
       │                       │                       │
       │                       │       READY_FOR_DIGEST│
       │◄──────────────────────────────────────────────│
       │                       │                       │
       │  [80% context]        │                       │
       │  Synthesize digest    │                       │
       │                       │                       │
       │──── HANDOFF_DIGEST ──────────────────────────►│
       │                       │                       │
       │                       │       INTENT_STATEMENT│
       │◄──────────────────────────────────────────────│
       │                       │                       │
       │  Forward to Primary   │                       │
       │────────────────────►  │                       │
       │                       │                       │
       │   FINAL_HANDOVER_ACK  │                       │
       │◄───────────────────── │                       │
       │                       │                       │
       │──── SWITCH_ROUTE ────►│ [Proxy switches]      │
       │                       │                       │
       │                       │──── /end (background) │
       │                       │                       │
       │   SESSION_CLOSED      │                       │
       │◄───────────────────── │                       │
       │                       │                       │
```

---

## Message Schemas

### WARM_SHADOW

Sent by Monitor to Shadow when Primary reaches 70% context threshold.

```yaml
message_type: "WARM_SHADOW"
rotation_id: "<uuid4>"
timestamp: "<ISO8601>"
handoff_intent:
  reason: "context_high" | "manual" | "error"
  threshold_pct: 70
project_id: "<project>"
profile: "<profile>"
prewarm:
  load_level: "light" | "standard"
  include:
    - "kernel"
    - "profile"
    - "project_soul"
    - "memory_hot"
  exclude:
    - "full_journals"
    - "blueprints"
requested_ready_by: "<ISO8601>"
```

### READY_FOR_DIGEST

Sent by Shadow to Monitor when prewarm complete.

```yaml
message_type: "READY_FOR_DIGEST"
rotation_id: "<uuid4>"
timestamp: "<ISO8601>"
shadow_agent: "<agent_id>"
status: "ready" | "warming" | "failed"
loaded:
  - "kernel"
  - "profile"
  - "project_soul"
  - "memory_hot"
missing: []
errors: []
capacity:
  max_context_tokens: <int>
  current_estimate: <int>
  available_for_digest: <int>
ready_at: "<ISO8601>"
```

### HANDOFF_DIGEST

The core payload. Sent by Monitor to Shadow.

```yaml
message_type: "HANDOFF_DIGEST"
rotation_id: "<uuid4>"
timestamp: "<ISO8601>"
version: "1.0.0"

# ─────────────────────────────────────────────────────────────
# IDENTITY
# ─────────────────────────────────────────────────────────────
identity:
  project_id: "<project>"
  session_id: "<YYYY-MM-DD-NNN>"
  primary_agent: "<agent_id>"
  shadow_agent: "<agent_id>"
  handoff_reason: "context_high" | "manual" | "error"
  threshold_pct: 80
  active_blueprint_enforcement: "<enforcement_level or null>"  # Prevents Shadow violating locked plans

# ─────────────────────────────────────────────────────────────
# REPOSITORY STATE
# ─────────────────────────────────────────────────────────────
repo_state:
  repo_root: "<absolute_path>"
  branch: "<branch_name>"
  remote_tracking: "<origin/branch or null>"
  ahead_behind:
    ahead: <int>   # Commits ahead of remote
    behind: <int>  # Commits behind remote
  git_status:
    clean: <boolean>
    staged_count: <int>
    modified_count: <int>
    untracked_count: <int>
  last_commit:
    hash: "<short_hash>"
    message: "<first_line>"
    timestamp: "<ISO8601>"

# ─────────────────────────────────────────────────────────────
# UNCOMMITTED CHANGES (CRITICAL)
# ─────────────────────────────────────────────────────────────
patch_diff:
  format: "unified_diff"
  encoding: "utf-8"
  truncated: <boolean>
  truncation_reason: "<reason if truncated>"
  storage_ref: "<file_path or stash_ref>"  # Fallback for full diff when truncated
  content: |
    <git diff output — staged + unstaged>
  files_affected:
    - path: "<relative_path>"
      status: "modified" | "added" | "deleted"
      lines_added: <int>
      lines_removed: <int>

# ─────────────────────────────────────────────────────────────
# WORK CONTEXT
# ─────────────────────────────────────────────────────────────
work_context:
  objective: "<current high-level goal>"

  files_touched:
    - "<relative_path>"

  decisions_made:
    - decision: "<what was decided>"
      rationale: "<why>"

  tools_used:
    - "<tool_name>"

  tests_run:
    - test: "<test_name_or_command>"
      result: "pass" | "fail" | "skip"
      timestamp: "<ISO8601>"

  active_processes:
    - pid: <int>
      command: "<command>"
      purpose: "<why it's running>"

# ─────────────────────────────────────────────────────────────
# MENTAL MODEL (Monitor-synthesized)
# ─────────────────────────────────────────────────────────────
mental_model:
  token_budget: 800  # Target: 500-800 tokens

  context_summary: |
    <Monitor-generated narrative explaining:
     - What the user is trying to accomplish
     - Current state of the work
     - Key constraints and preferences discovered
     - What was just happening before handoff>

  pending_assumptions:
    - "<assumption Primary is working under but hasn't verified>"

  unresolved_anomalies:
    - "<weird behavior or bugs noticed>"

  user_preferences_discovered:
    - "<preference learned during session>"

# ─────────────────────────────────────────────────────────────
# NEXT ACTIONS
# ─────────────────────────────────────────────────────────────
next_actions:
  immediate:
    - "<what Shadow should do first>"
  queued:
    - "<subsequent tasks>"
  blocked_by:
    - "<blockers if any>"

# ─────────────────────────────────────────────────────────────
# CONTINUITY LINKS
# ─────────────────────────────────────────────────────────────
continuity:
  last_checkpoint: "<journal_path>"
  last_memory_entry: "<MEMORY.md entry reference>"
  active_blueprint: "<blueprint_path or null>"

# ─────────────────────────────────────────────────────────────
# VERIFICATION
# ─────────────────────────────────────────────────────────────
verification:
  ack_checks:
    - "<critical invariant 1 — Shadow must repeat back>"
    - "<critical invariant 2>"
  digest_hash: "sha256:<hash>"

# ─────────────────────────────────────────────────────────────
# REDACTION
# ─────────────────────────────────────────────────────────────
redaction:
  applied: true
  scanner_version: "<version>"
  types_scanned:
    - "aws_keys"
    - "github_tokens"
    - "passwords"
    - "api_keys"
  redactions_made: <int>
```

### INTENT_STATEMENT

Sent by Shadow to Monitor after processing digest. Proves comprehension.

```yaml
message_type: "INTENT_STATEMENT"
rotation_id: "<uuid4>"
timestamp: "<ISO8601>"
shadow_agent: "<agent_id>"
understanding:
  objective: "<Shadow's understanding of current goal>"
  next_action: "<what Shadow will do first>"
  ack_responses:
    - check: "<invariant 1>"
      response: "<Shadow's answer>"
    - check: "<invariant 2>"
      response: "<Shadow's answer>"
confidence: "high" | "medium" | "low"
questions: []  # Empty if ready, or list clarifications needed
```

### FINAL_HANDOVER_ACK

Sent by Primary to Monitor confirming Shadow's understanding is correct.

```yaml
message_type: "FINAL_HANDOVER_ACK"
rotation_id: "<uuid4>"
timestamp: "<ISO8601>"
primary_agent: "<agent_id>"
shadow_agent: "<agent_id>"
ack_validation:
  all_checks_passed: <boolean>
  mismatches: []  # Empty if valid
approved: <boolean>
handover_authorized: <boolean>
```

### SWITCH_ROUTE

Sent by Monitor to Proxy to switch user input routing.

```yaml
message_type: "SWITCH_ROUTE"
rotation_id: "<uuid4>"
timestamp: "<ISO8601>"
from_agent: "<primary_agent_id>"
to_agent: "<shadow_agent_id>"
effective_immediately: <boolean>
```

### SESSION_CLOSED

Sent by Primary to Monitor after /end completes.

```yaml
message_type: "SESSION_CLOSED"
rotation_id: "<uuid4>"
timestamp: "<ISO8601>"
agent: "<agent_id>"
session_id: "<session_id>"
journal_committed: <boolean>
journal_path: "<path>"
memory_updated: <boolean>
cleanup_complete: <boolean>
```

---

## Size Constraints

| Field | Max Size | Truncation Strategy |
|-------|----------|---------------------|
| `mental_model.context_summary` | 800 tokens | Summarize further |
| `patch_diff.content` | 12000 chars (~1200 tokens) | Write full diff to `storage_ref`, include summary |
| `decisions_made` | 10 items | Most recent only |
| `files_touched` | 20 items | Group by directory |
| Total digest | 3500 tokens | Prioritize: mental_model > patch_diff > work_context |

**Prioritization Rules (when over budget):**
1. `mental_model` — Never truncate below 500 tokens
2. `patch_diff` — Truncate to file list + storage_ref
3. `work_context` — Reduce to most recent 5 items per field
4. `next_actions` — Keep immediate only

---

## Redaction Rules

The following patterns MUST be redacted before digest transmission:

| Type | Pattern | Replacement |
|------|---------|-------------|
| AWS Access Key (permanent) | `AKIA[A-Z0-9]{16}` | `[REDACTED:AWS_KEY]` |
| AWS Access Key (temp) | `ASIA[A-Z0-9]{16}` | `[REDACTED:AWS_TEMP_KEY]` |
| AWS Secret | `aws_secret_access_key["\s:=]+.{40}` | `[REDACTED:AWS_SECRET]` |
| AWS Session Token | `aws_session_token["\s:=]+.+` | `[REDACTED:AWS_SESSION]` |
| GitHub Token (classic) | `ghp_[A-Za-z0-9]{36}` | `[REDACTED:GITHUB_TOKEN]` |
| GitHub Token (fine-grained) | `github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}` | `[REDACTED:GITHUB_PAT]` |
| GitHub OAuth | `gho_[A-Za-z0-9]{36}` | `[REDACTED:GITHUB_OAUTH]` |
| GitHub App | `ghs_[A-Za-z0-9]{36}` | `[REDACTED:GITHUB_APP]` |
| GitHub Refresh | `ghu_[A-Za-z0-9]{36}` | `[REDACTED:GITHUB_REFRESH]` |
| Stripe Live Key | `sk_live_[A-Za-z0-9]{24,}` | `[REDACTED:STRIPE_LIVE]` |
| Stripe Test Key | `sk_test_[A-Za-z0-9]{24,}` | `[REDACTED:STRIPE_TEST]` |
| Stripe Restricted | `rk_(live\|test)_[A-Za-z0-9]{24,}` | `[REDACTED:STRIPE_RESTRICTED]` |
| Slack Token | `xox[baprs]-[A-Za-z0-9-]+` | `[REDACTED:SLACK_TOKEN]` |
| Private Key Block | `-----BEGIN (RSA\|EC\|OPENSSH\|PRIVATE) KEY-----` | `[REDACTED:PRIVATE_KEY]` |
| Generic API Key | `api[_-]?key["\s:=]+[A-Za-z0-9]{20,}` | `[REDACTED:API_KEY]` |
| Password fields | `password["\s:=]+.+` | `[REDACTED:PASSWORD]` |
| Bearer tokens | `Bearer [A-Za-z0-9\-._~+/]+=*` | `[REDACTED:BEARER]` |

Redaction is applied by Monitor before `HANDOFF_DIGEST` transmission.

**Redaction Failure:** If redaction scanner fails or encounters an error, handover MUST abort. Primary performs manual handoff instead.

---

## Error Handling

| Scenario | Response |
|----------|----------|
| Shadow fails to warm | Monitor retries with new Shadow instance |
| Intent Statement mismatch | Primary sends corrections, Shadow re-validates |
| Primary doesn't ACK within timeout | Monitor aborts, user notified |
| Proxy switch fails | User manually attaches to Shadow terminal |
| Monitor crashes | Primary self-triggers backup rotation (emit own digest) |
| Digest size exceeded | Truncate per prioritization rules, include `storage_ref` |
| Redaction scanner fails | Abort handover, Primary performs manual handoff |
| `rotation_id` mismatch | Ignore message, log warning |

**Configurable Timeouts:**
| Parameter | Default | Range |
|-----------|---------|-------|
| `ack_timeout` | 30s | 15-120s |
| `warm_timeout` | 60s | 30-180s |
| `digest_timeout` | 45s | 20-90s |

---

## MVP Acceptance Criteria

- [ ] Monitor can observe Primary session via `get_agent_output`
- [ ] Monitor synthesizes digest within size constraints
- [ ] Digest includes valid `patch_diff` of uncommitted changes
- [ ] Shadow loads digest and outputs correct Intent Statement
- [ ] Primary validates Intent Statement and sends ACK
- [ ] Manual terminal switch — user continues without re-explaining context
- [ ] Redaction filter catches test credentials

---

## Future Enhancements (Post-MVP)

1. **zeos-proxy** — Seamless user input routing
2. **Digest compression** — LLM-based summarization for very long sessions
3. **Multi-Shadow pool** — Pre-warm multiple Shadows for instant failover
4. **Cross-model handover** — Claude → Gemini → Claude rotation
5. **Checkpoint-based restore** — Resume from any historical digest

---

---

## Appendix: Storage Reference Protocol

When `patch_diff` exceeds size limits, Monitor writes full diff to a temp file:

```bash
# Storage location
/tmp/zeos-handover/${rotation_id}/full_diff.patch

# Shadow retrieval
cat /tmp/zeos-handover/${rotation_id}/full_diff.patch
```

**Cleanup:** Primary deletes storage files after `SESSION_CLOSED` confirmation.

---

*Handover Digest Specification v1.0.0 — "The session never dies; it regenerates."*
