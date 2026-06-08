# Changelog

All notable changes to Reins are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). The harness template version tracks
the package version, so `reins update` migrates installed harnesses to it.

## 0.1.1

- Add the Reins logo to the README header.

## 0.1.0

Initial release. Reins installs and maintains a controlled, multi-agent harness
on top of an existing project for Claude Code.

### Commands

- **`reins init`** — auto-detects the stack (Node, Python) and scaffolds the
  harness idempotently (agents, hooks, docs, living state, config) without
  overwriting your files; records what it generated in `.reins/manifest.json`.
  Interactive preset wizard, or `--yes` for CI.
- **`reins verify`** — cross-platform verification gate: lint, unit, e2e,
  security (dependency audit + secret scan), feature-list invariants, and (SDD)
  requirement↔test traceability. Exit `0`/`1`, and exit `2` + a block message
  for the `PostToolUse`/`Stop`/`SubagentStop` Claude Code hooks.
- **`reins doctor`** — checks the harness is complete and coherent; `--fix`
  recreates missing files without overwriting anything.
- **`reins update`** — three-way merge that updates templates to the installed
  version while preserving your edits (dry run by default; `--yes`/`--force`).
- **`reins add-feature <slug>`** — registers a feature; `--with-spec` scaffolds
  `specs/<slug>/` from the SDD template.
- **`reins add-agent <role>`** — adds a subagent from a template; `--from`,
  `--name`, and `--tools` for custom roles.
- **`reins status`** — active feature, queue, and session cost/token telemetry.
- **`reins telemetry record`** — invoked by the `SubagentStop` hook to record
  best-effort subagent cost/token usage to `progress/telemetry.jsonl`.

### Presets

- **`lite`** — `leader` / `implementer` / `reviewer` / `security-reviewer` plus
  the verification gate.
- **`sdd`** — adds `spec_author`, EARS specs, a human approval gate, and
  requirement↔test traceability.

### Notes

- Targets Claude Code: generates `.claude/agents`, `.claude/settings.json`
  hooks + permission allowlist, `.claude/commands`, and `CLAUDE.md` (which
  imports `AGENTS.md`).
- Cost telemetry pricing is approximate and embedded; the transcript format is
  best-effort and degrades to a subagent count.
