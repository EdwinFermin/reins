import path from "node:path";
import { Command, Option } from "clipanion";
import { recordTelemetry } from "../core/telemetry/record";
import {
  formatTelemetrySummary,
  readTelemetry,
  summarizeTelemetry,
} from "../core/telemetry/report";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 2_000).unref();
  });
}

/**
 * `reins telemetry record` — invoked by the SubagentStop hook. Reads the hook
 * payload from stdin, appends best-effort cost/token usage to
 * progress/telemetry.jsonl, and always exits 0 (never blocks the agent).
 */
export class TelemetryCommand extends Command {
  static override paths = [["telemetry", "record"]];

  static override usage = Command.Usage({
    category: "Internal",
    description: "Record subagent cost/token telemetry (invoked by hooks).",
  });

  hook = Option.String("--hook", { description: "The hook event that triggered this" });
  cwd = Option.String("--cwd", { description: "Project directory" });

  async execute(): Promise<number> {
    const cwd = path.resolve(this.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    try {
      const payloadJson = await readStdin();
      await recordTelemetry({ cwd, payloadJson, hook: this.hook, now: new Date().toISOString() });
    } catch {
      // Telemetry must never fail a hook.
    }
    return 0;
  }
}

/**
 * `reins telemetry report` — where the time went: subagent runs by role, wall
 * time, shell time split into builds / e2e / tests / installs, hook time,
 * tokens, and an estimated cost.
 */
export class TelemetryReportCommand extends Command {
  static override paths = [["telemetry", "report"]];

  static override usage = Command.Usage({
    category: "Workflow",
    description: "Show where subagent time and cost went, by role (latest session by default).",
    examples: [
      ["Latest session", "reins telemetry report"],
      ["Every session", "reins telemetry report --session all"],
    ],
  });

  cwd = Option.String("--cwd", { description: "Project directory" });
  session = Option.String("--session", {
    description: 'Session id or prefix, "latest" (default), or "all"',
  });
  json = Option.Boolean("--json", false, { description: "Machine-readable output" });

  async execute(): Promise<number> {
    const cwd = path.resolve(this.cwd ?? process.cwd());
    const data = await readTelemetry(cwd);
    if (!data) {
      this.context.stderr.write("No progress/telemetry.jsonl yet.\n");
      return 1;
    }
    const summary = summarizeTelemetry(data.records, data.legacy, this.session ?? "latest");
    this.context.stdout.write(
      this.json ? JSON.stringify(summary, null, 2) + "\n" : formatTelemetrySummary(summary),
    );
    return 0;
  }
}
