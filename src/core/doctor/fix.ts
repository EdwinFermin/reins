import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load";
import { pathExists } from "../fs/read";
import { buildHarnessFiles } from "../render/catalog";
import { buildTemplateContext } from "../render/context";
import { normalizeText } from "../util/hash";

/**
 * Recreate any missing harness files from templates. Never overwrites or backs
 * up existing files — `--fix` only fills gaps. Returns the paths it created.
 */
export async function runDoctorFix(cwd: string): Promise<string[]> {
  const config = await loadConfig(cwd);
  if (!config) return [];

  const ctx = buildTemplateContext(config, {
    projectName: path.basename(cwd),
    date: new Date().toISOString().slice(0, 10),
  });
  const files = buildHarnessFiles(config, ctx);

  const created: string[] = [];
  for (const file of files) {
    const abs = path.join(cwd, file.destRel);
    if (await pathExists(abs)) continue;
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, normalizeText(file.content), "utf8");
    created.push(file.destRel);
  }
  return created;
}
