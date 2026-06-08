import path from "node:path";
import { Command, Option } from "clipanion";
import { formatUpdateReport } from "../core/update/report";
import { runUpdate } from "../core/update/run";
import { REINS_VERSION } from "../index";

/**
 * `reins update` — update harness templates to the installed CLI version,
 * preserving user changes via a three-way merge against the manifest baseline.
 * Dry run by default; `--yes` applies, `--force` overwrites conflicts.
 */
export class UpdateCommand extends Command {
  static override paths = [["update"]];

  static override usage = Command.Usage({
    category: "Setup",
    description: "Update the harness templates to the installed CLI version.",
  });

  cwd = Option.String("--cwd", { description: "Run as if started in this directory" });
  yes = Option.Boolean("--yes,-y", false, { description: "Apply changes (default is a dry run)" });
  force = Option.Boolean("--force", false, {
    description: "Overwrite conflicts (saves your copy as .orig)",
  });
  only = Option.String("--only", { description: "Only update files matching this glob/path" });
  json = Option.Boolean("--json", false, { description: "Machine-readable output" });

  async execute(): Promise<number> {
    const cwd = path.resolve(this.cwd ?? process.cwd());
    const result = await runUpdate({
      cwd,
      harnessVersion: REINS_VERSION,
      apply: this.yes,
      force: this.force,
      only: this.only,
    });

    if (this.json) {
      this.context.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      this.context.stdout.write(formatUpdateReport(result));
    }

    if (!result.installed) return 2;
    if (result.applied && result.conflicts.length > 0) return 1;
    return 0;
  }
}
