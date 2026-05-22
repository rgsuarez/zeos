---
document: "OPERATOR_ONBOARDING"
version: "1.1.0"
status: "ACTIVE"
created: "2025-12-18"
updated: "2025-12-18"
author: "Claude (Architect)"
audience: "New zeos operators"
update_reason: "Add continuity UX expectations (session resume)"
---

# Operator Onboarding

**Time required:** 10 minutes (one-time setup)

> **zeos doesn't just remember — it wakes up knowing exactly where you left off. No re-explaining. No lost decisions. It's like your work never stopped.**

---

## What You Need

Before starting, confirm you have these from your zeos administrator:

| Item | Example | Got it? |
|------|---------|---------|
| Profile ID | `<operator>` | [ ] |
| GitHub PAT | `github_pat_...` (long string) | [ ] |
| Preferences Block | Text block to paste | [ ] |

If you're missing any item, contact your administrator.

---

## Step 1: Install Preferences (One-Time)

### For Claude Users

1. Go to [claude.ai](https://claude.ai)
2. Click your profile icon → **Settings**
3. Find **User Preferences** (or similar)
4. Paste the entire preferences block your admin provided
5. Save

### For Other AI Platforms

Consult your platform's documentation for "custom instructions" or "system prompt" configuration. The preferences block should be placed there.

---

## Step 2: Verify Setup

1. Open a **new chat** (don't reuse an existing one)
2. Type: `/zeos`
3. Verify the boot confirmation shows:
   - Your profile ID (not "template")
   - Persistence: R/W or similar (not "UNAVAILABLE")

**Example successful first boot:**
```
═══════════════════════════════════════════════════════════════
ZEOS BOOT COMPLETE
═══════════════════════════════════════════════════════════════
Agent: Claude (Architect)
Profile: <operator>                    ← Your ID
Persistence: R/W                 ← NOT "UNAVAILABLE"
Commands: ACTIVE
═══════════════════════════════════════════════════════════════
Ready for directives.
```

---

## Step 3: Test Continuity (The Magic Moment)

This proves zeos is working correctly.

### Session 1: Create State

1. In your booted session, do meaningful work:
   - Discuss a technical problem
   - Make a decision
   - Create an artifact (code, spec, plan)
2. Type: `/snap Testing my first checkpoint`
3. Wait for confirmation (includes `next_action_primer`)
4. **Close the browser tab** (important: this kills the session)

### Session 2: The Resurrection

1. Open a **new** chat
2. Type: `/zeos`
3. **Watch for the magic:**

```
Welcome back, <operator>. Last session: [what you were working on]
Constraints carried: [any constraints you set]

You were working on: [your artifact/decision]

Continue from here, or adjust scope?

═══════════════════════════════════════════════════════════════
ZEOS BOOT COMPLETE — Continuing session
═══════════════════════════════════════════════════════════════
...
```

**Success:** Claude leads with your context, not system status.
**Failure:** Contact your administrator with error details.

---

## Daily Usage

Once setup is complete, your workflow is:

```
1. New chat → /zeos
2. Work normally
3. /snap [note] when you want to save progress
4. /end when done (creates final journal with handoff)
```

### Key Commands

| Command | What It Does |
|---------|--------------|
| `/zeos` | Start zeos session (resumes from last checkpoint) |
| `+log` | Show current session state |
| `/snap [note]` | Save progress + generate resumption primer |
| `/end` | Conclude session with final journal and handoff |
| `/help` | List all commands |

---

## What Makes This Different

| Without zeos | With zeos |
|--------------|-----------|
| "Sorry, I don't have memory of previous conversations" | "Welcome back. Last session you were working on X" |
| Re-explain everything each session | Context survives automatically |
| Work evaporates when tab closes | Work compounds across sessions |
| Generic AI assistant | Persistent collaborator |

---

## Common Issues

| Issue | Solution |
|-------|----------|
| Boot says "template" instead of my ID | Preferences not saved correctly. Re-paste and save. |
| Persistence shows "UNAVAILABLE" | PAT missing or expired. Contact admin. |
| Checkpoint fails silently | Check `+log` for errors. PAT may be invalid. |
| New session doesn't show resume greeting | Checkpoint may have failed. Verify with `+log` before closing. |
| Resume greeting is generic | Journal may lack `next_action_primer`. Re-checkpoint with clear context. |

---

## Getting Help

- **Documentation:** Check `docs/` in the zeos repository
- **Issues:** File at `github.com/rgsuarez/zeos/issues`
- **Admin:** Contact whoever provided your credentials

---

*You're ready to use zeos. Welcome aboard.*
