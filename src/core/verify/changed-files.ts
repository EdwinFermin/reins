import { stat } from "node:fs/promises";
import path from "node:path";
import { runShell } from "../exec/run-command";
import type { CheckContext } from "./types";

function splitLines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0);
}

async function gitLines(command: string, cwd: string): Promise<string[] | null> {
  const res = await runShell(command, { cwd, timeoutMs: 30_000 });
  return res.exitCode === 0 ? splitLines(res.stdout) : null;
}

async function isFile(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

/** Normalize to a cwd-relative, forward-slash path; null if it escapes cwd. */
export function toRelative(cwd: string, file: string): string | null {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * The files a `--changed` run should look at, relative to `ctx.cwd`, existing
 * files only (a deleted file can't be linted or scanned):
 *
 * - an explicit `ctx.changedFiles` (the file a PostToolUse hook just edited);
 * - PreCommit: the staged set — what is about to be committed;
 * - otherwise: staged ∪ unstaged ∪ untracked, so files an agent just created
 *   count too.
 *
 * Returns [] when nothing changed — never "everything".
 */
export async function listChangedFiles(ctx: CheckContext): Promise<string[]> {
  let candidates: string[];
  if (ctx.changedFiles && ctx.changedFiles.length > 0) {
    candidates = ctx.changedFiles;
  } else if (ctx.hook === "PreCommit") {
    candidates =
      (await gitLines("git diff --cached --name-only --diff-filter=ACMR", ctx.cwd)) ?? [];
  } else {
    const staged = await gitLines("git diff --cached --name-only --diff-filter=ACMR", ctx.cwd);
    const unstaged = await gitLines("git diff --name-only --diff-filter=ACMR", ctx.cwd);
    const untracked = await gitLines("git ls-files --others --exclude-standard", ctx.cwd);
    candidates = [...(staged ?? []), ...(unstaged ?? []), ...(untracked ?? [])];
  }

  const out = new Set<string>();
  for (const file of candidates) {
    const rel = toRelative(ctx.cwd, file);
    if (rel && (await isFile(path.join(ctx.cwd, rel)))) out.add(rel);
  }
  return [...out].sort();
}

/** Quote a path for a POSIX shell (cmd.exe gets double quotes). */
export function shellQuote(file: string): string {
  if (/^[A-Za-z0-9._/@+-]+$/.test(file)) return file;
  if (process.platform === "win32") return `"${file.replace(/"/g, '\\"')}"`;
  return `'${file.replace(/'/g, `'\\''`)}'`;
}

/** Substitute `{files}` in a scoped command, or append the files when it has no placeholder. */
export function withFiles(command: string, files: string[]): string {
  const list = files.map(shellQuote).join(" ");
  return command.includes("{files}") ? command.split("{files}").join(list) : `${command} ${list}`;
}
