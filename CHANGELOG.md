# Changelog

All notable changes to Reins are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). The harness template version tracks
the package version, so `reins update` migrates installed harnesses to it.

## 0.7.0

### The Four R's — code-review contract

- New **`docs/four-rs.md`** defines four review dimensions — **Risk, Readability,
  Reliability, Resilience** — as a contract: each states the **conditions the
  implementer must satisfy** and the **checks the reviewer verifies**. They are
  the qualitative judgment layer on top of the mechanical gate (C1–C8) and the
  security-reviewer, which are unchanged.
- The dimensions are **mutually exclusive**: Risk judges the change-as-event
  (blast radius + reversibility, never whether the code is wrong); Reliability vs
  Resilience split on _in-contract input you own_ vs _the environment/a
  collaborator misbehaving_; Readability covers only the comprehension cost lint
  can't see; security exposure stays entirely with the `security-reviewer`.
- **Severity-driven, not a new gate.** A _block_-severity finding warrants
  `CHANGES_REQUESTED`; minor findings are advisory. No checkpoints C9–C12 are added.
- The **implementer** now records a _Self-review (Four R's)_ block in
  `progress/impl_<feature>.md`; the **reviewer** audits those claims against the
  diff and records a `## Judgment (Four R's)` section in the review verdict. Wired
  into both the Claude Code and opencode agent templates.

## 0.6.1

### Docs

- README: the **Requirements** section now lists both runtimes (Claude Code
  _or_ opencode) and how to pick one at install time; previously it named only
  Claude Code.
- README: the slash-commands intro reflects that commands install under
  `.opencode/commands/` for the opencode runtime, not only `.claude/commands/`.

## 0.6.0

### opencode runtime support

- **`reins init --runtime <claude|opencode>`** (interactive prompt otherwise;
  defaults to `claude`). A project targets one runtime, recorded as `runtime` in
  `reins.config.json`. The same agents, presets, and verification gate are
  emitted in the form each tool reads.
- **opencode runtime** generates `.opencode/agents/*` (with `mode` +
  `provider/model` frontmatter), `.opencode/commands/*`, an `AGENTS.md` rules
  file (opencode reads it natively — no `CLAUDE.md`), and `opencode.json` with a
  stack-aware `permission` policy.
- **Verification gate via plugin.** `.opencode/plugins/reins-verify.ts` runs
  `npx reins verify` on `file.edited` (≈ `PostToolUse`) and `session.idle`
  (≈ `Stop`), and `npx reins status` on `session.created`. It reuses the
  `--hook` names so `verify.perHook` applies to both runtimes. Note: an opencode
  plugin cannot hard-block a finished session the way Claude Code's `Stop` hook
  does — a red tree is surfaced loudly but not hard-stopped.
- **Runtime-aware tooling.** `reins doctor`, `reins update`, and
  `reins add-agent` all follow `runtime`: doctor checks the opencode plugin /
  `opencode.json` and tolerates the absent Claude tree; add-agent writes to
  `.opencode/agents/` with opencode frontmatter.
- Per-role **model pinning** for opencode requires a full `provider/model` ID
  (e.g. `anthropic/claude-sonnet-4-5`); Reins' `sonnet`/`opus`/`haiku`/`fable`
  aliases and `effort` are Claude-only and omitted for opencode agents. The
  model schema now accepts `/` so `provider/model` IDs validate.
- **Existing Claude harnesses are unaffected**: `runtime` defaults to `claude`
  and the `.claude/` output is byte-identical; `reins update` re-renders it
  unchanged.

### Commands

- **`/autopilot`** — the batch form of `/next-feature`. Acting as the `leader`,
  it drives the entire ready queue to `done` in one unattended run: every
  `approved` feature (`pending` under lite) whose dependencies are `done`, in
  dependency order, one `in_progress` at a time. It pauses once to show the
  ordered queue and wait for a single go-ahead, then runs to completion with no
  further questions, halting and reporting on the first blocker. Generated for
  both runtimes (`.claude/commands/autopilot.md`,
  `.opencode/commands/autopilot.md`); `reins update` adds it to existing
  harnesses.

### Docs

- README: new **"Runtimes"** section comparing the `claude` and `opencode`
  output, gate wiring, and the softer opencode enforcement guarantee; documents
  the new `/autopilot` command.

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
