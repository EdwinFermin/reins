import { readFile, stat } from "node:fs/promises";

/** True if a path exists (file or directory). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 file, returning null if it does not exist. */
export async function readTextIfExists(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** Read and parse a JSON file, returning null if missing or invalid. */
export async function readJsonIfExists<T = unknown>(p: string): Promise<T | null> {
  const text = await readTextIfExists(p);
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
