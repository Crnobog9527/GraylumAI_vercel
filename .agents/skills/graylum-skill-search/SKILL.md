---
name: graylum-skill-search
description: Search the local skill catalog first, then locate matching SKILL.md files in the repo or user skill directories so the right skills can be loaded on demand.
---

# Graylum Skill Search

Use this skill whenever the task starts with "先看看有哪些 skill 可用", "去 catalog 里找 skill", or any request to find and load the right skills before doing other work.

## Workflow

1. Search the repo catalog first:

```bash
rg -n "<keyword>|<skill-name>" .agent/skills/CATALOG.md
```

2. If the catalog result is ambiguous, search local skill folders for matching `SKILL.md` files:

```bash
find .agents/skills "$CODEX_HOME/skills" -path '*/SKILL.md' 2>/dev/null | sort
```

3. Read only the matching skill files you need:

```bash
sed -n '1,220p' /path/to/SKILL.md
```

4. Prefer the minimal skill set that covers the task. When multiple skills overlap, choose the one with the narrowest scope that still fits.

## Selection Rules

- Always inspect `.agent/skills/CATALOG.md` before bulk-searching the filesystem.
- Prefer repo-local skills under `.agents/skills/` when they are task-specific.
- Use `$CODEX_HOME/skills/` when the repo does not provide a more specific match.
- Avoid loading multiple large skill files unless each one changes the execution path.

## Output Expectations

- Report which skills were selected and why.
- If nothing relevant is found, say that briefly and continue with direct repo inspection.
