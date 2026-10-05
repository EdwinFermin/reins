import path from "node:path";
import { Command, Option } from "clipanion";
import { loadConfig } from "../core/config/load";
import { readHookSessionId } from "../core/verify/hook-input";
import { formatReport } from "../core/verify/report";
import { computeExitCode, parseCheckIds, runVerify } from "../core/verify/runner";
import { SESSION_HOOKS, sessionTrackingEnabled } from "../core/verify/stop-guard";

/**
 * `reins verify` — the cross-platform "law" verifier.
 *
 * Runs lint/tests/e2e/security checks per the resolved profile. Returns 0 when
 * no required check failed, 1 otherwise. Under --hook Stop|SubagentStop|PostToolUse
 * it returns exit code 2 (blocking Claude Code) and writes the reason to stderr.
 *
 * Under --hook Stop it also applies `verify.stop`: findings that pre-date the
 * session don't block, and an identical block repeated N times is released.
 */
export class VerifyCommand extends Command {
  static override paths = [["verify"]];

  static override usage = Command.Usage({
    category: "Verification",
    description: "Run the project verification gate (lint, tests, e2e, security).",
  });

  cwd = Option.String("--cwd", { description: "Run as if started in this directory" });
  hook = Option.String("--hook", {
    description: "Context: PostToolUse | Stop | SubagentStop | PreCommit | CI",
  });
  session = Option.String("--session", {
    description: "Agent session id (defaults to the hook payload on stdin)",
  });
  only = Option.String("--only", { description: "Comma-separated subset of checks to run" });
  changed = Option.Boolean("--changed", false, { description: "Limit checks to changed files" });
  json = Option.Boolean("--json", false, { description: "Machine-readable output" });
  quiet = Option.Boolean("--quiet,-q", false, { description: "Only print the summary" });

  async execute(): Promise<number> {
    const cwd = path.resolve(this.cwd ?? process.cwd());

    let config: Awaited<ReturnType<typeof loadConfig>> = null;
    try {
      config = await loadConfig(cwd);
    } catch (err) {
      this.context.stderr.write(`Invalid reins.config.json: ${(err as Error).message}\n`);
      return 1;
    }
    if (!config) {
      this.context.stderr.write("No reins.config.json found. Run `reins init` first.\n");
      return 1;
    }

    let only;
    if (this.only) {
      const { ids, invalid } = parseCheckIds(this.only);
      if (invalid.length > 0) {
        this.context.stderr.write(`Unknown check(s): ${invalid.join(", ")}\n`);
        return 1;
      }
      only = ids;
    }

    let sessionId = this.session ?? null;
    if (!sessionId && this.hook && SESSION_HOOKS.has(this.hook) && sessionTrackingEnabled(config)) {
      sessionId = await readHookSessionId(this.context.stdin);
    }

    const report = await runVerify({
      cwd,
      config,
      only,
      hook: this.hook,
      changed: this.changed,
      sessionId,
    });
    const code = computeExitCode(report, this.hook);

    if (this.json) {
      this.context.stdout.write(
        JSON.stringify(
          {
            ok: report.ok,
            profile: report.profile,
            results: report.results,
            notices: report.notices,
            gaveUp: report.gaveUp,
          },
          null,
          2,
        ) + "\n",
      );
    } else if (
      this.hook === "Stop" &&
      config.runtime === "claude" &&
      code === 0 &&
      report.notices.length > 0
    ) {
      // A passing Stop hook's stdout is hidden from the user in Claude Code;
      // a JSON systemMessage is the documented way to surface a warning.
      this.context.stdout.write(
        JSON.stringify({ systemMessage: `Reins verify (Stop): ${report.notices.join(" ")}` }) +
          "\n",
      );
    } else {
      this.context.stdout.write(formatReport(report, { hook: this.hook, quiet: this.quiet }));
    }

    if (code === 2) {
      const failed = report.requiredFailed.map((r) => r.id).join(", ");
      const notes = report.notices.length ? ` ${report.notices.join(" ")}` : "";
      this.context.stderr.write(
        `\nReins blocked the ${this.hook} hook: required check(s) failed — ${failed}.${notes} ` +
          "Fix them, or run `reins verify` to see details.\n",
      );
    } else if (report.gaveUp) {
      this.context.stderr.write(`\nReins: ${report.notices.join(" ")}\n`);
    }
    return code;
  }
}
