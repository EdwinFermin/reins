import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HASH_COMMENT, upsertManagedBlock, wrapManagedBlock } from "./markers";
import { readTextIfExists } from "./read";

/** Path (relative to the repo root) of git's local, never-committed ignore file. */
export const GIT_EXCLUDE_REL = path.join(".git", "info", "exclude");

/**
 * Top-level directories Reins owns outright. Their whole subtree is harness
 * output, so we collapse them to a single `/<dir>/` rule instead of listing
 * every file.
 */
const OWNED_DIRS = new Set([".claude", ".opencode", ".reins", "progress", "specs"]);

/** Always excluded regardless of preset/runtime: the replace-backups directory. */
const ALWAYS = ["/.reins-backup/"];

/**
 * Turn the harness's generated paths into anchored `.gitignore`-style rules.
 *
 * Wholly-owned directories collapse to `/<dir>/`; everything else (root files,
 * and generic dirs the monorepo may also use like `docs/` or `.github/`) is
 * listed as an exact, repo-root-anchored path so we never blanket-ignore a
 * directory the project owns. Sorted + de-duplicated; idempotent.
 */
export function gitExcludeEntries(paths: string[]): string[] {
  const set = new Set<string>(ALWAYS);
  for (const rel of paths) {
    const norm = rel.split(path.sep).join("/").replace(/^\/+/, "");
    if (!norm) continue;
    const top = norm.split("/")[0]!;
    set.add(OWNED_DIRS.has(top) ? `/${top}/` : `/${norm}`);
  }
  return [...set].sort();
}

export interface GitExcludeResult {
  path: string;
  action: "create" | "update" | "skip";
  entries: string[];
}

/**
 * Upsert Reins' managed block into `.git/info/exclude` so the harness is ignored
 * locally without ever being committed (the file lives inside `.git/`). Reuses
 * the same managed-block markers as `.gitignore`, so it only owns its own section.
 */
export async function upsertGitExclude(
  cwd: string,
  paths: string[],
  opts: { dryRun?: boolean } = {},
): Promise<GitExcludeResult> {
  const abs = path.join(cwd, GIT_EXCLUDE_REL);
  const entries = gitExcludeEntries(paths);
  const body = entries.join("\n");
  const existing = await readTextIfExists(abs);

  const persist = async (content: string): Promise<void> => {
    if (opts.dryRun) return;
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  };

  if (existing == null) {
    await persist(wrapManagedBlock(body, HASH_COMMENT) + "\n");
    return { path: GIT_EXCLUDE_REL, action: "create", entries };
  }
  const updated = upsertManagedBlock(existing, body, HASH_COMMENT);
  if (updated === existing) return { path: GIT_EXCLUDE_REL, action: "skip", entries };
  await persist(updated);
  return { path: GIT_EXCLUDE_REL, action: "update", entries };
}
