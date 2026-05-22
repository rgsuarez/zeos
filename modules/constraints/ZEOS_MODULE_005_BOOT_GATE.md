---
module_id: "boot-gate"
module_type: "constraint"
version: "1.0.0"
created: "2026-01-05"
updated: "2026-01-05"
author: "Claude (system)"
status: "active"
load_priority: 0
dependencies: ["shell-protocol"]
conflicts: []
auto_load: true
authority: "P0 Fix: Cross-agent boot consistency"
update_reason: "Initial creation — enforces deterministic boot across all agents"
---

# Module #005: Boot Completion Gate

## Purpose

This module defines the **mandatory boot verification gates** that ALL zeos-aware agents must pass before outputting a boot confirmation. It ensures deterministic, verifiable boot behavior regardless of agent implementation (Claude, Codex, Gemini, Aider, or future agents).

**Problem Solved:** Different AI agents interpret "load context" differently. Some read files explicitly; others assume context from prior messages. Without enforcement, agents may output boot confirmations while missing critical files, creating the illusion of successful boot while operating without full zeos constraints.

**Solution:** A mandatory gate checklist with explicit pass/fail criteria. Agents cannot output the boot splash screen until all applicable gates pass.

---

## Root Cause Analysis

**Incident (2026-01-05):** Codex booted zeos with `/zeos /project ai-example-app` but skipped:
- MANDATORY BOOT SEQUENCE files from AIB_SOUL.md
- Latest session journal load
- Resume card with prior session context

Claude Code executed the full sequence correctly. The difference was not a bug in Codex — it was ambiguity in the boot specification that allowed minimal compliance.

**Why This Happened:**
1. BOOT_PROTOCOL.md described steps but didn't ENFORCE completion
2. App SOUL files have "MANDATORY BOOT SEQUENCE" sections but no cross-validation
3. No gate prevented boot confirmation output before all requirements were met

**This Module's Fix:**
- Hard enforcement gates that block boot confirmation
- Explicit error messages when gates fail
- Cross-agent compatibility requirements

---

## Gate Specification

### Core Gates (G1-G5) — Always Required

| Gate | Requirement | Validation | On Failure |
|------|-------------|------------|------------|
| G1 | Kernel SOUL.md loaded | File read confirmed | HALT: `BOOT_INCOMPLETE: Kernel SOUL.md not loaded` |
| G2 | Kernel BOOT_PROTOCOL.md loaded | File read confirmed | HALT: `BOOT_INCOMPLETE: BOOT_PROTOCOL.md not loaded` |
| G3 | Profile PROFILE.md loaded | File read confirmed | HALT: `BOOT_INCOMPLETE: Profile not loaded` |
| G4 | SHELL_PROTOCOL module loaded | File read confirmed | HALT: `BOOT_INCOMPLETE: Shell Protocol not loaded` |
| G5 | CONTINUITY_PROTOCOL module loaded | File read confirmed | HALT: `BOOT_INCOMPLETE: Continuity Protocol not loaded` |

### Project Gates (G6-G8) — Required when `/project` issued

| Gate | Requirement | Validation | On Failure |
|------|-------------|------------|------------|
| G6 | App SOUL loaded | File read confirmed | HALT: `PROJECT_LOAD_FAILED: App SOUL not found` |
| G7 | MANDATORY BOOT SEQUENCE complete | Each file read confirmed | HALT: `BOOT_INCOMPLETE: Missing [filename]` |
| G8 | Latest session journal loaded | Glob + read most recent | WARN: Non-fatal, proceed with fresh session |

---

## Enforcement Algorithm

```
FUNCTION boot_with_gates(command, profile, project_id):

    # Phase 1: Core gates (always required)
    FOR gate IN [G1, G2, G3, G4, G5]:
        result = execute_gate(gate)
        IF result.failed:
            OUTPUT result.error_message
            RETURN BOOT_FAILED

    # Phase 2: Project gates (if /project issued)
    IF project_id IS NOT NULL:

        # G6: Load App SOUL
        soul_path = resolve_app_soul(project_id)
        IF NOT file_exists(soul_path):
            OUTPUT "PROJECT_LOAD_FAILED: App SOUL not found at {soul_path}"
            RETURN BOOT_FAILED

        soul_content = read_file(soul_path)

        # G7: Execute mandatory boot sequence
        mandatory_files = parse_mandatory_boot_sequence(soul_content)
        FOR file IN mandatory_files:
            IF NOT read_file(file):
                OUTPUT "BOOT_INCOMPLETE: Missing mandatory file {file}"
                RETURN BOOT_FAILED

        # G8: Load latest journal (non-fatal)
        journal_dir = get_journal_directory(project_id)
        journals = glob(journal_dir, "*.md")
        IF journals.length > 0:
            latest = journals.sort().reverse()[0]
            journal_content = read_file(latest)
            resume_context = extract_resume_context(journal_content)
        ELSE:
            WARN "No session journals found — starting fresh session"
            resume_context = NULL

    # Phase 3: All gates passed — output boot confirmation
    OUTPUT boot_splash_screen()
    OUTPUT resume_card(resume_context)
    RETURN BOOT_SUCCESS
```

---

## App SOUL Mandatory Boot Sequence Format

App SOUL files that require specific context loading MUST include a machine-parsable section:

```markdown
## MANDATORY BOOT SEQUENCE

The following files MUST be loaded in order before session start:

1. `docs/STRATEGIC_VISION.md` — Core strategy and objectives
2. `docs/MASTER_ROADMAP.md` — Current phase and task list
3. `docs/EDB_SCHEMA.md` — Executive Decision Brief format
4. `docs/OUTPOST_INTERFACE.md` — Agent dispatch specifications
```

**Parser Rule:** Agent scans App SOUL for heading `## MANDATORY BOOT SEQUENCE` and extracts file paths from the numbered list.

**Path Resolution:**
- Relative paths resolve from App SOUL's directory
- If path starts with `docs/`, resolve from app repository root
- If path starts with `../`, resolve relative to current file

---

## Cross-Agent Compatibility

This gate is designed for universal enforcement regardless of agent architecture:

### Claude (Claude Code, Claude Desktop)
- Has native file read capabilities
- MUST use Read tool to confirm each file loaded
- MUST NOT assume files are loaded from prior context

### Codex (OpenAI Codex CLI)
- Has file read and write capabilities
- MUST explicitly read each file
- MUST confirm reads in output before boot card

### Gemini (Gemini CLI, Gemini API)
- May have different file access patterns
- MUST use available file read tools
- MUST confirm reads before boot card

### Aider (Aider CLI)
- Typically operates in git repository context
- MUST read files from repository
- MUST confirm reads before boot card

### Future Agents
- ANY agent implementing zeos boot MUST follow this gate protocol
- Agents MUST NOT output boot confirmation until all gates pass
- Agents MUST output specific error messages on gate failure

---

## Error Message Reference

| Error | Cause | User Action |
|-------|-------|-------------|
| `BOOT_INCOMPLETE: Kernel SOUL.md not loaded` | Agent failed to read kernel | Check ZEOS_ROOT path |
| `BOOT_INCOMPLETE: BOOT_PROTOCOL.md not loaded` | Agent failed to read boot protocol | Check file exists |
| `BOOT_INCOMPLETE: Profile not loaded` | Profile path incorrect | Verify profile exists |
| `BOOT_INCOMPLETE: Shell Protocol not loaded` | Module path incorrect | Check modules/constraints/ |
| `BOOT_INCOMPLETE: Continuity Protocol not loaded` | Module path incorrect | Check modules/constraints/ |
| `PROJECT_LOAD_FAILED: App SOUL not found` | App not registered or SOUL missing | Run `/fleet` or `/newproject` |
| `BOOT_INCOMPLETE: Missing [filename]` | Mandatory file not accessible | Check app repository |

---

## Validation Criteria

A boot correctly implements this module if:

1. All applicable gates are checked in order
2. Boot confirmation is NOT output until all gates pass
3. Specific error messages are output on gate failure
4. Latest journal is loaded when available (G8)
5. Resume context appears in boot card from journal

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-01-05 | Claude (system) | Initial specification — cross-agent boot enforcement |

---

*Module #005: Boot Completion Gate v1.0.0*
*Ensures deterministic boot across all zeos-aware agents*
