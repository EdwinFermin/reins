import path from "node:path";
import { Command, Option } from "clipanion";
import { isCancel, select } from "@clack/prompts";
import { RUNTIMES, type Preset, type Runtime } from "../core/config/schema";
import { runInit, type RunInitResult } from "../core/init/run";
import { REINS_VERSION } from "../index";

/**
 * `reins init` — install the harness into the current project.
 *
 * Detects the stack, scaffolds the harness idempotently (agents, hooks, docs,
 * state) and writes `.reins/manifest.json`.
 */
export class InitCommand extends Command {
  static override paths = [["init"]];

  static override usage = Command.Usage({
    category: "Setup",
    description: "Install the Reins harness into the current project.",
    details: `
      Auto-detects the project stack, then scaffolds the multi-agent harness
      (\`.claude/agents\`, hooks, \`docs/\`, \`progress/\`, \`feature_list.json\`,
      \`reins.config.json\`) without overwriting your files, and records what it
      generated in \`.reins/manifest.json\`.
    `,
    examples: [
      ["Interactive install", "reins init"],
      ["Non-interactive, SDD preset", "reins init --preset sdd --yes"],
      ["Keep the harness out of git (monorepos)", "reins init --ghost --yes"],
      ["Preview without writing", "reins init --dry-run"],
    ],
  });

  preset = Option.String("--preset", { description: "Harness preset: lite | sdd" });
  runtime = Option.String("--runtime", {
    description: "Target agent runtime: claude | opencode",
  });
  cwd = Option.String("--cwd", { description: "Run as if started in this directory" });
  yes = Option.Boolean("--yes,-y", false, {
    description: "Non-interactive; use detection + defaults",
  });
  dryRun = Option.Boolean("--dry-run", false, {
    description: "Show the plan without writing anything",
  });
  ci = Option.Boolean("--ci", true, { description: "Write a CI workflow (use --no-ci to skip)" });
  gitHook = Option.Boolean("--git-hook", true, {
    description: "Install the pre-commit hook (use --no-git-hook to skip)",
  });
  ghost = Option.Boolean("--ghost", false, {
    description: "Keep the harness out of git via .git/info/exclude (no commit, no CI)",
  });
  force = Option.Boolean("--force", false, {
    description: "Overwrite without backup (discouraged)",
  });
  json = Option.Boolean("--json", false, { description: "Machine-readable output" });

  async execute(): Promise<number> {
    const cwd = path.resolve(this.cwd ?? process.cwd());

    if (this.preset != null && this.preset !== "lite" && this.preset !== "sdd") {
      this.context.stderr.write(`Unknown preset "${this.preset}". Use "lite" or "sdd".\n`);
      return 1;
    }
    if (this.runtime != null && !(RUNTIMES as readonly string[]).includes(this.runtime)) {
      this.context.stderr.write(
        `Unknown runtime "${this.runtime}". Use ${RUNTIMES.join(" or ")}.\n`,
      );
      return 1;
    }

    const interactive = !this.yes && Boolean(process.stdout.isTTY) && !this.json;

    let preset = this.preset as Preset | undefined;
    if (!preset) {
      if (interactive) {
        const chosen = await promptPreset();
        if (chosen == null) {
          this.context.stderr.write("Cancelled.\n");
          return 1;
        }
        preset = chosen;
      } else {
        preset = "lite";
      }
    }

    let runtime = this.runtime as Runtime | undefined;
    if (!runtime) {
      if (interactive) {
        const chosen = await promptRuntime();
        if (chosen == null) {
          this.context.stderr.write("Cancelled.\n");
          return 1;
        }
        runtime = chosen;
      } else {
        runtime = "claude";
      }
    }

    const result = await runInit({
      cwd,
      preset,
      runtime,
      harnessVersion: REINS_VERSION,
      dryRun: this.dryRun,
      force: this.force,
      installGitHook: this.gitHook,
      writeCi: this.ci,
      gitExclude: this.ghost,
    });

    if (this.json) {
      this.context.stdout.write(
        JSON.stringify(serialize(result, cwd, this.dryRun), null, 2) + "\n",
      );
    } else {
      this.context.stdout.write(renderSummary(result, cwd, this.dryRun));
    }
    return 0;
  }
}

async function promptPreset(): Promise<Preset | null> {
  const choice = await select({
    message: "Which harness preset?",
    options: [
      {
        value: "sdd",
        label: "sdd",
        hint: "specs + human approval gate + traceability (recommended)",
      },
      { value: "lite", label: "lite", hint: "leader / implementer / reviewer + verification" },
    ],
    initialValue: "sdd",
  });
  if (isCancel(choice)) return null;
  return choice as Preset;
}

async function promptRuntime(): Promise<Runtime | null> {
  const choice = await select({
    message: "Which agent runtime?",
    options: [
      {
        value: "claude",
        label: "claude",
        hint: "Claude Code (.claude/, CLAUDE.md, settings hooks)",
      },
      { value: "opencode", label: "opencode", hint: ".opencode/, AGENTS.md, verify plugin" },
    ],
    initialValue: "claude",
  });
  if (isCancel(choice)) return null;
  return choice as Runtime;
}

function countActions(result: RunInitResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of result.outcomes) {
    counts[outcome.action] = (counts[outcome.action] ?? 0) + 1;
  }
  return counts;
}

function serialize(result: RunInitResult, cwd: string, dryRun: boolean): unknown {
  return {
    preset: result.preset,
    runtime: result.runtime,
    cwd,
    dryRun,
    stack: {
      language: result.profile.language,
      packageManager: result.profile.packageManager ?? null,
      frameworks: result.profile.frameworks,
    },
    gitHookInstalled: result.gitHookInstalled,
    gitExcluded: result.gitExcluded,
    actions: countActions(result),
    files: result.outcomes,
  };
}

function renderSummary(result: RunInitResult, cwd: string, dryRun: boolean): string {
  const lines: string[] = [];
  const prefix = dryRun ? "[dry run] " : "";
  const pm = result.profile.packageManager ? ` (${result.profile.packageManager})` : "";
  const frameworks = result.profile.frameworks.length
    ? result.profile.frameworks.join(", ")
    : "none";

  lines.push("");
  lines.push(
    `${prefix}Reins ${result.preset} harness (${result.runtime}) ${dryRun ? "would be installed" : "installed"} in ${cwd}`,
  );
  lines.push(`  Stack: ${result.profile.language}${pm} · frameworks: ${frameworks}`);

  const counts = countActions(result);
  const summary = Object.entries(counts)
    .map(([action, n]) => `${n} ${action}`)
    .join(", ");
  lines.push(`  Files: ${summary}`);

  for (const outcome of result.outcomes) {
    if (outcome.note) {
      lines.push(`  • ${outcome.destRel}: ${outcome.note}`);
    }
  }
  if (!dryRun && result.hasGit) {
    lines.push(
      `  Git hook: ${result.gitHookInstalled ? "installed (.git/hooks/pre-commit)" : "skipped (already present)"}`,
    );
  }
  if (result.gitExcluded) {
    lines.push(
      `  Ghost mode: harness kept out of git via .git/info/exclude (local-only; re-run \`reins init --ghost\` after a fresh clone)`,
    );
  } else if (result.gitExcludeSkippedNoGit) {
    lines.push(
      "  Ghost mode: requested but no git repo found — run `git init`, then re-run `reins init --ghost`",
    );
  }

  lines.push("");
  lines.push("Next steps:");
  lines.push(
    result.runtime === "opencode"
      ? "  • Open opencode — the `leader` is the primary agent."
      : "  • Open Claude Code — the agent will act as the `leader`.",
  );
  lines.push("  • reins doctor      check the harness is healthy");
  lines.push("  • reins verify      run the verification gate");
  if (result.preset === "sdd") {
    lines.push("  • reins add-feature <slug> --with-spec   draft your first spec");
  } else {
    lines.push("  • reins add-feature <slug>               queue your first feature");
  }
  lines.push("");
  return lines.join("\n");
}
