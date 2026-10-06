import { CHECK_IDS, type CheckId, type ReinsConfig } from "../config/schema";
import { e2eCheck, integrationCheck, lintCheck, unitCheck } from "./command-checks";
import { designCheck } from "./design";
import { securityCheck } from "./security";
import { ResultCache } from "./result-cache";
import { featureListCheck, traceabilityCheck } from "./state-checks";
import {
  applyBaseline,
  beginSession,
  failureFingerprint,
  recordBaseline,
  registerStopBlock,
  saveSessionState,
  SESSION_HOOKS,
  sessionTrackingEnabled,
  workspaceFingerprint,
} from "./stop-guard";
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
  /** Explicit changed files (e.g. from the PostToolUse payload); implies nothing without `changed`. */
  changedFiles?: string[];
  /** Skip the pass-result cache (`--no-cache`). */
  noCache?: boolean;
  /** The agent session this hook fired in (Claude Code passes it on stdin). */
  sessionId?: string | null;
  /** Clock override for tests. */
  now?: Date;
}

export interface VerifyReport {
  profile: CheckId[];
  results: CheckResult[];
  requiredFailed: CheckResult[];
  ok: boolean;
  /** Non-blocking explanations from the Stop policy (baseline, repeat guard). */
  notices: string[];
  /** Stop would block, but the repeat guard gave up after N identical blocks. */
  gaveUp: boolean;
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
  // CI always runs for real: a fresh checkout has no cache, and a cached pass
  // must never stand in for the gate of record.
  const useCache = opts.config.verify.cache && !opts.noCache && opts.hook !== "CI";
  const ctx: CheckContext = {
    cwd: opts.cwd,
    config: opts.config,
    changed: Boolean(opts.changed),
    now: opts.now,
    hook: opts.hook,
    changedFiles: opts.changedFiles,
    cache: useCache ? new ResultCache(opts.cwd, opts.config) : undefined,
  };

  const tracked =
    Boolean(opts.hook && SESSION_HOOKS.has(opts.hook)) && sessionTrackingEnabled(opts.config);
  const state = tracked
    ? await beginSession(opts.cwd, {
        sessionId: opts.sessionId ?? null,
        fromSessionStart: false,
        now: opts.now,
      })
    : null;

  const results: CheckResult[] = [];
  for (const id of profile) {
    results.push(await REGISTRY[id](ctx));
  }

  const required = new Set(opts.config.verify.required);
  const failedRequired = () => results.filter((r) => r.status === "fail" && required.has(r.id));
  const notices: string[] = [];
  let gaveUp = false;

  if (state) {
    recordBaseline(state, results, opts.now);
    const stop = opts.config.verify.stop;
    if (opts.hook === "Stop") {
      if (stop.baselinePreexisting) notices.push(...applyBaseline(state, results));
      const failed = failedRequired();
      if (failed.length === 0) {
        state.stopBlocks = null;
      } else if (stop.maxRepeatBlocks > 0) {
        const guard = registerStopBlock(
          state,
          failureFingerprint(failed),
          await workspaceFingerprint(opts.cwd, opts.config),
          stop.maxRepeatBlocks,
        );
        if (guard.gaveUp) {
          gaveUp = true;
          notices.push(
            `repeated identical Stop block (${guard.count}x with no file changes), giving up; ` +
              "run `reins verify` manually — this needs a human decision.",
          );
        }
      }
    }
    await saveSessionState(opts.cwd, state);
  }

  const requiredFailed = failedRequired();
  return {
    profile,
    results,
    requiredFailed,
    ok: requiredFailed.length === 0,
    notices,
    gaveUp,
  };
}

/** Claude Code hooks block with exit 2; everything else uses 0/1. */
const BLOCKING_HOOKS = new Set(["PostToolUse", "Stop", "SubagentStop"]);

export function computeExitCode(report: VerifyReport, hook?: string): number {
  if (report.ok) return 0;
  // The repeat guard released the Stop hook: report the failure, don't block.
  if (report.gaveUp && hook === "Stop") return 0;
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
