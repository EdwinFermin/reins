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
  "design",
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
  "design-reviewer",
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

export const DesignGatesSchema = z.object({
  slopScan: z
    .object({
      enabled: z.boolean().default(true),
      // "block" = only block-severity tells fail; "advisory" = any tell fails.
      failOn: z.enum(["advisory", "block"]).default("block"),
    })
    .default({}),
});

export const AUDIT_TOOLS = [
  "auto",
  "npm",
  "pnpm",
  "yarn",
  "pip-audit",
  "cargo-audit",
  "govulncheck",
] as const;
export const AUDIT_SEVERITIES = ["low", "moderate", "high", "critical"] as const;

/** A calendar date (YYYY-MM-DD) that actually exists. */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a date as YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "not a valid calendar date");

/**
 * One allowlisted advisory. `id` is any identifier the audit tool reports
 * (GHSA-…, CVE-…, PYSEC-…, RUSTSEC-…, GO-…, or an npm advisory number). Both
 * `reason` and `until` are mandatory so an exception is always justified and
 * always comes back up for review.
 */
export const AuditIgnoreSchema = z
  .object({
    id: z
      .string({ required_error: "id is required" })
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "expected an advisory ID like GHSA-xxxx-xxxx-xxxx"),
    reason: z
      .string({ required_error: "reason is required (why is this advisory acceptable?)" })
      .trim()
      .min(1, "reason is required (why is this advisory acceptable?)"),
    until: IsoDateSchema.describe("Last day the exception applies; verify fails after it."),
  })
  .strict();

export const SecurityGatesSchema = z.object({
  depsAudit: z
    .object({
      enabled: z.boolean().default(true),
      tool: z.enum(AUDIT_TOOLS).default("auto"),
      failOn: z.enum(AUDIT_SEVERITIES).default("high"),
      ignore: z.array(AuditIgnoreSchema).default([]),
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

/**
 * How `verify --hook Stop` avoids trapping a session in a loop it cannot fix:
 * - baselinePreexisting: dependency findings already present when the session
 *   started (same advisories, same lockfile) warn instead of blocking.
 * - maxRepeatBlocks: after this many identical consecutive blocks with no file
 *   changes in between, stop blocking (0 disables the guard).
 */
export const StopPolicySchema = z
  .object({
    baselinePreexisting: z.boolean().default(true),
    maxRepeatBlocks: z.number().int().min(0).default(3),
  })
  .strict()
  .default({});

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
        required: z
          .array(z.enum(CHECK_IDS))
          .default(["lint", "unit", "security", "design", "feature-list"]),
        perHook: z.record(z.enum(HOOK_NAMES), z.array(z.enum(CHECK_IDS))).default({}),
        stop: StopPolicySchema,
      })
      .default({}),
    security: SecurityGatesSchema.default({}),
    design: DesignGatesSchema.default({}),
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
        "design-reviewer": AgentPolicySchema,
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
export type AuditTool = (typeof AUDIT_TOOLS)[number];
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];
export type AuditIgnore = z.infer<typeof AuditIgnoreSchema>;
export type StopPolicy = z.infer<typeof StopPolicySchema>;
