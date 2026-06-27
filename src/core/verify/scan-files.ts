import { readdir } from "node:fs/promises";
import path from "node:path";
import { runShell } from "../exec/run-command";
import type { CheckContext } from "./types";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".reins-backup",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  "__pycache__",
]);

function splitLines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0);
}

async function walkFiles(root: string, dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 8 || out.length > 5_000) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      await walkFiles(root, path.join(dir, entry.name), out, depth + 1);
    } else if (entry.isFile()) {
      out.push(path.relative(root, path.join(dir, entry.name)));
    }
  }
}

/**
 * The repo's scannable files, relative to `ctx.cwd`: the changed/staged set when
 * `ctx.changed`, else every tracked file, else a bounded directory walk. Shared by
 * the secret scan and the design slop scan.
 */
export async function filesToScan(ctx: CheckContext): Promise<string[]> {
  if (ctx.changed) {
    const staged = await runShell("git diff --cached --name-only --diff-filter=ACM", {
      cwd: ctx.cwd,
    });
    if (staged.exitCode === 0 && staged.stdout.trim()) return splitLines(staged.stdout);
    const working = await runShell("git diff --name-only --diff-filter=ACM", { cwd: ctx.cwd });
    if (working.exitCode === 0 && working.stdout.trim()) return splitLines(working.stdout);
  }
  const tracked = await runShell("git ls-files", { cwd: ctx.cwd });
  if (tracked.exitCode === 0 && tracked.stdout.trim()) return splitLines(tracked.stdout);

  const walked: string[] = [];
  await walkFiles(ctx.cwd, ctx.cwd, walked, 0);
  return walked;
}

/** Detect a NUL byte (char code 0) — a reliable signal of a binary file. */
export function looksBinary(text: string): boolean {
  const limit = Math.min(text.length, 8_000);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}
