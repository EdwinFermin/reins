import type { DetectedCommand, StackProfile } from "../detect/types";
import { ReinsConfigSchema, type CheckId, type Preset, type ReinsConfig } from "./schema";

function cmdValue(c?: DetectedCommand): string | null {
  return c ? c.value : null;
}

/** Build a valid default `reins.config` from a detected stack profile + preset. */
export function buildDefaultConfig(opts: {
  profile: StackProfile;
  preset: Preset;
  harnessVersion: string;
}): ReinsConfig {
  const { profile, preset, harnessVersion } = opts;

  const required: CheckId[] =
    preset === "sdd"
      ? ["lint", "unit", "security", "feature-list", "traceability"]
      : ["lint", "unit", "security", "feature-list"];

  // `.parse` accepts unknown input and fills every schema default, so the
  // result is guaranteed valid and fully typed.
  return ReinsConfigSchema.parse({
    $schema: "https://unpkg.com/reins/schema/reins.config.schema.json",
    harnessVersion,
    preset,
    stack: {
      language: profile.language,
      packageManager: profile.packageManager,
      frameworks: profile.frameworks,
    },
    commands: {
      test: cmdValue(profile.commands.test),
      build: cmdValue(profile.commands.build),
      lint: cmdValue(profile.commands.lint),
      e2e: cmdValue(profile.commands.e2e),
      typecheck: cmdValue(profile.commands.typecheck),
    },
    verify: {
      required,
      perHook: {
        PostToolUse: ["lint", "unit"],
        PreCommit: ["lint", "security"],
        Stop: required,
        CI: required,
      },
    },
    thresholds: {
      maxSubagentsPerSession: 12,
      maxSessionCostUsd: 5,
    },
    // Cost-aware defaults for new installs only: the schema default is
    // "inherit" everywhere, so existing harnesses keep their behavior on
    // `reins update`. security-reviewer stays on the session model — it is the
    // blocking security gate and runs rarely, so downgrading it buys little.
    agents: {
      leader: { model: "inherit" },
      implementer: { model: "inherit" },
      reviewer: { model: "sonnet" },
      "security-reviewer": { model: "inherit" },
      spec_author: { model: "sonnet" },
    },
  });
}
