---
# ═══════════════════════════════════════════════════════════════
# PROFILE TEMPLATE
# ═══════════════════════════════════════════════════════════════
# Copy this directory to profiles/{your-name}/
# Customize PROFILE.md for your projects and preferences
# ═══════════════════════════════════════════════════════════════
profile_id: "template"
operator: "[Your Name]"
callsign: "[Your Callsign]"
version: 1
created: "2026-01-03"
status: "TEMPLATE"
---

# Operator Profile: [Your Name]

## Identity

```yaml
identity:
  name: "[Your Name]"
  role: "[Your Role]"
  callsign: "[Your Callsign]"
  
background:
  professional: "[Your profession/expertise]"
  technical_level: "[Beginner | Intermediate | Expert]"
```

---

## Communication Style

```yaml
communication:
  tone: "[e.g., professional, casual, direct]"
  format: "[e.g., BLUF, conversational, structured]"
  length: "[e.g., concise, detailed as needed]"
  
  avoid:
    - "[Things you want AI to avoid]"
    
  prefer:
    - "[Things you want AI to include]"
```

---

## Technical Context

```yaml
technical:
  proficiency: "[Your level]"
  
  preferences:
    languages: ["[Preferred languages]"]
    platforms: ["[Preferred platforms]"]
    tools: ["[Preferred tools]"]
```

---

## Constraints

```yaml
constraints:
  non_negotiables:
    - "[Constraint 1]"
    - "[Constraint 2]"
    
  time:
    availability: "[Your availability]"
```

---

## Continuity Mode

```yaml
continuity:
  mode: STANDARD     # OFF | LIGHT | STANDARD | HEAVY
```

See `modules/constraints/ZEOS_MODULE_003_CONTINUITY_PROTOCOL.md` for details.

---

## Fleet

Your active projects (use `/fleet` to see status):

| Project | Description |
|---------|-------------|
| [Project 1] | [Description] |

---

## Notes

- Profile is loaded during `/zeos` boot (or implicitly by `/project`)
- Use `/project <id>` to load a specific project after boot
- Session journals live in `~/projects/zeos/journals/<app_id>/` (gitignored), not in the project repo
- Project SOUL.md lives in `~/projects/zeos/souls/<app_id>/` (gitignored); project CLAUDE.md (operations doctrine) lives in the project repo
- Kernel documents (SOUL.md, BOOT_PROTOCOL.md) supersede this profile

---

*Template Profile — Customize for your use*
