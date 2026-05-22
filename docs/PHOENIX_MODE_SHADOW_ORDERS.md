# Phoenix Mode: Shadow Standing Orders

> You are **Shadow** in a Phoenix Mode rotation. Your job: pre-warm, receive the handoff digest, prove comprehension, then take over as Primary.

## Standby Mode

After booting zeos and loading your project, enter standby:

1. Call `listen_for_warm_shadow(shadow_agent=<you>, timeout=120)`
2. This blocks until Monitor sends WARM_SHADOW
3. Do NOT begin any project work while in standby

## When WARM_SHADOW Arrives

The message contains: `rotation_id`, `project_id`, `prewarm` instructions.

### Step 1: Pre-Warm

Load the following (if not already loaded):
- zeos kernel (`/zeos`)
- Project context (`/project <project_id>`)
- Latest MEMORY.md (if referenced)

### Step 2: Signal Ready

```
shadow_ready(
  shadow_agent=<you>,
  rotation_id=<from warm_shadow>,
  loaded=["kernel", "profile", "soul"],
  capacity_max=200000,
  capacity_current=<estimate>,
)
```

### Step 3: Wait for Digest

```
wait_for_digest(
  shadow_agent=<you>,
  rotation_id=<rotation_id>,
  timeout=60
)
```

Parse the digest payload. Internalize:
- `work_context.objective` -- what you're continuing
- `mental_model.context_summary` -- the full picture
- `next_actions.immediate` -- what to do first
- `repo_state` -- current branch, commit, clean/dirty
- `patch_diff` -- uncommitted changes in flight
- `verification.ack_checks` -- invariants you must confirm

### Step 4: Send Intent Statement

Prove you understood the digest:

```
send_intent_statement(
  shadow_agent=<you>,
  rotation_id=<rotation_id>,
  objective=<your understanding of the objective>,
  next_action=<what you will do first>,
  ack_responses=<responses to each ack_check>,
  confidence="high"
)
```

Set confidence to "medium" or "low" if anything is unclear. Add questions if needed.

### Step 5: Wait for Switch

After Primary ACKs and Monitor completes rotation, you receive SWITCH_ROUTE.
You are now **Primary**. Begin work immediately from `next_actions.immediate`.

## Post-Switch Checklist

1. Verify you're on the correct git branch: `git branch --show-current`
2. Check for uncommitted changes described in `patch_diff`
3. Begin executing `next_actions.immediate`
4. Continue normal zeos session (journal, checkpoints, etc.)

## Key Rules

1. **Do NOT start work before SWITCH_ROUTE** -- you are Shadow until confirmed
2. **Do NOT modify files during standby** -- observe only
3. **Prove comprehension honestly** -- if confidence is low, say so
4. **Ask questions if the digest is unclear** -- include them in intent_statement.questions
