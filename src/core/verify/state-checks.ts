import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonIfExists, readTextIfExists } from "../fs/read";
import { fail, pass, skip, type CheckContext, type CheckResult } from "./types";

const VALID_STATES = new Set([
  "pending",
  "analyzing",
  "needs_clarification",
  "spec_ready",
  "in_progress",
  "done",
  "blocked",
]);

/** States that occupy the single active work slot — one feature at a time. */
const ACTIVE_STATES = new Set(["analyzing", "in_progress"]);

/** SDD states that must already have a recorded, human-validated discovery. */
const REQUIRES_DISCOVERY = new Set(["needs_clarification", "spec_ready", "in_progress"]);

interface FeatureListShape {
  features?: { slug?: string; state?: string }[];
}

/**
 * Validate feature_list.json: present, parseable, valid states, ≤1 active
 * (analyzing/in_progress), and — for SDD — a discovery.md before the spec pipeline.
 */
export async function featureListCheck(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const data = await readJsonIfExists<FeatureListShape>(path.join(ctx.cwd, "feature_list.json"));
  if (data == null)
    return fail("feature-list", "feature_list.json missing or invalid JSON", Date.now() - start);

  const features = Array.isArray(data.features) ? data.features : null;
  if (!features)
    return fail("feature-list", "feature_list.json has no `features` array", Date.now() - start);

  const active = features.filter((f) => typeof f.state === "string" && ACTIVE_STATES.has(f.state));
  const badStates = features.filter(
    (f) => typeof f.state === "string" && !VALID_STATES.has(f.state),
  );

  if (active.length > 1) {
    return fail(
      "feature-list",
      `${active.length} features active — only one may be analyzing/in_progress`,
      Date.now() - start,
      active.map((f) => `- ${f.slug ?? "?"} (${f.state})`).join("\n"),
    );
  }
  if (badStates.length > 0) {
    return fail(
      "feature-list",
      `invalid state(s): ${badStates.map((f) => f.state).join(", ")}`,
      Date.now() - start,
    );
  }

  // SDD: a feature cannot enter the spec/implementation pipeline without a
  // recorded, human-validated discovery.
  if (ctx.config.preset === "sdd") {
    const missing: string[] = [];
    for (const f of features) {
      if (typeof f.state !== "string" || !REQUIRES_DISCOVERY.has(f.state)) continue;
      if (typeof f.slug !== "string") continue;
      const text = await readTextIfExists(path.join(ctx.cwd, "specs", f.slug, "discovery.md"));
      if (!text || text.trim().length === 0) missing.push(`${f.slug} (${f.state})`);
    }
    if (missing.length > 0) {
      return fail(
        "feature-list",
        `${missing.length} feature(s) past discovery without specs/<slug>/discovery.md`,
        Date.now() - start,
        missing.map((s) => `- ${s}`).join("\n"),
      );
    }
  }

  const inProgress = features.filter((f) => f.state === "in_progress").length;
  return pass(
    "feature-list",
    `${features.length} feature(s), ${active.length} active, ${inProgress} in progress`,
    Date.now() - start,
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
