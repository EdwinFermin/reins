import { z } from "zod";

export const PRESETS = ["lite", "sdd"] as const;
export const LANGUAGES = ["node", "python", "go", "rust", "ruby", "java", "other"] as const;
export const CHECK_IDS = [
  "lint",
  "unit",
  "integration",
  "e2e",
  "security",
  "feature-list",
  "traceability",
] as const;
export const HOOK_NAMES = [
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "PreCommit",
  "CI",
] as const;

const CommandSchema = z.union([
  z.string(),
  z.object({
    cmd: z.string(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);

export const SecurityGatesSchema = z.object({
  depsAudit: z
    .object({
      enabled: z.boolean().default(true),
      tool: z
        .enum(["auto", "npm", "pnpm", "yarn", "pip-audit", "cargo-audit", "govulncheck"])
        .default("auto"),
      failOn: z.enum(["low", "moderate", "high", "critical"]).default("high"),
    })
    .default({}),
  secretScan: z
    .object({
      enabled: z.boolean().default(true),
      tool: z.enum(["auto", "gitleaks", "builtin"]).default("auto"),
      failOnAny: z.boolean().default(true),
    })
    .default({}),
});

export const ReinsConfigSchema = z
  .object({
    $schema: z.string().optional(),
    harnessVersion: z.string(),
    preset: z.enum(PRESETS),
    runtime: z.literal("claude").default("claude"),
    stack: z.object({
      language: z.enum(LANGUAGES),
      packageManager: z.string().optional(),
      frameworks: z.array(z.string()).default([]),
    }),
    commands: z.object({
      test: CommandSchema.nullable().default(null),
      build: CommandSchema.nullable().default(null),
      lint: CommandSchema.nullable().default(null),
      e2e: CommandSchema.nullable().default(null),
      typecheck: CommandSchema.nullable().default(null),
    }),
    verify: z
      .object({
        required: z.array(z.enum(CHECK_IDS)).default(["lint", "unit", "security", "feature-list"]),
        perHook: z.record(z.enum(HOOK_NAMES), z.array(z.enum(CHECK_IDS))).default({}),
      })
      .default({}),
    security: SecurityGatesSchema.default({}),
    thresholds: z
      .object({
        coverageMin: z.number().min(0).max(100).optional(),
        maxSubagentsPerSession: z.number().int().positive().optional(),
        maxSessionCostUsd: z.number().positive().optional(),
      })
      .default({}),
    telemetry: z
      .object({
        enabled: z.boolean().default(true),
        pricingTable: z.string().optional(),
      })
      .default({}),
  })
  .strict();

export type ReinsConfig = z.infer<typeof ReinsConfigSchema>;
export type ReinsConfigInput = z.input<typeof ReinsConfigSchema>;
export type Preset = (typeof PRESETS)[number];
export type Language = (typeof LANGUAGES)[number];
export type CheckId = (typeof CHECK_IDS)[number];
export type HookName = (typeof HOOK_NAMES)[number];
export type CommandSpec = z.infer<typeof CommandSchema>;
