import path from "node:path";
import { ZodError } from "zod";
import { readJsonIfExists } from "../fs/read";
import { ReinsConfigSchema, type ReinsConfig } from "./schema";

/** `security.depsAudit.ignore.0.reason` → `security.depsAudit.ignore[0].reason`. */
function formatPath(segments: (string | number)[]): string {
  return segments.reduce<string>(
    (acc, seg) => (typeof seg === "number" ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg),
    "",
  );
}

/** One line per issue, e.g. `security.depsAudit.ignore[0].reason: reason is required`. */
export function formatConfigError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => `${formatPath(issue.path) || "(root)"}: ${issue.message}`)
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load and validate `reins.config.json` from a project.
 * Returns null when the file is absent; throws (with a readable, per-field
 * message) when it is invalid.
 */
export async function loadConfig(cwd: string): Promise<ReinsConfig | null> {
  const raw = await readJsonIfExists(path.join(cwd, "reins.config.json"));
  if (raw == null) return null;
  const parsed = ReinsConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(formatConfigError(parsed.error));
  return parsed.data;
}
