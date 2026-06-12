# Changelog

All notable changes to Reins are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). The harness template version tracks
the package version, so `reins update` migrates installed harnesses to it.

## 0.5.0

### Per-role model & effort configuration

- New optional **`agents` section in `reins.config.json`**: each role
  (`leader`, `implementer`, `reviewer`, `security-reviewer`, `spec_author`) can
  pin `model` (`sonnet`/`opus`/`haiku`/`fable`, a full model ID, or `inherit`)
  and `effort` (`low`/`medium`/`high`/`xhigh`/`max`). Rendered as native Claude
  Code `model:`/`effort:` frontmatter in `.claude/agents/*.md`; `inherit`
  (the default) omits the field so the subagent uses the session's model and
  effort.
- **New installs** default `reviewer` and `spec_author` to `sonnet` to cut
  token cost on review/spec work; `leader`, `implementer`, and
  `security-reviewer` stay on `inherit` (the security gate runs rarely and a
  missed vulnerability costs more than it saves).
- **Existing harnesses are unaffected**: configs without an `agents` section
  parse as all-`inherit` and `reins update` re-renders agent files
  byte-identically. To opt in, add the `agents` section to `reins.config.json`
  and run `reins update`.
- **`reins add-agent --model / --effort`** for per-file overrides, e.g.
  `reins add-agent explorer --from reviewer --model haiku --effort low`.
- `reins doctor` warns on invalid `model:`/`effort:` frontmatter values.
- `AGENTS.md` role table gains a **Model** column; `/brainstorm` and
  `/next-feature` now suggest launching explorers on cheap models.

### Docs

- README: new **"Slash commands (inside Claude Code)"** section documenting
  every generated command (`/brainstorm`, `/next-feature`, `/reins-verify`,
  `/reins-status`, `/new-spec`, `/validate-discovery`, `/approve-spec`) with
  usage examples and an end-to-end session walkthrough.

## 0.4.0

### Front-loaded spec approval — new `approved` state

- New feature state **`approved`** between `spec_ready` and `in_progress`: the
  spec was human-approved and the feature is ready to implement with no further
  questions. It is not an active state (any number of features may be
  `approved`) and not dependency-gated (a spec may be approved before its
  dependencies are done).
- **`/brainstorm` (sdd) now runs the whole spec pipeline**: after the breakdown
  is approved and the features are registered, it walks each feature — one at a
  time, in dependency order — through discovery, open questions answered in
  chat, spec authoring, and spec approval, ending with every feature `approved`.
  All human questioning is front-loaded into the brainstorm.
- **`/next-feature` fast-path**: an `approved` feature goes straight to
  `in_progress` and implementation — no re-opened discovery, no questions, no
  approvals. One feature per invocation. The `pending` path (features created
  outside a brainstorm) keeps the discovery → validate → spec → approve flow.
- **`/approve-spec` now sets `approved`** (previously `in_progress`);
  implementation starts via `/next-feature`.
- `reins verify`: an `approved` feature must have a non-empty `discovery.md`
  **and** the three spec files (`requirements.md`, `design.md`, `tasks.md`).
- `reins status`: the queue now lists `pending` + `approved` features;
  `approved` features whose dependencies are `done` lead it.

### Artifacts in English

- All generated templates now instruct agents to write every artifact saved to
  disk — brainstorm files, discoveries, specs, progress reports — **in
  English**, regardless of the conversation language.

### Notes for existing projects

- `reins update` re-renders commands, agents, and docs with the new flow.
  `feature_list.json` is create-only, so its informational `rules.validStates`
  keeps the old list — harmless, since `reins verify` uses its own built-in set.

## 0.3.1

### Fixes

- The generated CI workflow (`reins-verify.yml`) now invokes the CLI by its
  scoped npm name, pinned to the harness version
  (`npx --yes @fermin-dev/reins@<version> verify --hook CI`). The previous
  unscoped `npx --yes reins` 404'd on the npm registry, failing the gate in CI.
  Existing harnesses pick this up via `reins update`.

## 0.3.0

### `/brainstorm` — epic-level decomposition

- New **`/brainstorm <idea>`** command (both presets): the leader turns a rough
  idea into a sequence of discrete features, writes the breakdown to
  `progress/brainstorm_<epic>.md`, and **stops for human approval**. On approval
  it registers each feature as `pending` via `reins add-feature` — without specs,
  so every feature still earns its own discovery and approval. It only populates
  the queue; it never skips a gate.

### `dependsOn` is now enforced

- `reins verify` (the `feature-list` check, required in both presets) rejects
  dependency **cycles** and **dangling references**, and fails when a feature is
  `in_progress` or `done` before all of its dependencies are `done`.
- `reins status` lists the pending queue in **dependency order** (features whose
  dependencies are all `done` first), and `/next-feature` picks the top pending
  feature whose dependencies are satisfied. Existing feature lists (no
  `dependsOn`) are unaffected.

### Fixes

- The generated `AGENTS.md` now links to the correct npm page
  (`@fermin-dev/reins`) instead of a non-existent unscoped `reins` package.

## 0.2.0

### SDD — discovery phase before the spec

- New **Discovery** step in the Spec-Driven flow: for a `pending` feature the
  leader analyzes the codebase and writes `specs/<feature>/discovery.md`
  (findings, affected areas, approaches, open questions), then **stops for human
  validation of intent** before any spec is drafted. New states `analyzing` and
  `needs_clarification`, and a new `/validate-discovery` command.
- `reins verify` enforces it: a feature in `needs_clarification`, `spec_ready`,
  or `in_progress` must have a non-empty `discovery.md`, and only one feature may
  be active (`analyzing`/`in_progress`) at a time.
- `spec_author` now builds the spec from the validated discovery, not the title.

## 0.1.2

- Use a PNG logo served over an absolute URL so it renders on the npm package
  page (npm blocks SVG and does not resolve relative image paths).
- Add `repository`, `homepage`, and `bugs` metadata to package.json.

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
