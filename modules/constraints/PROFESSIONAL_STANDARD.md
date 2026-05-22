---
# ═══════════════════════════════════════════════════════════════
# zeos MODULE #001: PROFESSIONAL STANDARD
# ═══════════════════════════════════════════════════════════════
# The first module minted under the zeos Constitution.
# This module establishes the engineering quality bar for all work.
# ═══════════════════════════════════════════════════════════════

module_id: "professional-standard"
module_type: "constraint"
version: "1.0.0"
created: "2025-12-02"
formalized: "2025-12-17"
author: "Operator + Claude (Architect)"
status: "active"
load_priority: 1                    # Loads first - foundational constraint
dependencies: []                    # None - this IS the foundation
conflicts: []                       # None - compatible with all modules
applies_to: "all_projects"          # Universal scope
enforcement: "mandatory"            # Not optional

# Module metadata
registry_number: "001"
short_name: "PROFESSIONAL_STANDARD"
classification: "kernel_module"
supersedes: null
changelog:
  - version: "1.0.0"
    date: "2025-12-17"
    changes: "Formalized under zeos Constitution from original example-project standard"
---

# Module #001: Professional Engineering Standard

> **"Systems over tasks. Build businesses, not jobs."**

## Purpose

This module establishes the engineering quality bar for all work performed within zeos and its applications. When loaded, it acts as a **constraint filter** — proposed solutions are validated against these standards before execution.

**Effect When Loaded:** All agents operating under this module must reject approaches that violate its constraints, even if those approaches would be faster or easier.

---

## Core Philosophy

We design and build systems that:

1. **Work with minimal human input** — automation by default
2. **Are maximally audit-ready** — every state change is traceable
3. **Create blueprints, checklists, and prototypes** — reproducible by AI assistants
4. **Fix root causes, not symptoms** — no lazy quick fixes
5. **Maximize scalability and foundation security** — built for growth
6. **Take no shortcuts** — we do it right the first time

---

## The Automation-First Principle

Every system we build should be designed as if it will be operated by an AI assistant in the future. This means:

| Requirement | Description |
|-------------|-------------|
| **Clear, documented workflows** | Step-by-step processes that don't require tribal knowledge |
| **Predictable state transitions** | Systems move between well-defined states with audit trails |
| **Self-describing data** | Records contain enough context to be understood without external lookup |
| **Idempotent operations** | Running the same operation twice produces the same result |
| **Comprehensive error handling** | Systems fail gracefully with actionable error messages |

---

## Root Cause Resolution Protocol

When fixing bugs or issues, this module **prohibits** band-aid fixes:

```
BEFORE applying any fix:
├── 1. Trace the issue to its SOURCE
├── 2. Understand WHY it occurred
├── 3. Design fix that addresses ROOT CAUSE
├── 4. Verify fix doesn't create new issues
├── 5. Update documentation to prevent recurrence
└── 6. Add tests/validation where applicable
```

**Explicitly Prohibited:**
- Applying fixes that mask symptoms without addressing cause
- "Quick fixes" that create technical debt
- Solutions that require ongoing human intervention when automation is possible
- One-off solutions when a systemic solution would serve better

---

## Engineering Principles

### 1. Audit-First Development

Every financial operation MUST log before/after state to the audit trail.

```
BEFORE making any change to: Charges, Invoices, Payments, Services
├── Ensure audit logging is in place
├── Log previous state BEFORE the change
├── Log new state AFTER the change
└── Include performedBy, timestamp, and relevant metadata
```

**Rule:** Never delete financial data without an audit entry first.

### 2. Backup-Before-Edit

Always snapshot production assets before modifying them.

```bash
# Example: Before editing customer dashboard
aws s3 cp s3://dashboard.example.com/index.html \
  "s3://backups/dashboard/index.html.backup-$(date +%Y%m%d-%H%M%S)"
```

### 3. Version Everything

All code files must include version tracking:

```javascript
/**
 * ComponentName
 * @version 1.2.3
 * @updated 2025-12-17
 * @change Description of what changed
 */
```

### 4. Preview Before Deploy

For UI/UX changes, always create a visual preview artifact before committing to production.

**Trigger phrases:**
- "Show me a preview before we deploy"
- "Create a visual mockup"
- "Demo the before/after"
- "Create an artifact to preview this"

### 5. Test Before Deploy

Required validation before any deployment:
- Simulated tests for financial flows (webhooks, payments)
- Verify database state after operations
- Check audit trail entries
- Test edge cases (nulls, zeros, empty arrays)

### 6. Mobile-First Consideration

When building UI components:
- Consider all screen sizes
- Document any mobile limitations
- Create future enhancement tickets for responsive improvements

### 7. Edge Case Handling

Always handle:
- null/undefined values
- Empty arrays
- Zero amounts
- Missing optional fields
- Text overflow

### 8. Documentation Hygiene

**Rule:** When code changes, documentation must change.

No code change is complete until:
- [ ] Related documentation is updated
- [ ] CHANGELOG entry added (if applicable)
- [ ] README reflects new behavior (if applicable)

---

## AI-Ready Design Patterns

Systems must be designed for AI operability:

### Stateful Systems
```
Service: status=ACTIVE, billingStatus=CURRENT, paidThroughDate=2026-12-02
```

### Linked Entities
```
Invoice → lineItems[] → chargeId → Service.linkedChargeIds[]
```

### Audit Trails
```
WHO did WHAT to WHICH entity WHEN and WHY
```

### Predictable Naming
```
Tables: {Project}{Entity}        # e.g., example-project
IDs: {prefix}_{ulid}             # e.g., svc_01HXYZ...
Actions: {ENTITY}_{ACTION}       # e.g., SERVICE_CREATED
```

---

## Pre-Work Checklist

Before starting any significant work, verify:

- [ ] Read relevant system documentation
- [ ] Read this PROFESSIONAL_STANDARD module
- [ ] Review related planned work / roadmap
- [ ] Identify which audit logging applies
- [ ] Plan backup strategy for production assets
- [ ] Determine if preview artifacts are needed
- [ ] Consider mobile/responsive implications
- [ ] Consider how this work enables future automation

---

## Critical Rules Summary

### Never Do:
- ❌ Delete financial data without audit logging
- ❌ Push to production without backup
- ❌ Skip version tracking
- ❌ Deploy UI changes without preview
- ❌ Apply quick fixes without addressing root cause
- ❌ Build one-off solutions when a system would serve better

### Always Do:
- ✅ Log before/after state for financial operations
- ✅ Backup before editing production
- ✅ Include version numbers and changelogs
- ✅ Create previews for UI changes
- ✅ Test before deploying
- ✅ Fix root causes, not symptoms
- ✅ Design for automation

---

## Validation Criteria

A work product complies with this module if:

| Criterion | Validation Method |
|-----------|-------------------|
| **Root Cause** | The solution addresses underlying cause, not just visible symptom |
| **Audit Trail** | All state changes are logged with who/what/when/why |
| **Backup Exists** | Production assets were snapshotted before modification |
| **Version Tracked** | Code includes version comment with date and change description |
| **Documentation Updated** | Relevant docs reflect the changes made |
| **Edge Cases Handled** | Nulls, empties, zeros don't cause failures |
| **Automation Enabled** | Solution reduces (not increases) human intervention needed |
| **Reproducible** | Another agent could execute the same work from documentation |

**Validation Gate:** Proposed solutions should be checked against this table before execution. If any criterion cannot be satisfied, the solution requires revision.

---

## Violation Examples

These examples illustrate what **non-compliance** looks like:

### Violation: Band-Aid Fix

```
❌ WRONG:
User: "The invoice total is showing wrong"
Agent: "I'll add a manual adjustment to correct the display"

✅ RIGHT:
User: "The invoice total is showing wrong"
Agent: "Let me trace why the calculation is incorrect...
        The root cause is the tax rate lookup failing silently.
        I'll fix the tax lookup and add error handling."
```

### Violation: No Audit Trail

```
❌ WRONG:
Agent: "I've deleted the duplicate charge from the database"

✅ RIGHT:
Agent: "Before deleting, I'll log the current state to the audit trail,
        then delete with a recorded reason and timestamp"
```

### Violation: Production Edit Without Backup

```
❌ WRONG:
Agent: "Deploying the new dashboard now..."

✅ RIGHT:
Agent: "First, backing up current dashboard to snapshots bucket...
        Backup complete: s3://backups/dashboard-2025-12-17-143022.html
        Now deploying new version..."
```

### Violation: One-Off Instead of System

```
❌ WRONG:
User: "Can you send a reminder email to this customer?"
Agent: "Sure, I'll compose and send that email now"

✅ RIGHT:
User: "Can you send a reminder email to this customer?"
Agent: "I can do that, but should we build an automated reminder system?
        That would handle this case and all future cases without manual work."
```

### Violation: Undocumented Change

```
❌ WRONG:
Agent: "I've updated the Lambda function to fix the bug"

✅ RIGHT:
Agent: "I've updated the Lambda function to fix the bug.
        I've also updated:
        - CHANGELOG.md with the fix description
        - README.md with the new behavior
        - Added inline comments explaining the fix"
```

---

## Module Governance

| Aspect | Rule |
|--------|------|
| **Modification** | Requires Operator approval with documented rationale |
| **Suspension** | Operator may temporarily suspend for emergency work |
| **Versioning** | Semantic versioning; breaking changes = major version |
| **Scope** | Applies to all zeos projects unless explicitly exempted |

---

## References

| Document | Relationship |
|----------|--------------|
| `ZEOS_ARCH_SPEC.md` | Constitution — this module implements Section 2.2 |
| `SOUL.md` | Kernel values — this module operationalizes "Systems over Tasks" |
| `CAPABILITY_REGISTRY.json` | Lists tools available for implementing standards |

---

*Module #001 — The first coin minted under the zeos Constitution.*
*Formalized: 2025-12-17 | Original: 2025-12-02*
