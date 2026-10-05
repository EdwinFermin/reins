import path from "node:path";
import { readTextIfExists } from "../fs/read";
import { sha256 } from "../util/hash";

/** Dependency lockfiles across the ecosystems the audit supports. */
export const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "requirements.txt",
  "Cargo.lock",
  "go.sum",
] as const;

/**
 * One hash over every lockfile present at the project root, or null when there
 * are none. Used to tell "the dependency tree is the one the session started
 * with" apart from "the session changed dependencies".
 */
export async function lockfileHash(cwd: string): Promise<string | null> {
  const parts: string[] = [];
  for (const name of LOCKFILES) {
    const text = await readTextIfExists(path.join(cwd, name));
    if (text != null) parts.push(`${name}\0${text}`);
  }
  return parts.length ? sha256(parts.join("\0")) : null;
}
