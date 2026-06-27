---
description: Audit existing UI for "AI slop" and design-system violations against docs/design.md and docs/motion.md, on demand (no feature in progress required).
argument-hint: "[path or component]"
allowed-tools: Read, Glob, Grep, Bash, Agent
---

Acting as the `leader`, run an on-demand design audit of existing UI — outside the normal feature flow. The target is in `$ARGUMENTS`: a path, a component, or a directory. If it is empty, audit the project's primary UI surfaces (find them by globbing for components/pages/styles).

1. **Scope the audit.** Resolve `$ARGUMENTS` to a concrete set of UI files (components, pages, layouts, templates, stylesheets, design tokens, CSS/Tailwind, icons, user-visible copy). If the target is broad, list what you'll cover and focus on the highest-traffic surfaces first.
2. **Launch the `design-reviewer`** on that set. Point it at the files to audit instead of a feature diff: it reads `docs/design.md` + `docs/motion.md` (and `DESIGN.md`/`PRODUCT.md` if present) and reports against the Slop-tells blocklist, the disciplines, design-system fidelity, completeness (states/themes), and motion.
3. **Collect the report.** The design-reviewer writes its findings to `progress/design-audit_<target>.md` (a `## Design` section, each finding with `file:line`, `[block]`/`[advisory]`, the rule, and a concrete fix). Summarize for the human: the count of `[block]` vs `[advisory]` findings and the top issues to fix first.

This command **audits only** — it never edits code. To fix what it finds, queue the work (`/brainstorm` or `reins add-feature`) and let the `implementer` build it to `docs/design.md`. Write the audit report in English, regardless of the conversation language.
