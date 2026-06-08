import type { CheckId, ReinsConfig } from "../config/schema";

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  summary: string;
  durationMs: number;
  details?: string;
}

export interface CheckContext {
  cwd: string;
  config: ReinsConfig;
  /** Limit work to changed/staged files where a check supports it. */
  changed: boolean;
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
}
