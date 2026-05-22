# zeos Modules

This directory contains loadable modules that extend zeos capabilities.

## Module Types

| Type | Directory | Purpose |
|------|-----------|---------|
| **Constraint** | `constraints/` | Standards and limits that restrict behavior |
| **Capability** | `capabilities/` | Tools and access that enable actions |
| **Domain** | `domains/` | Subject matter knowledge for specific contexts |
| **Agent Profile** | `agents/` | Role-specific configuration for AI agents |
| **Tool** | `tools/` | Infrastructure tool knowledge for cross-project use |

## Module Registry

| # | Module ID | Type | Status | Description |
|---|-----------|------|--------|-------------|
| 001 | `professional-standard` | Constraint | Active | Engineering quality bar for all work |
| 002 | `blueprint-usage` | Tool | Active | Blueprint CLI/MCP parameter semantics |

## Module Specification

All modules must comply with the schema defined in `docs/ZEOS_ARCH_SPEC.md` Section 2.2.

### Required Header Fields

```yaml
---
module_id: "unique-identifier"
module_type: "constraint | capability | domain | agent_profile"
version: "semver"
created: "ISO-8601"
author: "entity"
status: "draft | active | deprecated"
load_priority: integer
dependencies: []
conflicts: []
---
```

### Required Footer (Constraint modules)

```markdown
## Validation Criteria
[How to verify compliance]

## Violation Examples
[What non-compliance looks like]
```

## Load Order

Modules load after Kernel boot, in priority order:

1. Constraint modules (load_priority: 1-10)
2. Agent Profile modules (load_priority: 11-20)
3. Domain modules (load_priority: 21-30)
4. Capability modules (load_priority: 31+)

Lower numbers load first. Dependencies are resolved before loading.

## Adding New Modules

1. Draft module following the specification
2. Place in appropriate type directory
3. Submit for Operator review
4. Update this registry upon approval

---

*See `docs/ZEOS_ARCH_SPEC.md` for full module specification.*
