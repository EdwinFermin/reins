import { CHECK_IDS, type CheckId, type ReinsConfig } from "../config/schema";
import { e2eCheck, integrationCheck, lintCheck, unitCheck } from "./command-checks";
import { designCheck } from "./design";
import { securityCheck } from "./security";
import { featureListCheck, traceabilityCheck } from "./state-checks";
import type { Check, CheckContext, CheckResult } from "./types";

const REGISTRY: Record<CheckId, Check> = {
  lint: lintCheck,
  unit: unitCheck,
  integration: integrationCheck,
  e2e: e2eCheck,
  security: securityCheck,
  design: designCheck,
  "feature-list": featureListCheck,
  traceability: traceabilityCheck,
};

export interface RunVerifyOptions {
  cwd: string;
  config: ReinsConfig;
  only?: CheckId[];
  hook?: string;
  changed?: boolean;
}

export interface VerifyReport {
  profile: CheckId[];
  results: CheckResult[];
  requiredFailed: CheckResult[];
  ok: boolean;
}

/** Decide which checks to run: --only > per-hook profile > required. */
export function resolveProfile(opts: RunVerifyOptions): CheckId[] {
  if (opts.only && opts.only.length > 0) return opts.only;
  if (opts.hook) {
    const perHook = opts.config.verify.perHook as Partial<Record<string, CheckId[]>>;
    const fromHook = perHook[opts.hook];
    if (fromHook && fromHook.length > 0) return fromHook;
  }
  return opts.config.verify.required;
}

export async function runVerify(opts: RunVerifyOptions): Promise<VerifyReport> {
  const profile = resolveProfile(opts);
  const ctx: CheckContext = { cwd: opts.cwd, config: opts.config, changed: Boolean(opts.changed) };

  const results: CheckResult[] = [];
  for (const id of profile) {
    results.push(await REGISTRY[id](ctx));
  }

  const required = new Set(opts.config.verify.required);
  const requiredFailed = results.filter((r) => r.status === "fail" && required.has(r.id));
  return { profile, results, requiredFailed, ok: requiredFailed.length === 0 };
}

/** Claude Code hooks block with exit 2; everything else uses 0/1. */
const BLOCKING_HOOKS = new Set(["PostToolUse", "Stop", "SubagentStop"]);

export function computeExitCode(report: VerifyReport, hook?: string): number {
  if (report.ok) return 0;
  return hook && BLOCKING_HOOKS.has(hook) ? 2 : 1;
}

export function parseCheckIds(value: string): { ids: CheckId[]; invalid: string[] } {
  const ids: CheckId[] = [];
  const invalid: string[] = [];
  for (const raw of value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if ((CHECK_IDS as readonly string[]).includes(raw)) ids.push(raw as CheckId);
    else invalid.push(raw);
  }
  return { ids, invalid };
}
