import type { CheckId, CommandSpec } from "../config/schema";
import { runShell } from "../exec/run-command";
import { fail, pass, skip, type CheckContext, type CheckResult } from "./types";

function specToString(spec: CommandSpec | null): string | null {
  if (spec == null) return null;
  return typeof spec === "string" ? spec : spec.cmd;
}

function specTimeout(spec: CommandSpec | null): number | undefined {
  return spec != null && typeof spec !== "string" ? spec.timeoutMs : undefined;
}

function tail(text: string, lines = 8): string {
  return text.split("\n").filter(Boolean).slice(-lines).join("\n");
}

async function runCommandCheck(
  id: CheckId,
  spec: CommandSpec | null,
  ctx: CheckContext,
): Promise<CheckResult> {
  const command = specToString(spec);
  if (!command) return skip(id, "no command configured");

  const start = Date.now();
  const res = await runShell(command, { cwd: ctx.cwd, timeoutMs: specTimeout(spec) });
  const durationMs = Date.now() - start;

  if (res.timedOut) return fail(id, "timed out", durationMs);
  if (res.exitCode === 0) return pass(id, command, durationMs);
  return fail(
    id,
    `\`${command}\` exited ${res.exitCode}`,
    durationMs,
    tail(res.stdout + "\n" + res.stderr),
  );
}

export const lintCheck = (ctx: CheckContext): Promise<CheckResult> =>
  runCommandCheck("lint", ctx.config.commands.lint, ctx);

export const unitCheck = (ctx: CheckContext): Promise<CheckResult> =>
  runCommandCheck("unit", ctx.config.commands.test, ctx);

export const e2eCheck = (ctx: CheckContext): Promise<CheckResult> =>
  runCommandCheck("e2e", ctx.config.commands.e2e, ctx);

export const integrationCheck = async (_ctx: CheckContext): Promise<CheckResult> =>
  skip("integration", "no separate integration command configured");
