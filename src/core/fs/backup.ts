import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Copy an existing file into the backup root, preserving its relative path.
 * Returns the absolute backup path.
 */
export async function backupFile(
  absPath: string,
  backupRoot: string,
  relPath: string,
): Promise<string> {
  const dest = path.join(backupRoot, relPath);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(absPath, dest);
  return dest;
}
