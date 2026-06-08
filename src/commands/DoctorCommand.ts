import path from "node:path";
import { Command, Option } from "clipanion";
import { runDoctorFix } from "../core/doctor/fix";
import { formatDoctorReport } from "../core/doctor/report";
import { computeDoctorExit, runDoctor } from "../core/doctor/runner";
import { REINS_VERSION } from "../index";

/**
 * `reins doctor` — executable health checks for the harness itself.
 *
 * Validates that the installed harness is complete and coherent (agents,
 * settings hooks, config, feature_list, progress, specs). Does not run the
 * project's own tests. Exit: 0 healthy, 1 problems, 2 not installed.
 */
export class DoctorCommand extends Command {
  static override paths = [["doctor"]];

  static override usage = Command.Usage({
    category: "Verification",
    description: "Check the health and integrity of the installed harness.",
  });

  cwd = Option.String("--cwd", { description: "Run as if started in this directory" });
  fix = Option.Boolean("--fix", false, {
    description: "Recreate missing files (never overwrites)",
  });
  json = Option.Boolean("--json", false, { description: "Machine-readable output" });

  async execute(): Promise<number> {
    const cwd = path.resolve(this.cwd ?? process.cwd());

    if (this.fix) {
      const created = await runDoctorFix(cwd);
      if (!this.json) {
        this.context.stdout.write(
          created.length
            ? `Recreated ${created.length} missing file(s):\n${created.map((f) => `  + ${f}`).join("\n")}\n`
            : "Nothing to fix (or no reins.config.json found).\n",
        );
      }
    }

    const report = await runDoctor(cwd, REINS_VERSION);

    if (this.json) {
      this.context.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      this.context.stdout.write(formatDoctorReport(report));
    }

    return computeDoctorExit(report);
  }
}
