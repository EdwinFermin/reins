# Changelog

All notable changes to Reins are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). The harness template version tracks
the package version, so `reins update` migrates installed harnesses to it.

## 0.12.0

### Verify per milestone, not per edit

A change in progress passes through broken intermediate states — a signature updated before its
callers — so checking after every edit cost time and steered the agent into patching half-done
work. The gate now runs when there is something whole to check.

- **No per-edit hook.** New installs get no `PostToolUse` hook (and no `file.edited` gate on
  opencode). `reins update` removes the generated hook from `.claude/settings.json` (only in its
  exact generated form — an edited one is kept) and sets `verify.perHook.PostToolUse` to `[]` when it
  still holds a former default. A hook listed in `perHook` now runs exactly its list — an empty list
  runs nothing, instead of falling back to `required`.
- **Enforced gate when the implementer finishes.** A new `SubagentStop` hook runs the full gate for
  the agents in `verify.gateAgents` (default `["implementer"]`, also matching `plugin:implementer`);
  a red tree blocks the hand-off with exit 2 and the implementer keeps fixing. Reviewers, explorers,
  and other subagents finish untouched. It shares the Stop policy — pre-existing dependency findings
  don't block, and an identical block repeated with no file changes is released — with its own
  repeat counter.
- **Write first, verify at the end.** The implementer builds the whole change before running the gate
  (a targeted test only to debug); a `chore` verifies after each checklist step, not each edit; the
  leader never asks for per-edit checks.
- **`typecheck` joins the gate.** `commands.typecheck` was detected and configured but never run.
  It is now a check (`--only typecheck`), cached like lint and tests, and in the default `required`
  set. `reins update` adds it to `required` and to the `Stop`/`SubagentStop`/`CI` profiles that run
  unit tests, wherever a typecheck command is configured.

## 0.11.0

### Fast lanes: process that scales to the task, Jev-assisted triage, and a gate that runs once

Fixes the "every task takes an hour" problem: an Expo upgrade spent about an hour drafting each spec
and another hour executing it, because every task — a typo or an auth rewrite — paid for discovery,
EARS specs, two human gates, and a full review. On top of that, every `Edit`/`Write` re-ran the
whole test suite.

- **Lanes.** Every task is triaged into `quick` (typo, copy, rename: implementer → gate, not queued,
  no reviewer), `chore` (SDK upgrades, dependency bumps, codemods: an upstream-guide checklist worked
  in an apply → verify → fix loop, one regression review, no gate), `standard` (one-page
  `specs/<slug>/plan.md`, **one** approval, implementer + reviewer) or `full` (the existing
  discovery → spec → approval pipeline). The implementer and reviewer scale what they read and
  write to the lane, so a chore no longer produces a Four R's essay.
- **`reins route "<task>"`** recommends the lane, complexity, implementer model and effort,
  reviewers, and human gate. The leader runs it first for every task and passes the models on to
  its subagents (`haiku` for trivial edits, `opus` for large risky work). Two rules hold whatever the
  classifier says: security-sensitive work is never `quick`, and `haiku` never implements
  `full`/`large` work.
- **Jev support.** With `TYPESAFE_API_KEY` set (environment or a literal `export` in a shell rc file),
  `reins route` asks Jev all five triage questions in one request (~300–500 ms). Answers below
  `router.minConfidence` fall back to a local keyword heuristic field by field; errors, timeouts, or
  a missing key fall back entirely. Only the task text and stack are sent. Configure under `router`
  in `reins.config.json` (`provider: auto | jev | heuristic`).
- **`/task <request>`** — a new everyday entry point: triage, tell the human the route in one line,
  run the lane.
- **Faster `/brainstorm`.** Each feature gets a lane; discovery runs for all `standard`/`full`
  features in parallel, every open question is asked in one message, `full` specs are drafted in
  parallel, and approval is a single round. Several features may now be `analyzing` at once — only
  `in_progress` is limited to one.
- **A gate that runs once, not on every edit.**
  - The `PostToolUse` hook now lints just the edited file (from the hook payload) instead of
    running lint + the full test suite on every `Edit`/`Write`.
  - `verify --changed` actually scopes lint and tests: new `commands.lintChanged` /
    `commands.testChanged` (with a `{files}` placeholder) are detected from the stack — eslint/biome,
    jest/jest-expo (`--findRelatedTests`), vitest (`related`), ruff — and fall back to the full
    command when absent. Untracked files count as changed; nothing changed now means nothing to
    check (it used to mean "scan everything").
  - **Result cache** — a passing lint/test run is recorded against a fingerprint of the working tree
    (`.reins/cache/verify-results.json`), and the next run on an identical tree reuses it — so the
    reviewer, the leader, and the Stop hook no longer each re-run a suite the implementer just ran.
    Edits under `progress/`, `specs/`, and `feature_list.json` don't invalidate test results.
    Failures are never cached, CI never uses the cache, and `--no-cache` / `verify.cache: false`
    force a real run.
- `feature_list.json` features carry an optional `lane` (`reins add-feature --lane`); `verify` checks
  each lane's artifacts (`full`: discovery + spec, `standard`: `plan.md`, `quick`/`chore`: none). A
  feature without a lane is `full`, so existing queues behave as before. `reins status` shows lanes.
- **Verification budget.** `reins route` also sets how much verification a task gets — e2e
  `none`/`smoke`/`full`, and on Expo/React Native projects the native builds per platform (1 outside
  the `full` lane) and whether a release/archive build is in scope (only when the task is about
  shipping). The implementer builds once and reuses the build, reports every build and e2e run with
  its duration, and moves device/visual checks to a _Human checklist_; the reviewer doesn't ask for
  verification beyond the budget; `spec_author` sizes verification requirements to the change; and
  `/brainstorm` keeps an upgrade as **one** `chore` feature. (Measured on a real Expo SDK 57 upgrade:
  of 3.7 h of implementer time, 2.2 h were native builds and e2e/visual passes, repeated across three
  features.)
- **Telemetry fixed.** `SubagentStop` records used to read the _main_ session transcript, so every
  line was the cumulative usage of the whole session so far (summing them overstated cost by orders
  of magnitude), and usage repeated on every content block of a message was counted each time (~2.6×
  on cache reads). Records (`"v": 2`) now come from the subagent's own transcript
  (`agent_transcript_path`, or the session's `subagents/` layout), count each message once, and
  carry the role, description, wall time, hook time, and shell time split into build / e2e / test /
  install. Each subagent is recorded once. Pricing is updated to current list prices (Opus 5.5,
  Sonnet 5.5, Haiku 4.5, Fable 5/5.1, Opus 4.5–4.8). Older records are kept but excluded from totals.
- **`reins telemetry report`** — runs, time, build/e2e/test/hook time, tokens, and cost by role, for
  the latest session (or `--session <id|all>`). `reins status` now shows real per-session numbers.
- **Upgrading:** `reins update` adds `commands.lintChanged`/`testChanged` (detected), `verify.cache`,
  and `router`, and replaces `verify.perHook.PostToolUse` only if it is still the old
  `["lint", "unit"]` default.

## 0.10.0

### Dependency-audit allowlist and a Stop hook that can't loop forever

Fixes a real-world trap: a project with 52 high-severity findings from 3 unfixable root advisories
(`braces`, `node-forge`, `image-size` via metro) blocked every Stop, every turn, forever — and the
only escape, `failOn: "critical"`, also hid every _new_ high finding.

- **Per-advisory allowlist** — `security.depsAudit.ignore: [{ "id", "reason", "until" }]`. Matches
  any ID the auditor reports (GHSA, CVE, PYSEC, RUSTSEC, GO, npm advisory number), case-insensitive.
  An allowlisted **root** advisory also suppresses everything it causes down npm's `via` chain, so
  one entry covers one root cause. `reason` and `until` are required (config error otherwise); once
  `until` passes the entry stops applying and verify fails with
  `ignore for GHSA-… expired on …, re-evaluate`. Nothing is hidden silently: the gate reports
  `no vulnerabilities >= high (52 ignored via 3 allowlisted advisories, earliest expiry 2026-11-05)`
  and flags entries that no longer match anything.
- **Every auditor `tool: "auto"` can select** is now parsed into one model — npm (v7+ and v6),
  pnpm, yarn classic and berry, pip-audit, cargo-audit, and govulncheck (called vulnerabilities
  only). `tool` is honored when set explicitly, and Rust/Go projects get an audit for the first time.
- **Stop baseline** (`verify.stop.baselinePreexisting`, default `true`) — SessionStart snapshots the
  lockfiles into `.reins/cache/` (the first verify of the session is the fallback). On Stop, a
  security failure made only of advisories that pre-date the session, with the lockfile unchanged,
  becomes a non-blocking `warn` that names them and suggests a fix or the allowlist (surfaced to the
  user via Claude Code's `systemMessage`). New advisories, or a lockfile change that leaves findings
  unresolved, still block; secret leaks and expired allowlist entries always do.
- **Repeat-block guard** (`verify.stop.maxRepeatBlocks`, default `3`, `0` = off) — after N identical
  Stop blocks with no file changes in between, Stop stops blocking with a "repeated identical Stop
  block, giving up" message that hands `reins verify` back to a human. Only the Stop hook is
  released; CI and pre-commit are unaffected.
- The session id comes from the hook's stdin payload (or `--session`); reading it never hangs a
  manual run.
- Readable config errors: `security.depsAudit.ignore[0].reason: reason is required …` instead of a
  raw Zod dump, in both `reins verify` and `reins doctor`.
- `reins doctor` checks the allowlist: **fail** on an expired entry, **warn** 14 days ahead.
- `docs/security.md` documents the allowlist, `docs/verification.md` the Stop policy, and the
  `security-reviewer` now blocks unapproved allowlist entries (allowlisting is a human decision).
- **Upgrading:** `reins update` adds `verify.stop` and `security.depsAudit.ignore: []` to an existing
  `reins.config.json` (additively — no existing value changes), refreshes the docs and agents, and
  adds `.reins/cache/` to the managed `.gitignore` block.

## 0.9.0

### Design quality — a native anti-"AI slop" pillar

- New **`docs/design.md`** is the anti-slop review contract: an **implementer pre-flight** (infer the
  brief, respect the existing design system, ship every state — empty/loading/error — and all
  supported themes, no placeholder copy), six **disciplines** (typography, color, layout & spacing,
  components, accessibility, content & voice) each with implementer conditions + reviewer checks, and
  a **"Slop tells" blocklist** (gradient text, side-stripe borders, the generic indigo→cyan palette,
  oversized centered heroes, emoji-as-icons, hover-scale-on-everything, placeholder content, …) that
  blocks on sight. Distilled natively from the design-skill ecosystem — no external install.
- New **`docs/motion.md`** is the motion/animation contract: when to animate vs not, a motion
  vocabulary (≈150–250ms, ease-out enters / ease-in exits, spring vs tween, proportional distance),
  and conditions for `prefers-reduced-motion`, compositor-friendly properties, and interruptible
  motion.
- New **`design-reviewer`** agent (Claude Code + opencode), parallel to `security-reviewer`: read-only,
  audits any UI-touching diff against `docs/design.md` + `docs/motion.md`, writes a `## Design`
  section into `progress/review_<feature>.md`, and replies `DESIGN_OK` / `DESIGN_BLOCK`. New installs
  default it to `sonnet`; existing harnesses keep `inherit`.
- New **`design` verify check** — a deterministic, no-LLM scan of UI files
  (`.css`/`.scss`/`.tsx`/`.jsx`/`.vue`/`.svelte`/`.astro`/`.html`/`.mdx`) for the mechanically-detectable
  Slop tells: **block** on placeholder `Lorem ipsum` and gradient text (`bg-clip-text` +
  `text-transparent`); **advisory** on the generic indigo/violet→pink/cyan gradient palette, default
  glassmorphism, hover-scale-on-everything, and arbitrary off-scale spacing. It is checkpoint **C6**
  (UI-only — skips cleanly on backend diffs and `--changed` runs that touch no UI), tunable via
  `reins.config.json` → `design.slopScan` (`enabled`, `failOn`), and the `design-reviewer` runs it as
  its floor before applying judgment. Run it directly with `reins verify --only design`.
- New **`/design-audit [path]`** slash command audits existing UI on demand (outside the feature
  flow) — it scopes a set of UI files and runs the `design-reviewer` over them, reporting `[block]`
  vs `[advisory]` findings.
- **Wired across the harness.** The `implementer` now reads the design docs and runs their pre-flight
  on UI work; the `leader`, `/next-feature`, and `/autopilot` invoke the `design-reviewer` for
  UI-touching changes; `CHECKPOINTS.md` and `docs/four-rs.md` note design quality as the
  design-reviewer's domain (the Four R's judge the code; the design-reviewer judges what the user
  sees). `reins add-agent design-reviewer --from …` enables custom style variants.
- **Existing harnesses are unaffected**: the new role defaults to `inherit`, and `design` is added to
  `verify.required` for **new installs only** (an existing `reins.config.json` is create-only, so its
  required list is preserved — opt in by adding `"design"`). The docs, agent, and check arrive on
  `reins update`.

## 0.8.0

### Ghost mode — use Reins without committing it

- New **`reins init --ghost`** installs the full harness into the working tree but
  keeps it **out of git**. It writes every generated path to **`.git/info/exclude`**
  (git's local, never-committed ignore file), leaves the tracked `.gitignore`
  untouched, and skips the CI workflow (a non-committed workflow never runs).
  Nothing about Reins shows up in `git status`, diffs, or history.
- Everything else is identical to a committed install: the files are on disk, so
  agents/commands/settings load normally and the verification gate (including the
  `--changed` hook) runs natively at the repo root. Ideal for a monorepo where you
  want the harness locally but never pushed.
- The mode is recorded in `.reins/manifest.json` (`gitExcluded: true`):
  **`reins update`** re-syncs the `.git/info/exclude` block as new files appear, and
  **`reins doctor`** reports a `ghost` check (and flags drift if the block falls
  behind). Ghost ignores are per-clone — re-run `reins init --ghost` after a fresh
  clone; teammates don't inherit the harness, by design.

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
