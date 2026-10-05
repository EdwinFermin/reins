import type { CheckId, ReinsConfig } from "../config/schema";

/** `warn` = a failure the Stop policy downgraded (reported, never blocking). */
export type CheckStatus = "pass" | "fail" | "skip" | "warn";

/** What the dependency audit found, in the shape the Stop baseline compares. */
export interface DepsAuditMeta {
  tool: string;
  /** Hash of the project's lockfiles at audit time (null when there are none). */
  lockfileHash: string | null;
  /** Keys (GHSA or primary ID) of the non-allowlisted advisories that block. */
  blockingAdvisories: string[];
  /** IDs of allowlist entries past their `until` date. */
  expired: string[];
}

export interface SecurityMeta {
  deps: DepsAuditMeta | null;
  depsFailed: boolean;
  secretsFailed: boolean;
}

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  summary: string;
  durationMs: number;
  details?: string;
  /** Structured audit data, set by the security check. */
  security?: SecurityMeta;
}

export interface CheckContext {
  cwd: string;
  config: ReinsConfig;
  /** Limit work to changed/staged files where a check supports it. */
  changed: boolean;
  /** Clock override (tests); allowlist expiry is evaluated against it. */
  now?: Date;
}

export type Check = (ctx: CheckContext) => Promise<CheckResult>;

export function makeResult(
  id: CheckId,
  status: CheckStatus,
  summary: string,
  durationMs = 0,
  details?: string,
): CheckResult {
  return { id, status, summary, durationMs, details };
}

export const pass = (id: CheckId, summary: string, durationMs = 0, details?: string): CheckResult =>
  makeResult(id, "pass", summary, durationMs, details);
export const fail = (id: CheckId, summary: string, durationMs = 0, details?: string): CheckResult =>
  makeResult(id, "fail", summary, durationMs, details);
export const skip = (id: CheckId, summary: string, durationMs = 0): CheckResult =>
  makeResult(id, "skip", summary, durationMs);

/** A sub-result used by composite checks (e.g. security = deps + secrets). */
export interface SubResult {
  status: CheckStatus;
  summary: string;
  durationMs: number;
  details?: string;
  deps?: DepsAuditMeta;
}
