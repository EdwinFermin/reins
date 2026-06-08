import path from "node:path";
import { Command, Option } from "clipanion";
import { formatStatus } from "../core/status/report";
import { getStatus } from "../core/status/run";

/** `reins status` — show the active feature, queue, and session telemetry. */
export class StatusCommand extends Command {
  static override paths = [["status"]];

  static override usage = Command.Usage({
    category: "Verification",
    description: "Show the harness status: active feature, queue, and session telemetry.",
  });

  cwd = Option.String("--cwd", { description: "Run as if started in this directory" });
  hook = Option.String("--hook", { description: "Context the command is invoked from" });
  json = Option.Boolean("--json", false, { description: "Machine-readable output" });

  async execute(): Promise<number> {
    const cwd = path.resolve(this.cwd ?? process.cwd());
    const status = await getStatus(cwd);

    if (this.json) {
      this.context.stdout.write(JSON.stringify(status, null, 2) + "\n");
    } else {
      this.context.stdout.write(formatStatus(status));
    }
    return 0;
  }
}
