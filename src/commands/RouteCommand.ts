import path from "node:path";
import { Command, Option } from "clipanion";
import { loadConfig } from "../core/config/load";
import { ROUTER_PROVIDERS, type RouterConfig } from "../core/config/schema";
import { detectStack } from "../core/detect";
import { formatRoute } from "../core/route/report";
import { routeTask } from "../core/route/run";
import type { RouteContext } from "../core/route/types";

/**
 * `reins route "<task>"` — triage a task before any work starts: its lane
 * (quick / chore / standard / full), complexity, the models to use, which
 * reviewers to run, and which human gate it needs. Asks Jev when
 * TYPESAFE_API_KEY is set; falls back to a local heuristic otherwise.
 */
export class RouteCommand extends Command {
  static override paths = [["route"]];

  static override usage = Command.Usage({
    category: "Workflow",
    description: "Triage a task: pick its lane, complexity, models, and reviewers (Jev-assisted).",
    details: `
      The leader runs this first for every task. The answer is a recommendation:
      the leader may override it with a stated reason.

      With TYPESAFE_API_KEY set (and \`router.provider\` "auto" or "jev" in
      reins.config.json) the task text is classified by Jev; otherwise, or when
      Jev is unreachable or unsure, a local keyword heuristic decides.
    `,
    examples: [
      ["Triage a task", 'reins route "upgrade Expo to SDK 55"'],
      ["Machine-readable", 'reins route --json "fix the typo on the login button"'],
      ["Offline only", 'reins route --provider heuristic "add CSV export to reports"'],
    ],
  });

  task = Option.Rest({ required: 1, name: "task" });
  cwd = Option.String("--cwd", { description: "Run as if started in this directory" });
  provider = Option.String("--provider", {
    description: `Override router.provider: ${ROUTER_PROVIDERS.join(" | ")}`,
  });
  json = Option.Boolean("--json", false, { description: "Machine-readable output" });

  async execute(): Promise<number> {
    const cwd = path.resolve(this.cwd ?? process.cwd());
    const text = this.task.join(" ").trim();
    if (!text) {
      this.context.stderr.write('Describe the task, e.g. reins route "upgrade Expo to SDK 55"\n');
      return 1;
    }
    if (this.provider && !(ROUTER_PROVIDERS as readonly string[]).includes(this.provider)) {
      this.context.stderr.write(
        `Unknown provider "${this.provider}" (use ${ROUTER_PROVIDERS.join(", ")})\n`,
      );
      return 1;
    }

    let config: Awaited<ReturnType<typeof loadConfig>> = null;
    try {
      config = await loadConfig(cwd);
    } catch (err) {
      this.context.stderr.write(`Invalid reins.config.json: ${(err as Error).message}\n`);
      return 1;
    }

    // Routing works without a harness too: fall back to a detected stack.
    let context: RouteContext;
    if (config) {
      context = {
        preset: config.preset,
        language: config.stack.language,
        frameworks: config.stack.frameworks,
      };
    } else {
      const profile = await detectStack(cwd);
      context = { preset: "lite", language: profile.language, frameworks: profile.frameworks };
    }

    const decision = await routeTask(text, {
      context,
      router: config?.router,
      provider: this.provider as RouterConfig["provider"] | undefined,
    });

    this.context.stdout.write(
      this.json ? JSON.stringify(decision, null, 2) + "\n" : formatRoute(decision),
    );
    return 0;
  }
}
