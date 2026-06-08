import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJsonIfExists } from "../fs/read";

export interface ManifestEntry {
  /** Path relative to the project root of the generated file. */
  path: string;
  templateId: string;
  /** SHA-256 of the content exactly as Reins wrote it (for three-way update). */
  hash: string;
}

export interface HarnessManifest {
  harnessVersion: string;
  preset: string;
  runtime: string;
  generatedAt: string;
  files: ManifestEntry[];
}

export const MANIFEST_REL = path.join(".reins", "manifest.json");

export async function readManifest(cwd: string): Promise<HarnessManifest | null> {
  return readJsonIfExists<HarnessManifest>(path.join(cwd, MANIFEST_REL));
}

export async function writeManifest(
  cwd: string,
  manifest: HarnessManifest,
  dryRun = false,
): Promise<void> {
  if (dryRun) return;
  const abs = path.join(cwd, MANIFEST_REL);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}
