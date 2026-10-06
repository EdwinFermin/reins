import path from "node:path";
import type { CheckId, CommandSpec, Language } from "../config/schema";
import { runShell } from "../exec/run-command";
import { listChangedFiles, withFiles } from "./changed-files";
import { ResultCache } from "./result-cache";
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

/** Source files a scoped lint/test command can take, per stack. Null = any file. */
const SOURCE_EXT: Partial<Record<Language, Set<string>>> = {
  node: new Set([
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".vue",
    ".svelte",
    ".astro",
  ]),
  python: new Set([".py", ".pyi"]),
};

/** Above this many files a scoped run saves little and risks the command-line limit. */
const MAX_SCOPED_FILES = 200;

interface CommandCheckSpec {
  id: CheckId;
  full: CommandSpec | null;
  /** Scoped variant for `--changed` (`{files}` placeholder). */
  scoped?: CommandSpec | null;
}

async function exec(
  id: CheckId,
  command: string,
  spec: CommandSpec | null,
  ctx: CheckContext,
): Promise<{ result: CheckResult; ok: boolean }> {
  const start = Date.now();
  const res = await runShell(command, { cwd: ctx.cwd, timeoutMs: specTimeout(spec) });
  const durationMs = Date.now() - start;
  if (res.timedOut) return { result: fail(id, "timed out", durationMs), ok: false };
  if (res.exitCode === 0) return { result: pass(id, command, durationMs), ok: true };
  return {
    result: fail(
      id,
      `\`${command}\` exited ${res.exitCode}`,
      durationMs,
      tail(res.stdout + "\n" + res.stderr),
    ),
    ok: false,
  };
}

/**
 * `--changed` with a scoped command: run it on the changed source files only.
 * Returns null to fall back to the full command (no scoped variant, or too
 * many files for a scoped run to pay off).
 */
async function runScoped(spec: CommandCheckSpec, ctx: CheckContext): Promise<CheckResult | null> {
  const scoped = specToString(spec.scoped ?? null);
  if (!scoped) return null;
  const start = Date.now();
  const exts = SOURCE_EXT[ctx.config.stack.language];
  const files = (await listChangedFiles(ctx)).filter(
    (f) => !exts || exts.has(path.extname(f).toLowerCase()),
  );
  if (files.length === 0) return skip(spec.id, "no changed source files", Date.now() - start);
  if (files.length > MAX_SCOPED_FILES) return null;
  const { result } = await exec(spec.id, withFiles(scoped, files), spec.scoped ?? null, ctx);
  if (result.status === "pass") {
    result.summary = `${scoped.split("{files}")[0]!.trim()} (${files.length} changed file(s))`;
  }
  return result;
}

async function runCommandCheck(spec: CommandCheckSpec, ctx: CheckContext): Promise<CheckResult> {
  const command = specToString(spec.full);
  if (!command) return skip(spec.id, "no command configured");

  if (ctx.changed) {
    const scoped = await runScoped(spec, ctx);
    if (scoped) return scoped;
  }

  // A full-scope run (including `--changed` without a scoped variant) can reuse
  // a pass recorded on this exact tree. The runner withholds the cache for CI.
  const cache = ResultCache.isCacheable(spec.id) ? ctx.cache : undefined;
  let before: string | null = null;
  if (cache) {
    const { hit, fingerprint } = await cache.lookup(spec.id, command);
    if (hit) return pass(spec.id, `${command} (cached: tree unchanged since ${hit.at})`, 0);
    before = fingerprint;
  }

  const { result, ok } = await exec(spec.id, command, spec.full, ctx);
  if (ok && cache) await cache.store(spec.id, command, result.summary, before);
  return result;
}

export const lintCheck = (ctx: CheckContext): Promise<CheckResult> =>
  runCommandCheck(
    { id: "lint", full: ctx.config.commands.lint, scoped: ctx.config.commands.lintChanged },
    ctx,
  );

export const typecheckCheck = (ctx: CheckContext): Promise<CheckResult> =>
  runCommandCheck({ id: "typecheck", full: ctx.config.commands.typecheck }, ctx);

export const unitCheck = (ctx: CheckContext): Promise<CheckResult> =>
  runCommandCheck(
    { id: "unit", full: ctx.config.commands.test, scoped: ctx.config.commands.testChanged },
    ctx,
  );

export const e2eCheck = (ctx: CheckContext): Promise<CheckResult> =>
  runCommandCheck({ id: "e2e", full: ctx.config.commands.e2e }, ctx);

export const integrationCheck = async (_ctx: CheckContext): Promise<CheckResult> =>
  skip("integration", "no separate integration command configured");
