import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonIfExists, readTextIfExists } from "../fs/read";
import { fail, pass, skip, type CheckContext, type CheckResult } from "./types";

const VALID_STATES = new Set(["pending", "spec_ready", "in_progress", "done", "blocked"]);

interface FeatureListShape {
  features?: { slug?: string; state?: string }[];
}

/** Validate feature_list.json: present, parseable, ≤1 in_progress, valid states. */
export async function featureListCheck(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const data = await readJsonIfExists<FeatureListShape>(path.join(ctx.cwd, "feature_list.json"));
  const ms = Date.now() - start;
  if (data == null) return fail("feature-list", "feature_list.json missing or invalid JSON", ms);

  const features = Array.isArray(data.features) ? data.features : null;
  if (!features) return fail("feature-list", "feature_list.json has no `features` array", ms);

  const inProgress = features.filter((f) => f.state === "in_progress");
  const badStates = features.filter(
    (f) => typeof f.state === "string" && !VALID_STATES.has(f.state),
  );

  if (inProgress.length > 1) {
    return fail(
      "feature-list",
      `${inProgress.length} features in_progress (max 1)`,
      ms,
      inProgress.map((f) => `- ${f.slug ?? "?"}`).join("\n"),
    );
  }
  if (badStates.length > 0) {
    return fail(
      "feature-list",
      `invalid state(s): ${badStates.map((f) => f.state).join(", ")}`,
      ms,
    );
  }
  return pass(
    "feature-list",
    `${features.length} feature(s), ${inProgress.length} in progress`,
    ms,
  );
}

/** SDD only: every requirement Rn in each spec must be referenced by its tasks. */
export async function traceabilityCheck(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const specsDir = path.join(ctx.cwd, "specs");
  const entries = await readdir(specsDir, { withFileTypes: true }).catch(() => []);
  const featureDirs = entries
    .filter((e) => e.isDirectory() && e.name !== "_template")
    .map((e) => e.name);

  if (featureDirs.length === 0)
    return skip("traceability", "no feature specs yet", Date.now() - start);

  const missing: string[] = [];
  for (const feature of featureDirs) {
    const requirements =
      (await readTextIfExists(path.join(specsDir, feature, "requirements.md"))) ?? "";
    const tasks = (await readTextIfExists(path.join(specsDir, feature, "tasks.md"))) ?? "";
    const rIds = [...requirements.matchAll(/^##\s*(R\d+)\b/gm)]
      .map((m) => m[1])
      .filter((x): x is string => Boolean(x));
    for (const rId of rIds) {
      if (!tasks.includes(rId)) missing.push(`${feature}:${rId}`);
    }
  }
  const ms = Date.now() - start;
  if (missing.length > 0) {
    return fail(
      "traceability",
      `${missing.length} requirement(s) not covered by a task`,
      ms,
      missing.join("\n"),
    );
  }
  return pass("traceability", "every requirement maps to a task", ms);
}
