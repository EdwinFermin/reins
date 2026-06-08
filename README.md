<p align="center">
  <img src="https://raw.githubusercontent.com/EdwinFermin/reins/main/assets/reins-icon-dark.png" alt="reins logo" width="120" height="120" />
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
  commands/          reins-verify, reins-status, next-feature (+ new-spec, approve-spec for sdd)
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

`--name <id>` · `--tools "Read, Grep, …"` · `--from <role>` · `--cwd <dir>` · `--json`

### `reins status`

Show the active feature, the queue, and session cost/token telemetry.

`--cwd <dir>` · `--json`

### `reins telemetry record`

Internal — invoked by the `SubagentStop` hook to append best-effort subagent
cost/token usage to `progress/telemetry.jsonl`. Always exits `0`.

## The loop

```
pending ──▶ (sdd: spec_author → spec_ready → human approval) ──▶ in_progress
   ▲                                                                  │
   └──────────── done ◀── reviewer + security-reviewer ◀── implementer ┘
```

The `leader` orchestrates; subagents write results to `progress/` and reply with a
one-line reference; `reins verify` gates every step; exactly one feature is
`in_progress` at a time.

## Configuration

`reins.config.json` (generated, editable) drives the gate:

```jsonc
{
  "preset": "sdd",
  "stack": { "language": "node", "packageManager": "pnpm" },
  "commands": { "test": "pnpm test", "lint": "pnpm run lint", "e2e": null },
  "verify": { "required": ["lint", "unit", "security", "feature-list", "traceability"] },
  "security": { "depsAudit": { "failOn": "high" }, "secretScan": { "failOnAny": true } },
}
```

## Requirements

- Node.js ≥ 18.19
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (the harness targets its agents, hooks, and permissions)

## License

MIT © betta-tech
