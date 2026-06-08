import path from "node:path";
import { readJsonIfExists } from "../fs/read";
import { ReinsConfigSchema, type ReinsConfig } from "./schema";

/**
 * Load and validate `reins.config.json` from a project.
 * Returns null when the file is absent; throws (ZodError) when it is invalid.
 */
export async function loadConfig(cwd: string): Promise<ReinsConfig | null> {
  const raw = await readJsonIfExists(path.join(cwd, "reins.config.json"));
  if (raw == null) return null;
  return ReinsConfigSchema.parse(raw);
}
