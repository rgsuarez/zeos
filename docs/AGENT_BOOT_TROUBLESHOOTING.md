# Agent Boot Troubleshooting Guide

> **Extracted from:** `kernel/BOOT_PROTOCOL.md` — Common Agent Boot Mistakes section
> **Purpose:** Detailed troubleshooting for agents that encounter boot issues

This document provides detailed guidance for resolving common boot failures. For the quick reference checklist, see the Boot Validation section in `kernel/BOOT_PROTOCOL.md`.

---

## Mistake 1: Skipping Kernel Files

**Symptom:** Agent loads project SOUL but not kernel SOUL.md, BOOT_PROTOCOL.md, or constraint modules.

**Why it happens:**
- Agent assumes project files are sufficient
- Agent encounters error and gives up without retry
- Agent doesn't understand kernel supremacy (K>M>P)

**Fix:**
```
BEFORE outputting boot confirmation:
  VERIFY: Did I load kernel/SOUL.md? (Answer must be YES)
  VERIFY: Did I load kernel/BOOT_PROTOCOL.md? (Answer must be YES)
  VERIFY: Did I load SHELL_PROTOCOL.md? (Answer must be YES)
  VERIFY: Can I cite the North Star? (Answer must be YES)

  IF any answer is NO:
    STOP: Re-read all kernel files NOW
    DO NOT proceed until all kernel files confirmed loaded
```

---

## Mistake 2: Giving Up on First Error

**Symptom:** File read fails once, agent reports "cannot access files" and proceeds anyway.

**Why it happens:**
- Transient error (case sensitivity, path format, temporary filesystem issue)
- Agent makes false assumption about capabilities
- Agent doesn't retry with alternative methods

**Fix:**
```
IF file read fails:
  LOG: "Attempt 1 failed: [error message]"
  RETRY: Attempt read again (may be case sensitivity: zeos vs zeos)
  IF retry succeeds:
    CONTINUE (error was transient)
  ELSE:
    TRY: Alternative path format or read method
    IF alternative succeeds:
      CONTINUE
    ELSE:
      HALT: Report "Cannot access file after 2 attempts: [details]"
```

**Note:** Case sensitivity matters. Repository is `zeos` not `zeos`.

---

## Mistake 3: Proceeding Without Validation

**Symptom:** Agent outputs boot splash but cannot answer basic questions about kernel content.

**Why it happens:**
- Agent doesn't verify actual file content loaded
- Agent assumes files loaded when they didn't
- No self-check before outputting confirmation

**Fix:**
```
BEFORE outputting "Boot complete" or splash screen:
  SELF-CHECK (answer from memory, NOT by re-reading):
    1. What is the kernel's North Star?
    2. What version is BOOT_PROTOCOL?
    3. What are 3 shell commands?

  IF you cannot answer these WITHOUT looking them up:
    YOU DID NOT LOAD THE FILES
    STOP: Go back and actually read kernel/SOUL.md
    DO NOT output boot confirmation
```

---

## Mistake 4: Loading Wrong Files

**Symptom:** Agent loads similar-sounding files but not the actual kernel files.

**Why it happens:**
- Path confusion (apps/zeos-dev/ZEOS_DEV_SOUL.md is NOT kernel/SOUL.md)
- Case sensitivity (zeos vs zeos)
- Incomplete path resolution

**Fix:**
```
KERNEL FILES ARE:
  ✅ kernel/SOUL.md (NOT apps/*/SOUL.md)
  ✅ kernel/BOOT_PROTOCOL.md
  ✅ modules/constraints/SHELL_PROTOCOL.md (NOT modules/SHELL_PROTOCOL.md)
  ✅ modules/constraints/CONTINUITY_PROTOCOL.md

IF you loaded an app SOUL, you ALSO need kernel SOUL.
Project SOULs extend kernel SOUL, they do NOT replace it.
```

---

## Mistake 5: Silent Failure

**Symptom:** Agent outputs "Boot complete" but actually failed to load critical files.

**Why it happens:**
- Agent catches error but doesn't surface it
- Agent proceeds despite gate failures
- Agent outputs success prematurely

**Fix:**
```
Gates G1-G5 are MANDATORY and FATAL.
IF any G1-G5 gate fails:
  OUTPUT: "❌ BOOT INCOMPLETE - Gate [GN] failed"
  OUTPUT: "Cannot proceed without kernel context"
  DO NOT output splash screen
  DO NOT output "Boot complete"
  HALT
```

---

## Quick Diagnostic

If boot fails, answer these questions:

1. **Can you cite the North Star?** → If no, kernel/SOUL.md not loaded
2. **What version is BOOT_PROTOCOL?** → If unknown, BOOT_PROTOCOL.md not loaded
3. **Can you name 3 shell commands?** → If no, SHELL_PROTOCOL.md not loaded
4. **Did all G1-G5 gates pass?** → If any failed, boot is incomplete

---

*Extracted as part of Boot Token Optimization — 2026-01-11*
