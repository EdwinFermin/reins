<p align="center">
  <img src="https://raw.githubusercontent.com/EdwinFermin/reins/main/assets/reins-icon-dark.svg" alt="reins logo" width="120" height="120" />
</p>

# reins

> Put the reins on your AI agent.

**Reins** installs and maintains a controlled, multi-agent **harness** on top of an
existing project, so an AI agent (Claude Code or opencode) deploys subagents in a way
that is **structured, secure, verifiable, and reproducible**.

It generalizes the harness pattern — disjoint agent roles, state-on-disk, an
executable verification gate, and enforced hooks — into a single CLI you run on
any repository.

```bash
npm install -g @fermin-dev/reins   # or: npx @fermin-dev/reins <command>
cd your-project
reins init                  # scaffold the harness (auto-detects your stack)
reins doctor                # check the harness is healthy
reins verify                # run the verification gate (lint + tests + security)
```

## Why

When an agent edits your repo freely, you get drift, unverifiable changes, and no
guard rails. Reins makes the repository itself the control surface:

- **Disjoint roles** — a `leader` orchestrates and never writes code; an
  `implementer` does one feature at a time; a `reviewer`, `security-reviewer`, and
  `design-reviewer` approve or reject.
- **State on disk, not chat** — `progress/` (append-only history + subagent
  reports) and `feature_list.json` (one feature in progress at a time) survive
  restarts and context limits.
- **Process that scales to the task** — every task is triaged into a **lane**
  (`quick`, `chore`, `standard`, `full`) by `reins route`, optionally with
  [Jev](#jev-assisted-triage) as the classifier. A typo goes straight to the
  implementer; an Expo upgrade runs a checklist loop with one review; only risky
  or ambiguous work pays for discovery, specs, and two human gates.
- **Verification is law** — `reins verify` is wired into your agent (Claude Code
  hooks, or an opencode plugin), so a failing required check is enforced before a
  session ends (Claude Code hard-blocks via exit code `2`; see
  [Runtimes](#runtimes)).
- **The Four R's** — beyond the mechanical gate, every change is reviewed against an
  explicit contract — **Risk, Readability, Reliability, Resilience** — that the
  `implementer` builds to and the `reviewer` audits (see `docs/four-rs.md`).
- **Design quality** — UI changes are held to an anti-"AI slop" contract
  (`docs/design.md` + `docs/motion.md`): an implementer pre-flight, six design
  disciplines, and a "slop tells" blocklist — enforced both by a deterministic
  `reins verify --only design` scan and a `design-reviewer` that blocks
  generated-looking, design-system-breaking, or inaccessible UI.
- **Idempotent & updatable** — `reins init` never clobbers your files;
  `reins update` migrates the harness with a three-way merge that keeps your edits.

## Presets

| Preset     | What you get                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`lite`** | `leader` / `implementer` / `reviewer` / `security-reviewer` / `design-reviewer`, the verification gate, the **Four R's** review contract (Risk, Readability, Reliability, Resilience), and the **Design quality** anti-slop contract |
| **`sdd`**  | everything in `lite`, plus a Spec-Driven layer scaled by lane: a one-page plan and one approval for `standard` work; `spec_author`, EARS requirements, two human gates, and **requirement↔test traceability** for `full` work        |

## Runtimes

Pick the agent runtime at install time with `reins init --runtime <claude|opencode>`
(interactive otherwise; defaults to `claude`). A project gets **one** runtime — the
same agents, presets, and verification gate, emitted in the form each tool reads.

| Runtime        | Agents               | Commands               | Rules file                               | Gate wiring                                                                                                                            |
| -------------- | -------------------- | ---------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **`claude`**   | `.claude/agents/*`   | `.claude/commands/*`   | `CLAUDE.md` (imports `AGENTS.md`)        | `.claude/settings.json` hooks (`Stop` hard-blocks a red tree via exit 2)                                                               |
| **`opencode`** | `.opencode/agents/*` | `.opencode/commands/*` | `AGENTS.md` (opencode reads it natively) | `.opencode/plugins/reins-verify.ts` runs the gate on `file.edited` + `session.idle`, and `opencode.json` carries the permission policy |

The runtime-neutral parts (`docs/`, `CHECKPOINTS.md`, `feature_list.json`,
`progress/`, CI workflow, `reins.config.json`) are identical either way, and
`reins verify` / `doctor` / `update` / `add-agent` all follow `runtime` in
`reins.config.json`.

> **opencode enforcement is softer.** Unlike Claude Code's `Stop` hook, an
> opencode plugin can't hard-stop a finished session — the gate runs and reports
> a red tree loudly, but treat a failing check as "not done" rather than a hard
> block. Per-role **model pinning** also differs: opencode wants a full
> `provider/model` ID (e.g. `anthropic/claude-sonnet-4-5`); Reins' `sonnet`/`opus`
> aliases and `effort` are Claude-only and are omitted for opencode agents.

## What `reins init` generates

```
.claude/
  agents/            leader, implementer, reviewer, security-reviewer, design-reviewer (+ spec_author for sdd)
  commands/          task, reins-verify, reins-status, next-feature, autopilot, brainstorm, design-audit (+ new-spec, approve-spec, validate-discovery for sdd)
  settings.json      hooks (verify on edit/stop, telemetry on SubagentStop) + permission allowlist
CLAUDE.md            root instructions; imports @AGENTS.md
AGENTS.md            navigation map of the harness
CHECKPOINTS.md       objective review checklist (each maps to an executable check)
docs/                architecture, conventions, verification, security, four-rs, design, motion (+ sdd-workflow)
feature_list.json    the work queue + its state machine
progress/            current.md, history.md (append-only), subagent reports, telemetry.jsonl
specs/_template/     plan (standard lane) · discovery / requirements (EARS) / design / tasks (full lane)   (sdd only)
reins.config.json    stack, commands, and which checks the gate runs
.github/workflows/   reins-verify.yml (CI runs the same gate)
.reins/manifest.json what Reins generated + hashes (for updates)
```

The tree above is the `claude` runtime; `--runtime opencode` emits the
`.opencode/` equivalents and an `AGENTS.md` rules file instead (see
[Runtimes](#runtimes)).

Existing files are respected: `settings.json` / `opencode.json` are deep-merged,
`.gitignore` gets a managed block, an existing `CLAUDE.md` / `AGENTS.md` gets a
`*.reins.md` sidecar, and anything Reins replaces is backed up under
`.reins-backup/`.

## Commands

### `reins init`

Install the harness into the current project.

`--preset <lite|sdd>` · `--runtime <claude|opencode>` · `--yes, -y` (non-interactive) ·
`--dry-run` · `--no-ci` · `--no-git-hook` · `--ghost` · `--force` · `--cwd <dir>` · `--json`

#### Ghost mode — use Reins without committing it (monorepos / personal harness)

`reins init --ghost` installs the full harness into the working tree but keeps it
**out of git**: it writes every generated path to **`.git/info/exclude`** (git's
local, per-clone ignore file, which lives inside `.git/` and is never committed),
leaves your tracked `.gitignore` untouched, and skips the CI workflow (a
non-committed workflow never runs). Nothing about Reins — not the files, not the
ignore rules — shows up in `git status`, diffs, or history.

Everything else works exactly as a committed install: the files are physically
present, so Claude Code/opencode load the agents, commands and settings, and the
verification gate (including the `--changed` hook, which `git diff`s at the repo
root) runs natively. This is ideal for a monorepo where you want the harness
locally but never pushed.

Caveats: ghost ignores are **per-clone** — re-run `reins init --ghost` after a
fresh clone, and teammates don't inherit the harness (by design). `.git/info/exclude`
only hides _untracked_ files; a path already committed needs `git rm --cached` first.
`reins update` and `reins doctor` understand ghost mode (recorded in
`.reins/manifest.json`): update re-syncs the exclude block as new files appear, and
doctor reports drift.

### `reins verify`

Run the verification gate: `lint`, `unit`, `integration`, `e2e`, `security`
(dependency audit + secret scan), `design` (a deterministic UI "slop tells" scan;
skips when there are no UI files), `feature-list`, and (sdd) `traceability`.
Exit `0` ok, `1` a required check failed, and `2` + a block message under the
`PostToolUse` / `Stop` / `SubagentStop` hooks.

`--hook <PostToolUse|Stop|SubagentStop|PreCommit|CI>` · `--only <a,b,…>` ·
`--changed` · `--no-cache` · `--quiet, -q` · `--cwd <dir>` · `--json`

The gate runs **per milestone, not per edit** — a change in progress passes
through broken intermediate states, and checking those only costs time:

- **While editing** — nothing. (No `PostToolUse` hook; the implementer may run a
  targeted test to debug.)
- **Implementer finishes** — the full gate, **enforced** by a `SubagentStop`
  hook for the agents in `verify.gateAgents` (default `implementer`): a red tree
  sends it back to fix. Reviewers and explorers are never gated. The same
  baseline and repeat-guard policy as `Stop` keeps it from looping.
- **Chore checkpoints** — after each step of an upgrade checklist,
  `--changed` runs lint + only the tests **related** to the changed files
  (`commands.lintChanged` / `commands.testChanged`, detected from your stack —
  e.g. `npx jest --findRelatedTests … {files}`, `npx vitest related --run {files}`)
  plus typecheck.
- **Session end and CI** — the full gate, with lint/typecheck/test passes reused
  from a **result cache** when the working tree is unchanged. Failures are never
  cached, CI never uses the cache, and `--no-cache` / `"verify": { "cache": false }`
  forces a real run.

`typecheck` (`commands.typecheck`) is part of the default gate.
`verify.perHook.<Hook>` lists exactly the checks a hook runs (an empty list runs
nothing; an unlisted hook runs `required`).

### `reins route "<task>"`

Triage a task before any work starts. Prints the recommended **lane**, the
complexity, the implementer model and effort, the reviewers to run, and the human
gate the lane needs. The `leader` runs it first for every task (`/task` does it
for you); the answer is advice the leader may override with a stated reason.

| Lane       | For                                                   | Process                                                                    | Human gates (sdd) |
| ---------- | ----------------------------------------------------- | -------------------------------------------------------------------------- | ----------------- |
| `quick`    | typo, copy, style tweak, rename, one-line fix         | implementer → gate; not queued, no spec, no reviewer                       | none              |
| `chore`    | Expo/RN/Next SDK upgrades, dependency bumps, codemods | upstream-guide checklist, apply → verify → fix loop, one regression review | none              |
| `standard` | ordinary features and bug fixes                       | one-page `specs/<slug>/plan.md` → implementer → reviewer                   | one               |
| `full`     | auth, payments, data model, architecture, large/vague | discovery → spec (`spec_author`) → implementer → every applicable reviewer | two               |

`--json` · `--provider <auto|jev|heuristic>` · `--cwd <dir>`

```bash
reins route "upgrade Expo to SDK 55"
# Route — chore lane (fast) · via Jev
#   Complexity:  medium
#   Implementer: sonnet (effort medium)
#   Reviewers:   reviewer (sonnet)
#   Human gate:  none — implement right away
#   Verify:      smoke e2e · ≤1 native build(s)/platform · no release build
```

Two rules hold whatever the classifier says: security-sensitive work is never
`quick`, and `haiku` never implements `full`/`large` work.

The route also sets a **verification budget**, because on mobile projects builds
and e2e suites — not specs — are where the hours go. Outside the `full` lane, e2e
is `smoke` (only the flows covering what changed); on Expo/React Native projects
the implementer gets **one native build per platform** for the whole task and no
release/archive build unless the task is about shipping. Checks only a human can
make (physical devices, visual polish) go into a _Human checklist_ in the report
instead of being simulated. An upgrade stays **one** `chore` feature: splitting it
into bump / fix / verify features multiplies native builds and reviews.

#### Jev-assisted triage

With `TYPESAFE_API_KEY` set, `reins route` asks Jev
(TypeSafe) five questions in a single request — lane, complexity, implementer
model, security-sensitive?, UI-touching? — and gets each answer with a confidence
(typically ~300–500 ms). Answers below `router.minConfidence` (default `0.6`) fall
back to a local keyword heuristic **field by field**, and any error, timeout, or
missing key falls back entirely; the output says which source decided. Only the
task text and your stack (language, frameworks) are sent — never code.

The key is read from the environment, or from a literal
`export TYPESAFE_API_KEY=…` line in your shell rc files (agent sessions don't
always source them).

`provider: "auto"` uses Jev when a key is set; `"jev"` or `"heuristic"` force one.

```json
"router": {
  "provider": "auto",
  "url": "https://api.typesafe.ai/v1/systemone",
  "model": "jev-latest",
  "timeoutMs": 4000,
  "minConfidence": 0.6
}
```

### `reins doctor`

Check the harness is complete and coherent (agents, hooks, config, docs, state,
version). Exit `0` healthy, `1` problems, `2` not installed.

`--fix` (recreate missing files, never overwrites) · `--cwd <dir>` · `--json`

### `reins update`

Update templates to the installed CLI version with a three-way merge that
preserves your edits. Dry run by default.

`--yes, -y` (apply) · `--force` (overwrite conflicts, saving your copy as `.orig`) ·
`--only <glob>` · `--cwd <dir>` · `--json`

### `reins add-feature <slug>`

Register a feature in `feature_list.json`.

`--title <text>` · `--lane <quick|chore|standard|full>` (default `full`) ·
`--with-spec` (scaffold `specs/<slug>/`) · `--depends-on <a,b>` · `--cwd <dir>` · `--json`

### `reins add-agent <role>`

Add a subagent from a template (`leader`, `implementer`, `reviewer`,
`security-reviewer`, `design-reviewer`, `spec_author`, or a custom role via `--from`).

`--name <id>` · `--tools "Read, Grep, …"` · `--from <role>` ·
`--model <alias|id|inherit>` · `--effort <low|medium|high|xhigh|max>` ·
`--cwd <dir>` · `--json`

```bash
reins add-agent explorer --from reviewer --model haiku --effort low
```

### `reins status`

Show the active feature, the queue, and session cost/token telemetry.

`--cwd <dir>` · `--json`

### `reins telemetry report`

Where the time went: subagent runs by role, wall time, shell time split into
**build / e2e / test / install**, hook time, tokens, and a list-price cost
estimate. Latest session by default.

`--session <id|latest|all>` · `--cwd <dir>` · `--json`

```
Reins telemetry — session 7be35953
  13 subagent run(s) · 280.9m of subagent time · ~$39.38 (list-price estimate)
  Shell time 161.4m: build 27.1m · e2e 108.5m · test 6.6m · install 0.6m · other 18.6m · hooks 6.1m

  role                 runs     time    build    e2e    test   hooks   out-tok    cost
  implementer             3   220.6m    26.7m 107.4m    4.0m    1.6m      235k  $23.76
  spec_author             4    36.3m     0.0m   0.1m    0.8m    4.3m      188k   $8.12
```

### `reins telemetry record`

Internal — invoked by the `SubagentStop` hook. Analyzes the finished subagent's
**own** transcript (`agent_transcript_path`) and appends one record to
`progress/telemetry.jsonl`. Always exits `0`.

## Slash commands (inside Claude Code or opencode)

`reins init` also installs slash commands — under `.claude/commands/` for the
`claude` runtime, or `.opencode/commands/` for `opencode`. You type them **in the
agent's chat** (not the terminal) and they drive the harness flow for you.
Arguments go right after the command, separated by spaces.

### `/task <what you want done>`

The everyday entry point. The leader triages the request with `reins route`,
tells you the route in one line (lane · complexity · model · reviewers), and runs
that lane — pausing only where the lane has a human gate.

```
/task fix the typo on the pricing page
/task upgrade Expo to SDK 55
/task add CSV export to the reports screen
```

### `/brainstorm <idea>`

Turns a rough idea into a sequence of small, ordered features. The leader
explores the codebase, proposes a breakdown (saved to
`progress/brainstorm_<epic>.md`), waits for your approval in chat, and then
registers the features honoring `dependsOn`, each with its own lane. Under the
`sdd` preset it continues into the spec pipeline — discovery for every
`standard`/`full` feature **in parallel**, all open questions in **one** message,
specs drafted in parallel, one approval round — until everything is `approved`
(`quick`/`chore` features need no approval and are ready right away).

```
/brainstorm a CLI flag to export reports as CSV and PDF
/brainstorm migrate user sessions from cookies to JWT
```

### `/next-feature [feature-slug]`

Starts work on the next feature in the dependency-ordered queue (or the one
you name), following its lane. `approved` features — and `quick`/`chore` ones,
which need no approval — go straight to implementation with no further
questions, then get the review their lane calls for. A `pending` `standard`
feature first gets its one-page plan; a `pending` `full` feature, discovery.

```
/next-feature
/next-feature csv-export
```

### `/autopilot`

The batch form of `/next-feature`: drives the **entire ready queue** to `done` in
one unattended run, one feature at a time. It implements every `approved` feature
plus `quick`/`chore` ones (`pending` under lite) whose dependencies are `done`, in dependency order. It
pauses once — showing the ordered queue and waiting for a single go-ahead — then
runs to completion with no further questions, halting and reporting on the first
blocker (a feature that ends up `blocked`, an unresolvable review, or a red tree).
It never brainstorms, writes specs, or asks discovery questions; queue the work
with `/brainstorm` first.

```
/autopilot
```

### `/design-audit [path]`

Audits existing UI for "AI slop" and design-system violations on demand, outside
the feature flow. The `leader` scopes a set of UI files (a path/component you name,
or the primary surfaces) and runs the `design-reviewer` over them against
`docs/design.md` + `docs/motion.md`, reporting `[block]` vs `[advisory]` findings
and what to fix first. It audits only — queue the fixes with `/brainstorm`.

```
/design-audit src/components
/design-audit
```

### `/reins-verify`

Runs the verification gate (`npx reins verify`) and summarizes which checks
passed, failed, or were skipped, and what to fix first.

```
/reins-verify
```

### `/reins-status`

Shows the harness status: active feature, queue of `pending`/`approved`
features, latest subagent reports under `progress/`, and session telemetry.

```
/reins-status
```

### `/new-spec <feature-slug>` _(sdd only)_

Launches `spec_author` to draft the three spec files for a feature
(`requirements.md` in EARS notation, `design.md`, `tasks.md` with
requirement↔test traceability).

```
/new-spec csv-export
```

### `/validate-discovery <feature-slug>` _(sdd only)_

For a feature stuck in `needs_clarification`: confirms the discovery's open
questions are answered, then launches `spec_author` to write the spec grounded
in the resolved discovery. Ends at `spec_ready`, waiting for `/approve-spec`.

```
/validate-discovery csv-export
```

### `/approve-spec <feature-slug>` _(sdd only)_

The human approval gate: verifies the plan (`standard` lane — answer its open
questions in the same message) or the spec (`full` lane) is complete and marks the
feature `approved`, ready for `/next-feature`. It never starts implementation itself.

```
/approve-spec csv-export
```

A typical session, end to end:

```
/task rename the "Save" button to "Save draft"   # quick: done in one pass, no ceremony
/task upgrade Expo to SDK 55                     # chore: checklist loop, one review
/brainstorm export reports as CSV and PDF   # decompose + (sdd) approve every spec in chat
/next-feature                               # implement the first feature, gate-free
/reins-status                               # see what's done and what's next
/next-feature                               # ...repeat until the queue is empty
# — or, once everything is approved, drain the whole queue in one run:
/autopilot                                  # implement every ready feature back-to-back
```

## The loop

```
pending ──▶ (sdd: discovery → spec_author → spec_ready → human approval → approved) ──▶ in_progress
   ▲                                                                                       │
   └─────────────── done ◀── reviewer + security-reviewer ◀── implementer ◀────────────────┘
```

The `leader` orchestrates; subagents write results to `progress/` and reply with a
one-line reference; `reins verify` gates every step; exactly one feature is
`in_progress` at a time. Every artifact saved to disk (specs, discoveries,
progress reports) is written in English, whatever language you chat in.

Have a bigger idea? `/brainstorm <idea>` decomposes it into several features,
waits for your approval, then queues them honoring `dependsOn`. Under sdd it then
walks each feature through discovery, your answers to its open questions, spec
authoring, and spec approval — so every feature ends up `approved` and
`/next-feature` implements them one at a time with no further questions or
approvals. `reins verify` rejects cycles and dangling references and won't let a
feature go `in_progress` before its dependencies are `done`, and `reins status`
lists the queue in dependency order (`approved` features ready to implement
first).

## Configuration

`reins.config.json` (generated, editable) drives the gate:

```jsonc
{
  "preset": "sdd",
  "stack": { "language": "node", "packageManager": "pnpm" },
  "commands": { "test": "pnpm test", "lint": "pnpm run lint", "e2e": null },
  "verify": {
    "required": ["lint", "unit", "security", "design", "feature-list", "traceability"],
    // Stop doesn't block on findings that pre-date the session, and gives up
    // after 3 identical blocks with no file changes (see docs/verification.md).
    "stop": { "baselinePreexisting": true, "maxRepeatBlocks": 3 },
  },
  "security": {
    "depsAudit": {
      "failOn": "high",
      // Per-advisory exceptions: reason + expiry are mandatory. See docs/security.md.
      "ignore": [
        { "id": "GHSA-vfj7-8cjw-p6xm", "reason": "no patched release", "until": "2026-11-05" },
      ],
    },
    "secretScan": { "failOnAny": true },
  },
  "design": { "slopScan": { "enabled": true, "failOn": "block" } },
  "agents": {
    "reviewer": { "model": "sonnet" },
    "spec_author": { "model": "sonnet", "effort": "medium" },
  },
}
```

### Per-role model & effort

Each agent role can pin the Claude Code **model** and **effort level** it runs
with, so cheaper models handle the less critical work:

- `model` — `sonnet`, `opus`, `haiku`, `fable`, a full model ID
  (e.g. `claude-haiku-4-5-20251001`), or `inherit` (default: use the session's
  model).
- `effort` — `low`, `medium`, `high`, `xhigh`, or `max`; omitted = inherit the
  session's effort. Available levels depend on the model (validated by Claude
  Code at runtime).

New installs default `reviewer`, `design-reviewer`, and `spec_author` to `sonnet`
and leave `leader`, `implementer`, and `security-reviewer` on `inherit`. Existing
harnesses keep `inherit` everywhere until you add an `agents` section to
`reins.config.json` and run `reins update`. Per-file overrides:
`reins add-agent … --model haiku --effort low`.

## Requirements

- Node.js ≥ 18.19
- One agent runtime (pick it at install time with `reins init --runtime <claude|opencode>`):
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — the harness targets its agents, hooks, and permissions; or
  - [opencode](https://opencode.ai) — agents, commands, and an auto-loaded verification plugin

## License

MIT © betta-tech
