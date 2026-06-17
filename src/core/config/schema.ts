import { z } from "zod";

export const PRESETS = ["lite", "sdd"] as const;
export const RUNTIMES = ["claude", "opencode"] as const;
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
export const AGENT_ROLES = [
  "leader",
  "implementer",
  "reviewer",
  "security-reviewer",
  "spec_author",
] as const;
export const MODEL_ALIASES = ["inherit", "sonnet", "opus", "haiku", "fable"] as const;
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const CommandSchema = z.union([
  z.string(),
  z.object({
    cmd: z.string(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);

// A model alias or a full model ID. Claude Code accepts bare IDs
// (e.g. "claude-sonnet-4-6"); opencode uses "provider/model"
// (e.g. "anthropic/claude-sonnet-4-5"). Only the shape is sanity-checked here.
export const AgentModelSchema = z.union([
  z.enum(MODEL_ALIASES),
  z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "expected a model alias or a full model ID"),
]);

const AgentPolicySchema = z
  .object({
    model: AgentModelSchema.default("inherit"),
    effort: z.enum(EFFORT_LEVELS).optional(),
  })
  .strict()
  .default({});

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
    runtime: z.enum(RUNTIMES).default("claude"),
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
    agents: z
      .object({
        leader: AgentPolicySchema,
        implementer: AgentPolicySchema,
        reviewer: AgentPolicySchema,
        "security-reviewer": AgentPolicySchema,
        spec_author: AgentPolicySchema,
      })
      .strict()
      .default({}),
  })
  .strict();

export type ReinsConfig = z.infer<typeof ReinsConfigSchema>;
export type ReinsConfigInput = z.input<typeof ReinsConfigSchema>;
export type Preset = (typeof PRESETS)[number];
export type Runtime = (typeof RUNTIMES)[number];
export type Language = (typeof LANGUAGES)[number];
export type CheckId = (typeof CHECK_IDS)[number];
export type HookName = (typeof HOOK_NAMES)[number];
export type CommandSpec = z.infer<typeof CommandSchema>;
export type AgentRole = (typeof AGENT_ROLES)[number];
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type AgentPolicy = z.infer<typeof AgentPolicySchema>;
