<p align="center">
  <img src="https://raw.githubusercontent.com/EdwinFermin/reins/main/assets/reins-icon-dark.svg" alt="reins logo" width="120" height="120" />
</p>

# reins

> Put the reins on your AI agent.

**Reins** installs and maintains a controlled, multi-agent **harness** on top of an
existing project, so an AI agent (Claude Code) deploys subagents in a way that is
**structured, secure, verifiable, and reproducible**.

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
  `implementer` does one feature at a time; a `reviewer` and `security-reviewer`
  approve or reject.
- **State on disk, not chat** — `progress/` (append-only history + subagent
  reports) and `feature_list.json` (one feature in progress at a time) survive
  restarts and context limits.
- **Verification is law** — `reins verify` is wired into Claude Code hooks, so a
  failing required check **blocks the session from ending** (exit code `2`).
- **Idempotent & updatable** — `reins init` never clobbers your files;
  `reins update` migrates the harness with a three-way merge that keeps your edits.

## Presets

| Preset     | What you get                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`lite`** | `leader` / `implementer` / `reviewer` / `security-reviewer` + the verification gate                                                                              |
| **`sdd`**  | everything in `lite`, plus a Spec-Driven layer: `spec_author`, EARS requirements, a **human approval gate** before coding, and **requirement↔test traceability** |

## What `reins init` generates

```
.claude/
  agents/            leader, implementer, reviewer, security-reviewer (+ spec_author for sdd)
  commands/          reins-verify, reins-status, next-feature, brainstorm (+ new-spec, approve-spec, validate-discovery for sdd)
  settings.json      hooks (verify on edit/stop, telemetry on SubagentStop) + permission allowlist
CLAUDE.md            root instructions; imports @AGENTS.md
AGENTS.md            navigation map of the harness
CHECKPOINTS.md       objective review checklist (each maps to an executable check)
docs/                architecture, conventions, verification, security (+ sdd-workflow)
feature_list.json    the work queue + its state machine
progress/            current.md, history.md (append-only), subagent reports, telemetry.jsonl
specs/_template/     requirements (EARS) / design / tasks   (sdd only)
reins.config.json    stack, commands, and which checks the gate runs
.github/workflows/   reins-verify.yml (CI runs the same gate)
.reins/manifest.json what Reins generated + hashes (for updates)
```

Existing files are respected: `settings.json` is deep-merged, `.gitignore` gets a
managed block, an existing `CLAUDE.md` gets a `CLAUDE.reins.md` sidecar, and
anything Reins replaces is backed up under `.reins-backup/`.

## Commands

### `reins init`

Install the harness into the current project.

`--preset <lite|sdd>` · `--yes, -y` (non-interactive) · `--dry-run` · `--no-ci` ·
`--no-git-hook` · `--force` · `--cwd <dir>` · `--json`

### `reins verify`

Run the verification gate: `lint`, `unit`, `integration`, `e2e`, `security`
(dependency audit + secret scan), `feature-list`, and (sdd) `traceability`.
Exit `0` ok, `1` a required check failed, and `2` + a block message under the
`PostToolUse` / `Stop` / `SubagentStop` hooks.

`--hook <PostToolUse|Stop|SubagentStop|PreCommit|CI>` · `--only <a,b,…>` ·
`--changed` · `--quiet, -q` · `--cwd <dir>` · `--json`

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

`--title <text>` · `--with-spec` (scaffold `specs/<slug>/`) ·
`--depends-on <a,b>` · `--cwd <dir>` · `--json`

### `reins add-agent <role>`

Add a subagent from a template (`leader`, `implementer`, `reviewer`,
`security-reviewer`, `spec_author`, or a custom role via `--from`).

`--name <id>` · `--tools "Read, Grep, …"` · `--from <role>` ·
`--model <alias|id|inherit>` · `--effort <low|medium|high|xhigh|max>` ·
`--cwd <dir>` · `--json`

```bash
reins add-agent explorer --from reviewer --model haiku --effort low
```

### `reins status`

Show the active feature, the queue, and session cost/token telemetry.

`--cwd <dir>` · `--json`

### `reins telemetry record`

Internal — invoked by the `SubagentStop` hook to append best-effort subagent
cost/token usage to `progress/telemetry.jsonl`. Always exits `0`.

## Slash commands (inside Claude Code)

`reins init` also installs slash commands under `.claude/commands/`. You type
them **in the Claude Code chat** (not the terminal) and they drive the harness
flow for you. Arguments go right after the command, separated by spaces.

### `/brainstorm <idea>`

Turns a rough idea into a sequence of small, ordered features. The leader
explores the codebase, proposes a breakdown (saved to
`progress/brainstorm_<epic>.md`), waits for your approval in chat, and then
registers the features honoring `dependsOn`. Under the `sdd` preset it
continues into the spec pipeline: discovery → your answers to its open
questions → spec → approval, feature by feature, until everything is
`approved`.

```
/brainstorm a CLI flag to export reports as CSV and PDF
/brainstorm migrate user sessions from cookies to JWT
```

### `/next-feature [feature-slug]`

Starts work on the next feature in the dependency-ordered queue (or the one
you name). `approved` features go straight to implementation — implementer,
then reviewer (and security-reviewer when the change touches auth, input, IO,
secrets, or dependencies) — with no further questions. `pending` features
(created outside a brainstorm) first go through discovery.

```
/next-feature
/next-feature csv-export
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

The human approval gate: verifies the spec is complete and marks the feature
`approved`, ready for `/next-feature`. It never starts implementation itself.

```
/approve-spec csv-export
```

A typical session, end to end:

```
/brainstorm export reports as CSV and PDF   # decompose + (sdd) approve every spec in chat
/next-feature                               # implement the first feature, gate-free
/reins-status                               # see what's done and what's next
/next-feature                               # ...repeat until the queue is empty
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
  "verify": { "required": ["lint", "unit", "security", "feature-list", "traceability"] },
  "security": { "depsAudit": { "failOn": "high" }, "secretScan": { "failOnAny": true } },
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

New installs default `reviewer` and `spec_author` to `sonnet` and leave
`leader`, `implementer`, and `security-reviewer` on `inherit`. Existing
harnesses keep `inherit` everywhere until you add an `agents` section to
`reins.config.json` and run `reins update`. Per-file overrides:
`reins add-agent … --model haiku --effort low`.

## Requirements

- Node.js ≥ 18.19
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (the harness targets its agents, hooks, and permissions)

## License

MIT © betta-tech
