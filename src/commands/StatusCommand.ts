import path from "node:path";
import { Command, Option } from "clipanion";
import { loadConfig } from "../core/config/load";
import { formatStatus } from "../core/status/report";
import { getStatus } from "../core/status/run";
import { readHookSessionId } from "../core/verify/hook-input";
import { recordSessionStart, sessionTrackingEnabled } from "../core/verify/stop-guard";

/** `reins status` — show the active feature, queue, and session telemetry. */
export class StatusCommand extends Command {
  static override paths = [["status"]];

  static override usage = Command.Usage({
    category: "Verification",
    description: "Show the harness status: active feature, queue, and session telemetry.",
  });

  cwd = Option.String("--cwd", { description: "Run as if started in this directory" });
  hook = Option.String("--hook", { description: "Context the command is invoked from" });
  session = Option.String("--session", {
    description: "Agent session id (defaults to the hook payload on stdin)",
  });
  json = Option.Boolean("--json", false, { description: "Machine-readable output" });

  async execute(): Promise<number> {
    const cwd = path.resolve(this.cwd ?? process.cwd());
    if (this.hook === "SessionStart") await this.recordSessionStart(cwd);
    const status = await getStatus(cwd);

    if (this.json) {
      this.context.stdout.write(JSON.stringify(status, null, 2) + "\n");
    } else {
      this.context.stdout.write(formatStatus(status));
    }
    return 0;
  }

  /** Snapshot the lockfile so `verify --hook Stop` can tell pre-existing findings from new ones. */
  private async recordSessionStart(cwd: string): Promise<void> {
    try {
      const config = await loadConfig(cwd);
      if (!config || !sessionTrackingEnabled(config)) return;
      const sessionId = this.session ?? (await readHookSessionId(this.context.stdin));
      await recordSessionStart(cwd, sessionId);
    } catch {
      // The status report must never fail the session start.
    }
  }
}
